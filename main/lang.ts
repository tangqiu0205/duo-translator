// Page decisions use the same conservative, local-only evidence as paragraph
// exclusions. getTextLanguage remains a best-effort guess for non-filtering UI.
// Prefer visible source text, retain paragraph boundaries, and bound both
// sampling and browser detection. Uncertain evidence keeps translation enabled.
import { franc } from "franc";
import { isTraditionalChinese } from "@/utils/language";
import { iso6393To1Map } from "@/main/constants";
import { shuffle } from "@/utils/arrays";
import { detectLocalTextLanguage } from "@/main/localLanguageDetection";
import { allParagraphs } from "@/main/dom/paragraphMarks";
import { utf8Length } from "@/utils/text";
import { isVisibleForDetect } from "@/main/dom/visibility";
import type { UnitContainer } from "@/main/dom/segments";
import { isShadowRoot } from "@/main/dom/shadowTraversal";
import { isInOwnUi } from "@/main/dom/shadowRoots";
import { isExcludedNodeType } from "@/main/dom/predicates";

/** Stop growing a sample once it carries this many UTF-8 bytes. */
const SAMPLE_BUDGET_BYTES = 2000;
/**
 * Give up looking for visible text after this many text-bearing elements. Only
 * reached by a page whose sampled paragraphs are hidden all the way down; the
 * shuffle makes that a representative verdict long before the limit.
 */
const HIDDEN_SCAN_LIMIT = 200;

/** A UTF-8-bounded sample. Never cut a surrogate pair or retain a huge node. */
class SampleBucket {
    samples: string[] = [];
    private length = 0;
    private filled = false;

    add(text: string, len: number) {
        if (this.filled) return;
        const remaining = SAMPLE_BUDGET_BYTES - this.length;
        if (len >= remaining) {
            let prefix = "", bytes = 0;
            for (const character of text) {
                const size = utf8Length(character);
                if (bytes + size > remaining) break;
                prefix += character; bytes += size;
            }
            text = prefix; len = bytes;
            this.filled = true;
        }
        if (len > 0) this.samples.push(text);
        this.length += len;
    }

    get full(): boolean { return this.filled; }
}

/**
 * Detect the language of a text snippet locally via franc, returning an
 * ISO-639-1 code (or "und" when unknown). Mandarin ("cmn") is further resolved
 * to zh-TW / zh-CN by script.
 */
export function getTextLanguage(text: string): string {
    let lang = franc(text, { minLength: 5 });
    if (lang == "cmn") {
        lang = isTraditionalChinese(text) ? "zh-TW" : "zh-CN";
    } else {
        lang = iso6393To1Map.get(lang) || "und";
    }
    return lang;
}

/**
 * Concatenate source text while preserving inline word spacing and skipping
 * excluded tags (script/style/svg/…) and rendered formulas.
 */
export function getElementTextContent(element: UnitContainer): string {
    let text = "";
    function traverse(node: Node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || "";
        } else if (node.nodeType === Node.ELEMENT_NODE || isShadowRoot(node)) {
            if (isExcludedNodeType(node)) {
                return;
            }
            // Our own UI lives in shadow roots and is written in the *interface*
            // language, so sampling it would actively corrupt the page-language
            // vote. Nothing else stops it: our hosts are plain <div>s.
            if (isInOwnUi(node)) {
                return;
            }
            for (const child of node.childNodes) {
                traverse(child);
            }
        }
    }
    traverse(element);
    return text.trim();
}

/**
 * Detect the language of a set of paragraph elements.
 */
export async function detectLanguage(elements?: UnitContainer[], signal?: AbortSignal): Promise<string> {
    const pool: UnitContainer[] = elements === undefined ? allParagraphs() : elements;

    // Randomly sample elements
    const candidates = shuffle(pool);

    // Text the reader can actually see votes; text that is hidden (SEO blocks
    // parked offscreen, .sr-only copies, collapsed panels) only goes into a
    // fail-open pool that is used when NOTHING visible could be sampled — see
    // main/dom/visibility.ts. Those elements stay marked and translatable; this
    // is a detection-only filter.
    const visible = new SampleBucket()
    const hidden = new SampleBucket()
    let probed = 0
    for (let index = 0; index < candidates.length; index++) {
        const element = candidates[index];
        let content = getElementTextContent(element);
        let len = utf8Length(content)
        if (len === 0) continue
        // The visibility probe reads layout, so it sits behind the text check:
        // only elements that can actually enter the sample pay for it.
        const bucket = isVisibleForDetect(element) ? visible : hidden
        bucket.add(content, len)
        probed++
        if (visible.full) break
        // Bound the scan on a page that is hidden all the way down. It counts
        // probes, NOT bytes: one oversized hidden block landing first in the
        // shuffle must never end the search for visible text.
        if (visible.samples.length === 0 && probed >= HIDDEN_SCAN_LIMIT) break
    }
    // Fail open on the whole page: a frame that was never laid out reports every
    // element as boxless, and returning "und" there would be worse than voting
    // with hidden text.
    const sample = visible.samples.length > 0 ? visible : hidden

    // Preserve paragraph boundaries: a small foreign/unknown block must not
    // disappear behind a majority-language vote. No network fallback.
    // A bounded prefix is not evidence about the whole document: foreign
    // paragraphs may exist beyond it. Let per-unit preflight handle that page.
    if (signal?.aborted) return "und";
    const report = (language: string) => {
        console.debug("detect language by local: %s", language);
        return language;
    };
    if (sample.full || sample.samples.length === 0) return report("und");
    try {
        return report(await detectLocalTextLanguage(sample.samples.join("\n"), signal));
    } catch (error) {
        if (signal?.aborted) return "und";
        throw error;
    }
}
