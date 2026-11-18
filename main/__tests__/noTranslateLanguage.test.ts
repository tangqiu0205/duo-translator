// Unit tests for the "do not translate these languages" logic:
//   - main/noTranslateLanguage.ts       (tag comparison, shared by all three consumers)
//   - main/noTranslateLanguageFilter.ts (the local request-time precheck)
//   - main/strategy.ts                  (the page-level AUTO decision)
// All DOM-free, so they run in the default node environment.
import { describe, it, expect, vi, beforeEach } from "vitest";
const { localDetect } = vi.hoisted(() => ({ localDetect: vi.fn() }));
vi.mock("@/main/localLanguageDetection", () => ({ shouldSkipLocalText: localDetect }));
import { buildNoTranslateLanguageSet, isNoTranslateLanguage } from "@/main/noTranslateLanguage";
import { partitionByLocalLanguage } from "@/main/noTranslateLanguageFilter";
import { needsTranslate } from "@/main/strategy";
import { DEFAULT_STRATEGY, DOMAIN_STRATEGY } from "@/main/constants";
beforeEach(() => { localDetect.mockReset(); });

// ---------------------------------------------------------------------------
// buildNoTranslateLanguageSet / isNoTranslateLanguage
// ---------------------------------------------------------------------------
describe("buildNoTranslateLanguageSet", () => {
    it("returns an empty set for anything that is not a list of strings", () => {
        expect(buildNoTranslateLanguageSet(undefined).size).toBe(0);
        expect(buildNoTranslateLanguageSet(null).size).toBe(0);
        expect(buildNoTranslateLanguageSet("en").size).toBe(0);
        expect(buildNoTranslateLanguageSet([1, {}, null]).size).toBe(0);
    });

    it("normalizes the configured tags", () => {
        const set = buildNoTranslateLanguageSet(["en", "pt", "zh-TW"]);
        expect([...set].sort()).toEqual(["en", "pt", "zh-TW"]);
    });
});

describe("isNoTranslateLanguage", () => {
    const set = buildNoTranslateLanguageSet(["en", "zh-CN"]);

    it("compares NORMALIZED tags, so provider dialects still match", () => {
        expect(isNoTranslateLanguage("en-US", set)).toBe(true);
        expect(isNoTranslateLanguage("zh-Hans", set)).toBe(true);
        // franc's ISO-639-3 Mandarin, which lang.ts already resolves by script.
        expect(isNoTranslateLanguage("cmn", set)).toBe(true);
    });

    it("does not match a different variant of the same base language", () => {
        expect(isNoTranslateLanguage("zh-TW", set)).toBe(false);
    });

    it("treats an unknown language as translatable — never as a match", () => {
        expect(isNoTranslateLanguage("", set)).toBe(false);
        expect(isNoTranslateLanguage(undefined, set)).toBe(false);
        expect(isNoTranslateLanguage(null, set)).toBe(false);
        expect(isNoTranslateLanguage("und", new Set(["und"]))).toBe(false);
        expect(isNoTranslateLanguage("auto", new Set(["auto"]))).toBe(false);
        expect(buildNoTranslateLanguageSet(["und", "auto"]).size).toBe(0);
    });

    it("is off entirely when nothing is configured", () => {
        expect(isNoTranslateLanguage("en", new Set())).toBe(false);
    });
});

describe("request-time local language filtering", () => {
    const id = (text: string) => text;
    it("excludes only confidently identified configured languages", async () => {
        localDetect.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        expect(await partitionByLocalLanguage(["English", "Deutsch", "ambiguous"], id, new Set(["en"])))
            .toEqual({ excluded: ["English"], keep: ["Deutsch", "ambiguous"] });
    });
    it("does not inspect text when the exclusion set is empty", async () => {
        expect(await partitionByLocalLanguage(["hello"], id, new Set())).toEqual({ excluded: [], keep: ["hello"] });
        expect(localDetect).not.toHaveBeenCalled();
    });
    it("uses the current configured list instead of caching exclusion verdicts", async () => {
        localDetect.mockImplementation(async (_text, languages: Set<string>) => languages.has('en'));
        expect((await partitionByLocalLanguage(["hello"], id, new Set(["en"]))).excluded).toEqual(["hello"]);
        expect((await partitionByLocalLanguage(["hello"], id, new Set(["de"]))).keep).toEqual(["hello"]);
    });
    it("keeps a source edited while asynchronous local detection is running", async () => {
        const item = { text: "original" };
        localDetect.mockImplementation(async () => { item.text = "edited"; return true; });
        expect((await partitionByLocalLanguage([item], value => value.text, new Set(["en"]))).keep).toEqual([item]);
    });
    it("forwards cancellation without turning it into an exclusion", async () => {
        const controller = new AbortController();
        localDetect.mockRejectedValue(new DOMException("Aborted", "AbortError"));
        await expect(partitionByLocalLanguage(["hello"], id, new Set(["en"]), controller.signal))
            .rejects.toMatchObject({ name: "AbortError" });
        expect(localDetect).toHaveBeenCalledWith("hello", new Set(["en"]), controller.signal);
    });
});

// ---------------------------------------------------------------------------
// Page-level decision
// ---------------------------------------------------------------------------
describe("needsTranslate + noTranslateLanguages", () => {
    const base = {
        globalSwitch: true,
        domainStrategy: DOMAIN_STRATEGY.AUTO,
        defaultStrategy: DEFAULT_STRATEGY.AUTO,
        targetLang: "zh-CN",
        pageLang: "en",
        noTranslateLanguages: buildNoTranslateLanguageSet(["en"]),
    };

    it("does not auto-translate a page in a no-translate language", () => {
        expect(needsTranslate(base)).toBe(false);
    });

    it("still auto-translates a page in any other language", () => {
        expect(needsTranslate({ ...base, pageLang: "de" })).toBe(true);
    });

    it("is bypassed by an ALWAYS strategy — naming the site outranks the global list", () => {
        expect(needsTranslate({ ...base, domainStrategy: DOMAIN_STRATEGY.ALWAYS })).toBe(true);
        expect(needsTranslate({ ...base, defaultStrategy: DEFAULT_STRATEGY.ALWAYS })).toBe(true);
    });

    it("behaves exactly as before when nothing is configured", () => {
        expect(needsTranslate({ ...base, noTranslateLanguages: undefined })).toBe(true);
        expect(needsTranslate({ ...base, noTranslateLanguages: new Set() })).toBe(true);
    });
});
