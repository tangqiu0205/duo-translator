// Frozen pre-optimization A reference, ONLY for offline A/C evaluation.
// Do not import this module into production code.
// Local-only language evidence shared by page decisions and paragraph filters.
// Native i18n detection runs on the browser, not a translation provider. The
// statistical fallback intentionally prefers false negatives over lost text.
import { browser } from 'wxt/browser';
import { francAll } from 'franc';
import { iso6393To1Map, normalizeLanguageTag } from '@/main/constants';
import { toSimplified, toTraditional } from '@/utils/language';
import { PageTranslationQueue } from '@/main/pageTranslationQueue';

const UNKNOWN = 'und';
const MAX_TEXT_LENGTH = 4096;
const MAX_SEGMENTS = 12;
const CACHE_LIMIT = 512;
const cache = new Map<string, string>();
const detectorQueue = new PageTranslationQueue(2);
let warnedNativeFailure = false;
interface NativeResult { isReliable: boolean; languages: Array<{ language: string; percentage: number }> }

export function resetLocalLanguageCache(): void { cache.clear(); }

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function nativeDetection(text: string, deadline: number, signal?: AbortSignal): Promise<NativeResult | undefined> {
    const detect = browser.i18n?.detectLanguage;
    if (typeof detect !== 'function') return Promise.resolve(undefined);
    return detectorQueue.run(() => {
        if (Date.now() >= deadline) return Promise.resolve(undefined);
        return new Promise<NativeResult | undefined>((resolve, reject) => {
            let settled = false;
            const finish = (result?: NativeResult, error?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(result);
            };
            const abort = () => finish(undefined, new DOMException('Aborted', 'AbortError'));
            const timer = setTimeout(() => finish(), Math.max(1, Math.min(1500, deadline - Date.now())));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            Promise.resolve().then(() => settled || signal?.aborted ? undefined : browser.i18n.detectLanguage(text)).then(result => finish(result), error => {
                if (!warnedNativeFailure && !signal?.aborted) {
                    warnedNativeFailure = true;
                    console.warn('Fluento: local browser language detection unavailable; using conservative statistical fallback', error);
                }
                finish();
            });
        });
    }, () => 0, signal);
}

/** Reject mixed scripts before a dominant-language guess can hide foreign text. */
function scriptEvidence(text: string): { language?: string; ambiguous: boolean } {
    const scripts = new Set<string>();
    let han = 0, kana = 0, hangul = 0;
    for (const character of text) {
        if (!/\p{L}/u.test(character)) continue;
        if (/\p{Script=Han}/u.test(character)) { scripts.add('Han'); han++; }
        else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) { scripts.add('Kana'); kana++; }
        else if (/\p{Script=Hangul}/u.test(character)) { scripts.add('Hangul'); hangul++; }
        else if (/\p{Script=Latin}/u.test(character)) scripts.add('Latin');
        else if (/\p{Script=Cyrillic}/u.test(character)) scripts.add('Cyrillic');
        else if (/\p{Script=Arabic}/u.test(character)) scripts.add('Arabic');
        else if (/\p{Script=Devanagari}/u.test(character)) scripts.add('Devanagari');
        else if (/\p{Script=Greek}/u.test(character)) scripts.add('Greek');
        else if (/\p{Script=Hebrew}/u.test(character)) scripts.add('Hebrew');
        else if (/\p{Script=Thai}/u.test(character)) scripts.add('Thai');
        else scripts.add('Other');
    }
    if (kana) return { language: kana >= 4 && han + kana >= 12 && [...scripts].every(script => script === 'Han' || script === 'Kana') ? 'ja' : undefined, ambiguous: true };
    if (hangul) return { language: hangul >= 12 && scripts.size === 1 ? 'ko' : undefined, ambiguous: true };
    if (han) {
        if (scripts.size !== 1 || han < 12) return { ambiguous: true };
        const traditional = toSimplified(text) !== text;
        const simplified = toTraditional(text) !== text;
        // Shared Han characters are not proof of Chinese rather than Japanese;
        // mixed simplified/traditional spelling is uncertain as well.
        return { language: traditional !== simplified ? traditional ? 'zh-TW' : 'zh-CN' : undefined, ambiguous: true };
    }
    return { ambiguous: scripts.size !== 1 || scripts.has('Other') };
}

async function identifySegment(text: string, paragraph: boolean, deadline: number, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (Date.now() >= deadline) return UNKNOWN;
    const scripts = scriptEvidence(text);
    if (scripts.language) return scripts.language;
    if (scripts.ambiguous) return UNKNOWN;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const words = text.match(/\p{L}[\p{L}\p{M}'’-]*/gu)?.length ?? 0;
    const wordSeparated = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Hebrew}]/u.test(text);
    if (letters < (paragraph ? 80 : 32) || wordSeparated && words < (paragraph ? 12 : 6)) return UNKNOWN;
    const native = await nativeDetection(text, deadline, signal);
    checkAbort(signal);
    if (Date.now() >= deadline) return UNKNOWN;
    if (native) {
        const ranked = [...native.languages].sort((a, b) => b.percentage - a.percentage);
        const first = ranked[0];
        const language = normalizeLanguageTag(first?.language ?? '');
        return native.isReliable && first && first.percentage >= 85
            && first.percentage - (ranked[1]?.percentage ?? 0) >= 60
            && language && language !== UNKNOWN && language !== 'auto' ? language : UNKNOWN;
    }
    // franc only inspects its first 2048 code units. Never accept a guess that
    // could conceal a different-language tail outside that library budget.
    if (text.length > 2048) return UNKNOWN;
    const ranked = francAll(text, { minLength: 10 });
    const first = ranked[0];
    // Scores are relative distances, NOT probabilities. A narrow lead or an
    // unsupported language is deliberately insufficient evidence for exclusion.
    return first && first[0] !== UNKNOWN && first[1] - (ranked[1]?.[1] ?? 0) >= 0.1
        ? iso6393To1Map.get(first[0]) || UNKNOWN : UNKNOWN;
}

export async function detectLocalTextLanguage(value: string, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (value.length > MAX_TEXT_LENGTH * 4) return UNKNOWN;
    const text = value.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/[^\S\n]+/gu, ' ').trim();
    if (!text || text.length > MAX_TEXT_LENGTH) return UNKNOWN;
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const deadline = Date.now() + 1500;
    const segments = text.split(/[\n.!?。！？;；“”"「」『』]+/u).map(part => part.trim()).filter(part => /\p{L}/u.test(part));
    let language = segments.length > MAX_SEGMENTS ? UNKNOWN : await identifySegment(text, true, deadline, signal);
    if (language !== UNKNOWN && segments.length > 1) {
        for (const segment of segments) {
            if (await identifySegment(segment, false, deadline, signal) !== language) { language = UNKNOWN; break; }
        }
    }
    checkAbort(signal);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(text, language);
    return language;
}
