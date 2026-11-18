import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: { i18n: {} } }));
import { shouldSkipLocalText, resetLocalLanguageCache } from '@/main/localLanguageDetection';
import * as baseline from './fixtures/localLanguageDetectionA';
import { languageFilterCorpus } from './fixtures/languageFilterCorpus';
import { isNoTranslateLanguage } from '@/main/noTranslateLanguage';

describe('offline A/C evaluation with real franc statistics', () => {
    it('introduces no new false skips on the hand-labelled synthetic corpus', async () => {
        const regressions: string[] = [];
        for (const item of languageFilterCorpus) {
            resetLocalLanguageCache(); baseline.resetLocalLanguageCache();
            const languages = new Set(item.languages);
            const oldSkip = isNoTranslateLanguage(await baseline.detectLocalTextLanguage(item.text), languages);
            const newSkip = await shouldSkipLocalText(item.text, languages);
            if (item.mustTranslate && newSkip && !oldSkip) regressions.push(item.id);
            // Settings are never part of a cached final filtering decision.
            expect(await shouldSkipLocalText(item.text, new Set())).toBe(false);
        }
        expect(regressions).toEqual([]);
    });
});
