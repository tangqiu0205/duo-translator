import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
    const native = vi.fn(), statistics = vi.fn();
    return { native, statistics, i18n: { detectLanguage: native as typeof native | undefined } };
});
vi.mock('wxt/browser', () => ({ browser: { i18n: mocks.i18n } }));
vi.mock('franc', () => ({ francAll: mocks.statistics }));
import { detectLocalTextLanguage, shouldSkipLocalText, resetLocalLanguageCache } from '@/main/localLanguageDetection';

const english = 'This paragraph explains how the translation extension examines source text before making a request and preserves uncertain material so that foreign content remains available for translation';
const french = 'Cette phrase décrit comment le programme analyse les textes avant de demander une traduction et conserve les passages incertains pour éviter de masquer du contenu étranger';
const result = (language: string, percentage = 99, isReliable = true) => ({ isReliable, languages: [{ language, percentage }] });
beforeEach(() => {
    resetLocalLanguageCache(); mocks.native.mockReset().mockResolvedValue(result('en'));
    mocks.statistics.mockReset().mockReturnValue([['und', 1]]); mocks.i18n.detectLanguage = mocks.native;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('conservative, local-only language evidence', () => {
    it('uses reliable browser detection without a provider or statistical guess', async () => {
        expect(await detectLocalTextLanguage(english)).toBe('en');
        expect(mocks.native).toHaveBeenCalledWith(english);
        expect(mocks.statistics).not.toHaveBeenCalled();
    });
    it.each(['hello', 'table', 'Gift', 'API', '東京', '中文', 'Привет', '123456789'])('keeps short/ambiguous text %s unknown', async text => {
        expect(await detectLocalTextLanguage(text)).toBe('und');
        expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.statistics).not.toHaveBeenCalled();
    });
    it('does not let a dominant script swallow foreign text', async () => {
        expect(await detectLocalTextLanguage('这是一段用于测试翻译功能的中文正文并包含外语 ' + english)).toBe('und');
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it.each([
        ['这是一个用于测试网页翻译功能的中文段落其中包含明确的简体字形证据', 'zh-CN'],
        ['這是一段用於測試網頁翻譯功能的繁體中文內容並且包含清楚的字形證據', 'zh-TW'],
        ['これは日本語の文章であり翻訳機能の動作を確認するための説明です', 'ja'],
        ['이 문장은 번역 확장 프로그램이 어떻게 작동하는지 설명합니다', 'ko'],
    ])('accepts strong script evidence in %s', async (text, language) => {
        expect(await detectLocalTextLanguage(text)).toBe(language); expect(mocks.native).not.toHaveBeenCalled();
    });
    it('does not treat shared Han or mixed Chinese variants as certain evidence', async () => {
        expect(await detectLocalTextLanguage('一二三四五六七八九十百千')).toBe('und');
        expect(await detectLocalTextLanguage('这是一个测试網頁翻譯與语言识别功能的段落')).toBe('und');
    });
    it.each([result('en', 99, false), result('en', 75), result('und'),
        { isReliable: true, languages: [{ language: 'en', percentage: 60 }, { language: 'fr', percentage: 40 }] },
    ])('does not turn unreliable browser results into exclusions', async native => {
        mocks.native.mockResolvedValue(native);
        expect(await detectLocalTextLanguage(english)).toBe('und');
        expect(mocks.statistics).not.toHaveBeenCalled();
    });
    it('does not review foreign sentences when the whole language cannot skip', async () => {
        expect(await shouldSkipLocalText(english + '. ' + french, new Set(['zh-CN']))).toBe(false);
        expect(mocks.native).toHaveBeenCalledTimes(1);
    });
    it('rechecks cached initial evidence against changed exclusions rather than caching a skip verdict', async () => {
        const text = english + '. Bonjour';
        expect(await shouldSkipLocalText(text, new Set(['zh-CN']))).toBe(false);
        expect(mocks.native).toHaveBeenCalledTimes(1);
        expect(await shouldSkipLocalText(text, new Set(['en']))).toBe(false);
        // The newly eligible candidate now gets fragment review, which rejects
        // the short tail instead of accepting the cached whole-language guess.
        expect(mocks.native).toHaveBeenCalledTimes(2);
    });
    it('does not inspect a paragraph when no language can skip', async () => {
        expect(await shouldSkipLocalText(english, new Set())).toBe(false);
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it('checks each sentence rather than trusting a dominant Latin language', async () => {
        mocks.native.mockImplementation(async (text: string) => result(text === french ? 'fr' : 'en'));
        expect(await detectLocalTextLanguage(english + '. ' + french)).toBe('und');
        expect(mocks.native).toHaveBeenCalledWith(french);
    });
    it('keeps a short foreign tail translatable even when the full text looks like English', async () => {
        expect(await detectLocalTextLanguage(english + '. Bonjour le monde')).toBe('und');
    });
    it('keeps quoted ambiguous foreign fragments translatable', async () => {
        expect(await detectLocalTextLanguage(english + ' 「Bonjour」')).toBe('und');
    });
    it('memoizes language evidence independently of exclusion settings', async () => {
        expect(await detectLocalTextLanguage(english)).toBe('en');
        expect(await detectLocalTextLanguage(english)).toBe('en');
        expect(mocks.native).toHaveBeenCalledTimes(1);
    });
    it('falls back to local statistics only when browser capability is missing', async () => {
        mocks.i18n.detectLanguage = undefined;
        mocks.statistics.mockReturnValue([['deu', 1], ['nld', 0.7]]);
        expect(await detectLocalTextLanguage(english)).toBe('de');
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it('treats close statistical rankings as unknown and caches that uncertainty', async () => {
        mocks.i18n.detectLanguage = undefined;
        mocks.statistics.mockReturnValue([['eng', 1], ['sco', 0.98]]);
        expect(await detectLocalTextLanguage(english)).toBe('und');
        expect(await detectLocalTextLanguage(english)).toBe('und');
        expect(mocks.statistics).toHaveBeenCalledTimes(1);
    });
    it('does not use a truncated statistical prefix to classify a long tail', async () => {
        mocks.i18n.detectLanguage = undefined;
        expect(await detectLocalTextLanguage((english + ' ').repeat(15))).toBe('und');
        expect(mocks.statistics).not.toHaveBeenCalled();
    });
    it('bounds work on oversized text and sentence-heavy paragraphs', async () => {
        expect(await detectLocalTextLanguage(english.repeat(100))).toBe('und');
        expect(mocks.native).not.toHaveBeenCalled();
        expect(await detectLocalTextLanguage('A sentence with ordinary English words. '.repeat(15))).toBe('und');
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it('does not start a browser operation after cancellation', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(detectLocalTextLanguage(english, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it('releases native detection and its timer on mid-flight cancellation', async () => {
        mocks.native.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const pending = detectLocalTextLanguage(english, controller.signal);
        const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledTimes(1));
        controller.abort(); await assertion;
        mocks.native.mockResolvedValue(result('en'));
        expect(await detectLocalTextLanguage(english)).toBe('en');
        expect(mocks.native).toHaveBeenCalledTimes(2);
    });
    it('bounds the whole paragraph wait and keeps it translatable on timeout', async () => {
        vi.useFakeTimers(); mocks.native.mockImplementation(() => new Promise(() => {}));
        mocks.statistics.mockReturnValue([['deu', 1], ['nld', 0.7]]);
        const pending = detectLocalTextLanguage(english);
        await vi.advanceTimersByTimeAsync(1500);
        expect(await pending).toBe('und');
        expect(mocks.statistics).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('limits native calls to two and removes cancelled queued work', async () => {
        const releases: Array<(value: ReturnType<typeof result>) => void> = [];
        mocks.native.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
        const first = detectLocalTextLanguage(english + ' first');
        const second = detectLocalTextLanguage(english + ' second');
        const controller = new AbortController();
        const third = detectLocalTextLanguage(english + ' third', controller.signal);
        const cancelled = expect(third).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledTimes(2));
        controller.abort(); await cancelled;
        for (const release of releases) release(result('en'));
        await expect(Promise.all([first, second])).resolves.toEqual(['en', 'en']);
        expect(mocks.native).toHaveBeenCalledTimes(2);
    });
    it('reuses identical fragment evidence within a candidate', async () => {
        expect(await shouldSkipLocalText([english, english, english].join('. '), new Set(['en']))).toBe(true);
        expect(mocks.native).toHaveBeenCalledTimes(2); // Whole + one unique fragment.
    });
    it('reuses stronger paragraph evidence for a later fragment', async () => {
        expect(await shouldSkipLocalText(english, new Set(['en']))).toBe(true);
        expect(await shouldSkipLocalText(english + '. ' + english, new Set(['en']))).toBe(true);
        expect(mocks.native).toHaveBeenCalledTimes(2);
    });
    it('accepts different languages only when every meaningful fragment can skip', async () => {
        mocks.native.mockImplementation(async (text: string) => result(text === french ? 'fr' : 'en'));
        const text = english + '. ' + french;
        expect(await shouldSkipLocalText(text, new Set(['en', 'fr']))).toBe(true);
        expect(await shouldSkipLocalText(text, new Set(['en']))).toBe(false);
        expect(await detectLocalTextLanguage(text)).toBe('und'); // Not a homogeneous page verdict.
        expect(mocks.native).toHaveBeenCalledTimes(3);
    });
    it('can skip Chinese/Japanese sentences together without conflating Chinese variants', async () => {
        const chinese = '这是一个用于测试网页翻译功能的中文段落其中包含明确的简体字形证据';
        const japanese = 'これは日本語の文章であり翻訳機能の動作を確認するための説明です';
        expect(await shouldSkipLocalText(chinese + '。' + japanese, new Set(['zh-CN', 'ja']))).toBe(true);
        expect(await shouldSkipLocalText(chinese + '。' + japanese, new Set(['ja']))).toBe(false);
        expect(await shouldSkipLocalText(chinese, new Set(['zh-TW']))).toBe(false);
        expect(mocks.native).not.toHaveBeenCalled();
    });
    it('never reuses a weaker fragment verdict to bypass paragraph thresholds', async () => {
        const short = 'Cette phrase montre comment comprendre les autres langues locales';
        mocks.native.mockImplementation(async (text: string) => result(text === short ? 'fr' : 'en'));
        expect(await shouldSkipLocalText(english + '. ' + short, new Set(['en', 'fr']))).toBe(true);
        expect(await shouldSkipLocalText(short, new Set(['fr']))).toBe(false);
        expect(mocks.native).toHaveBeenCalledTimes(3);
    });
    it.each(['"Click here"', "'Bonjour'", '「API」', '/Click here'])(
        'retains uncertain natural language rather than ignoring %s as technical content', async tail => {
            expect(await shouldSkipLocalText(english + '. ' + tail, new Set(['en']))).toBe(false);
        },
    );
    it('ignores only explicit URL tokens and numeric fragments', async () => {
        expect(await shouldSkipLocalText(english + '. 1234.56. "https://example.com/a?language=fr"', new Set(['en']))).toBe(true);
        expect(await shouldSkipLocalText('https://example.com', new Set(['en']))).toBe(false);
        expect(mocks.native).toHaveBeenCalledTimes(1);
    });
    it.each(['。', '！', '？', '，', '；', '：', ''])(
        'keeps foreign prose adjacent to an HTTP URL with separator %j', async separator => {
            const text = english + ' https://example.com/docs' + separator + '請立即點擊這裡以查看完整說明';
            expect(await shouldSkipLocalText(text, new Set(['en']))).toBe(false);
            expect(await detectLocalTextLanguage(text)).toBe('und');
        },
    );
    it('preserves Latin prose following a URL and full-width sentence punctuation', async () => {
        const text = english + ' https://example.com/docs。Bonjour';
        expect(await shouldSkipLocalText(text, new Set(['en']))).toBe(false);
        expect(mocks.native.mock.calls[0][0]).toContain('。Bonjour');
    });
    it('does not split apostrophes inside ordinary words', async () => {
        expect(await shouldSkipLocalText("It's important that " + english, new Set(['en']))).toBe(true);
        expect(mocks.native).toHaveBeenCalledTimes(1);
    });
    it('stops at the first non-skippable fragment', async () => {
        mocks.native.mockImplementation(async (text: string) => result(text === french ? 'fr' : 'en'));
        expect(await shouldSkipLocalText(french + '. ' + english, new Set(['en']))).toBe(false);
        expect(mocks.native).toHaveBeenCalledTimes(2);
        expect(mocks.native).not.toHaveBeenCalledWith(english);
    });
    it('does not cache a timed-out verdict or a late browser response', async () => {
        vi.useFakeTimers();
        let release!: (value: ReturnType<typeof result>) => void;
        mocks.native.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = shouldSkipLocalText(english, new Set(['en']));
        await vi.advanceTimersByTimeAsync(1500);
        expect(await pending).toBe(false);
        release(result('fr'));
        await vi.advanceTimersByTimeAsync(0);
        mocks.native.mockResolvedValue(result('en'));
        expect(await shouldSkipLocalText(english, new Set(['en']))).toBe(true);
        expect(mocks.native).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('retries transient browser failure instead of caching an unusable fallback', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.native.mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(result('en'));
        expect(await shouldSkipLocalText(english, new Set(['en']))).toBe(false);
        expect(await shouldSkipLocalText(english, new Set(['en']))).toBe(true);
        expect(mocks.native).toHaveBeenCalledTimes(2);
    });
    it('includes queue waiting in the shared deadline and removes expired jobs', async () => {
        vi.useFakeTimers(); mocks.native.mockImplementation(() => new Promise(() => {}));
        const pending = Array.from({ length: 8 }, (_, index) => shouldSkipLocalText(english + index, new Set(['en'])));
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.native).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1500);
        expect(await Promise.all(pending)).toEqual(Array(8).fill(false));
        expect(mocks.native).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('refreshes LRU entries instead of evicting recently reused evidence', async () => {
        for (let index = 0; index < 512; index++) await shouldSkipLocalText(english + index, new Set(['en']));
        await shouldSkipLocalText(english + '0', new Set(['en']));
        await shouldSkipLocalText(english + '512', new Set(['en']));
        await shouldSkipLocalText(english + '0', new Set(['en']));
        expect(mocks.native).toHaveBeenCalledTimes(513);
        await shouldSkipLocalText(english + '1', new Set(['en']));
        expect(mocks.native).toHaveBeenCalledTimes(514);
    });
    it('checks real statistical evidence when native detection is absent', async () => {
        mocks.i18n.detectLanguage = undefined;
        const actual = await vi.importActual<typeof import('franc')>('franc');
        mocks.statistics.mockImplementation(actual.francAll);
        const german = 'Dieser Absatz erklärt, wie die Übersetzungserweiterung funktioniert. Der Ausgangstext wird vor dem Senden einer Anfrage überprüft, damit bekannte Sprachen nicht unnötig übersetzt werden. Unsichere Inhalte bleiben weiterhin für die Übersetzung verfügbar.';
        expect(await detectLocalTextLanguage(german)).toBe('de');
        expect(await detectLocalTextLanguage(german + ' Bonjour')).toBe('und');
    });
    it('has a bounded cache instead of retaining all page text indefinitely', async () => {
        for (let index = 0; index < 513; index++) await detectLocalTextLanguage(english + index);
        expect(mocks.native).toHaveBeenCalledTimes(513);
        await detectLocalTextLanguage(english + '0');
        expect(mocks.native).toHaveBeenCalledTimes(514);
    });
});
