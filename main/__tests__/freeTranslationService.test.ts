import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONFIG_KEY } from '@/main/constants';
import { TranslateResult } from '@/main/translateClient';

const mocks = vi.hoisted(() => ({ get: vi.fn(), cacheGet: vi.fn(), cachePut: vi.fn() }));
vi.mock('@/main/storage/configStore', () => ({ configRepo: { get: mocks.get } }));
vi.mock('@/main/storage/translationCache', () => ({ getMany: mocks.cacheGet, putMany: mocks.cachePut }));
vi.mock('@/main/aiService', () => ({ aiPageTranslate: vi.fn() }));
let services: typeof import('@/main/translateService');
let config: Record<string, unknown>;
const answer = (text = '你好', source = 'en') => new TranslateResult(text, source, 1);
const pool = (ids: string[]) => { config[CONFIG_KEY.FREE_TRANSLATION] = { mode: 'ordered', services: ids }; };
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0);
    config = {};
    mocks.get.mockReset().mockImplementation(async (key: string) => config[key]);
    mocks.cacheGet.mockReset().mockImplementation(async (_service: string, _target: string, texts: string[]) => texts.map(() => null));
    mocks.cachePut.mockReset().mockResolvedValue(undefined);
    services = await import('@/main/translateService');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('remaps cached and streaming miss indices to the original paragraph order', async () => {
    config[CONFIG_KEY.TRANSLATION_CACHE_SWITCH] = true;
    mocks.cacheGet.mockResolvedValue([{ t: '缓存', s: 'en', c: 1 }, null, null]);
    const { DoubaoTranslator } = await import('@/main/doubaoTranslator');
    const progress = vi.fn();
    vi.spyOn(DoubaoTranslator.prototype, 'translate').mockImplementation(async (_texts, _target, _signal, _source, _scene, publish) => {
        expect(progress).toHaveBeenCalledWith(0, answer('缓存'));
        publish!(1, { text: '第三段', sourceLang: 'en' });
        return [{ text: '第二段', sourceLang: 'en' }, { text: '第三段', sourceLang: 'en' }];
    });
    const results = await services.translateTextsWithCache('doubao', ['one', 'two', 'three'], 'zh-CN', undefined, undefined, undefined, progress);
    expect(progress).toHaveBeenCalledWith(2, answer('第三段'));
    expect(results?.map(item => item.translatedMappedHtmlText)).toEqual(['缓存', '第二段', '第三段']);
});

it('does not publish results from a free-pool attempt that may still fall back', async () => {
    pool(['doubao', 'google']);
    const { DoubaoTranslator } = await import('@/main/doubaoTranslator');
    vi.spyOn(DoubaoTranslator.prototype, 'translate').mockImplementation(async (_texts, _target, _signal, _source, _scene, publish) => {
        expect(publish).toBeUndefined();
        throw Error('failed after partial stream');
    });
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer('备用结果')]);
    const progress = vi.fn();
    const results = await services.translateTextsWithCache('freeAuto', ['one'], 'zh-CN', undefined, undefined, undefined, progress);
    expect(progress).not.toHaveBeenCalled();
    expect(results?.[0]).toMatchObject({ actualService: 'google', translatedMappedHtmlText: '备用结果' });
});

it('preserves order and provenance for mixed cache hits while routing only misses', async () => {
    pool(['google']);
    mocks.cacheGet.mockResolvedValue([
        { t: '缓存一', s: 'en', c: 1, actualService: 'microsoft' },
        null,
        { t: '缓存三', s: 'en', c: 1, actualService: 'bilibili' },
    ]);
    const google = vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer('新译文')]);
    const progress = vi.fn();
    const result = await services.translateTextsWithCache('freeAuto', ['one', 'two', 'three'], 'zh-CN', undefined, undefined, undefined, progress);
    expect(google).toHaveBeenCalledWith(['two'], 'zh-CN', expect.any(AbortSignal), undefined, undefined);
    expect(result?.map(({ translatedMappedHtmlText, actualService }) => [translatedMappedHtmlText, actualService])).toEqual([
        ['缓存一', 'microsoft'], ['新译文', 'google'], ['缓存三', 'bilibili'],
    ]);
    expect(progress.mock.calls.map(([index]) => index)).toEqual([0, 2]);
});

it('does not write a result from an automatic request cancelled during the attempt', async () => {
    pool(['google']);
    const controller = new AbortController();
    vi.spyOn(services.googleTranslationService, 'translateText').mockImplementation(async () => {
        controller.abort();
        return [answer()];
    });
    const progress = vi.fn();
    await expect(services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN', controller.signal, undefined, undefined, progress))
        .rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.cachePut).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
});

it('registers the aggregate and pins it first in the shared display list', async () => {
    const { TRANSLATE_SERVICES } = await import('@/main/constants');
    expect(services.resolveTranslateService('freeAuto')).toBeInstanceOf(services.FreeTranslateService);
    expect([...TRANSLATE_SERVICES.keys()][0]).toBe('freeAuto');
});
it.each(['transmart', 'volcengine', 'lara', 'modernMt'] as const)('registers %s independently and uses the aggregate cache namespace when opted into the pool', async (id) => {
    pool([id]);
    const { WebTranslator } = await import('@/main/webTranslator');
    const translate = vi.spyOn(WebTranslator.prototype, 'translate').mockResolvedValue([{ text: '甲 &amp; 乙', sourceLang: 'en' }]);
    expect(services.resolveTranslateService(id)).toBeInstanceOf(services.WebTranslateService);
    const result = await services.translateTextsWithCache('freeAuto', ['A &amp; B'], 'zh-CN', undefined, 'en', 'subtitle');
    expect(result?.[0]).toMatchObject({ translatedMappedHtmlText: '甲 &amp; 乙', actualService: id });
    expect(translate).toHaveBeenCalledWith(['A &amp; B'], 'zh-CN', expect.any(AbortSignal), 'en', undefined);
    expect(mocks.cacheGet).toHaveBeenCalledWith('freeAuto:v1:subtitle:from:en', 'zh-CN', ['A &amp; B']);
    expect(mocks.cachePut).toHaveBeenCalledWith('freeAuto:v1:subtitle:from:en', 'zh-CN', expect.any(Array), { keepExisting: true });
});
it('sends uncached items to one provider and never writes to its manual cache', async () => {
    const ms = vi.spyOn(services.microsoftTranslationService, 'translateText').mockResolvedValue([answer('第一段'), answer('第二段')]);
    const google = vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer('wrong')]);
    const result = await services.translateTextsWithCache('freeAuto', ['one', 'two'], 'zh-CN');
    expect(result?.map((item) => item.actualService)).toEqual(['microsoft', 'microsoft']);
    expect(ms).toHaveBeenCalledTimes(1);
    expect(google).not.toHaveBeenCalled();
    expect(mocks.cacheGet.mock.calls).toEqual([['freeAuto:v1:text', 'zh-CN', ['one', 'two']]]);
    expect(mocks.cachePut.mock.calls).toEqual([['freeAuto:v1:text', 'zh-CN', [
        { text: 'one', value: { t: '第一段', s: 'en', c: 1, actualService: 'microsoft' } },
        { text: 'two', value: { t: '第二段', s: 'en', c: 1, actualService: 'microsoft' } },
    ], { keepExisting: true }]]);
});
it('switches the entire batch on failure, retaining source, scene and escaped inline markup', async () => {
    pool(['microsoft', 'google']);
    vi.spyOn(services.microsoftTranslationService, 'translateText').mockRejectedValue(new Error('offline'));
    const google = vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer('<b0>甲 &amp; 乙</b0>')]);
    const result = await services.translateTextsWithCache('freeAuto', ['<b0>A &amp; B</b0>'], 'zh-CN', undefined, 'en', 'subtitle');
    expect(result?.[0]).toMatchObject({ translatedMappedHtmlText: '<b0>甲 &amp; 乙</b0>', actualService: 'google' });
    expect(google).toHaveBeenCalledWith(['<b0>A &amp; B</b0>'], 'zh-CN', expect.any(AbortSignal), 'en', { scene: 'subtitle' });
    expect(mocks.cacheGet).toHaveBeenCalledWith('freeAuto:v1:subtitle:from:en', 'zh-CN', ['<b0>A &amp; B</b0>']);
});
it('repairs dropped native HTML markers and escapes arbitrary returned tags', async () => {
    pool(['google']);
    const google = vi.spyOn(services.googleTranslationService, 'translateText')
        .mockResolvedValueOnce([answer('lost markers')])
        .mockResolvedValueOnce([answer('<script>unsafe</script>'), answer('世界')]);
    const result = await services.translateTextsWithCache('freeAuto', ['Hello <b0>world</b0>'], 'zh-CN');
    expect(google).toHaveBeenCalledTimes(2);
    expect(result?.[0].translatedMappedHtmlText).toBe('&lt;script&gt;unsafe&lt;/script&gt; <b0>世界</b0>');
});
it('serves historical results without consulting route settings or contacting a provider', async () => {
    pool(['microsoft']);
    mocks.cacheGet.mockResolvedValue([{ t: '你好', s: 'en', c: 1, actualService: 'google' }]);
    const google = vi.spyOn(services.googleTranslationService, 'translateText');
    const result = await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN');
    expect(result?.[0]).toMatchObject({ translatedMappedHtmlText: '你好', actualService: 'google' });
    expect(google).not.toHaveBeenCalled();
    expect(mocks.cacheGet).toHaveBeenCalledWith('freeAuto:v1:text', 'zh-CN', ['hello']);
    expect(mocks.get.mock.calls).toEqual([[CONFIG_KEY.TRANSLATION_CACHE_SWITCH]]);
});
it('uses one shared cache key for Bilibili models inside the pool', async () => {
    pool(['bilibili']);
    const { BilibiliTranslator } = await import('@/main/bilibiliTranslator');
    vi.spyOn(BilibiliTranslator.prototype, 'translate').mockResolvedValue([{ text: '你好', sourceLang: 'en' }]);
    config[CONFIG_KEY.BILIBILI_TRANSLATE_MODEL] = 'index-mt-9b';
    const first = await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN');
    config[CONFIG_KEY.BILIBILI_TRANSLATE_MODEL] = 'index-mt-2b';
    await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN');
    expect(first?.[0].actualService).toBe('bilibili');
    expect(mocks.cacheGet.mock.calls.map(([namespace]) => namespace)).toEqual(['freeAuto:v1:text', 'freeAuto:v1:text']);
});
it('excludes globally disabled services even when selected in the pool', async () => {
    pool(['microsoft', 'google']);
    config[CONFIG_KEY.DISABLED_TRANSLATE_SERVICES] = ['microsoft'];
    const ms = vi.spyOn(services.microsoftTranslationService, 'translateText');
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer()]);
    expect((await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN'))?.[0].actualService).toBe('google');
    expect(ms).not.toHaveBeenCalled();
});
it('rejects a pool whose services are all globally disabled without requesting a provider', async () => {
    pool(['google']); config[CONFIG_KEY.DISABLED_TRANSLATE_SERVICES] = ['google'];
    await expect(services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN')).rejects.toThrow('No eligible');
    expect(mocks.cacheGet).toHaveBeenCalledOnce();
    expect(mocks.cachePut).not.toHaveBeenCalled();
});
it('skips login-backed routes for explicit source languages and unsupported article targets', async () => {
    pool(['doubao', 'google']);
    const { DoubaoTranslator } = await import('@/main/doubaoTranslator');
    const doubao = vi.spyOn(DoubaoTranslator.prototype, 'translate');
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer()]);
    await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN', undefined, 'en');
    await services.translateTextsWithCache('freeAuto', ['hello'], 'uk');
    expect(doubao).not.toHaveBeenCalled();
});
it('forwards subtitle scene to opted-in Doubao and uses the aggregate subtitle namespace', async () => {
    pool(['doubaoVolc']);
    const { DoubaoTranslator } = await import('@/main/doubaoTranslator');
    const doubao = vi.spyOn(DoubaoTranslator.prototype, 'translate').mockResolvedValue([{ text: '字幕', sourceLang: '' }]);
    const result = await services.translateTextsWithCache('freeAuto', ['caption'], 'uk', undefined, undefined, 'subtitle');
    expect(doubao).toHaveBeenCalledWith(['caption'], 'uk', expect.any(AbortSignal), undefined, 'subtitle', undefined);
    expect(mocks.cacheGet).toHaveBeenCalledWith('freeAuto:v1:subtitle', 'uk', ['caption']);
    expect(result?.[0].actualService).toBe('doubaoVolc');
});
it('bypasses Microsoft rather than accepting its per-item truncation', async () => {
    pool(['microsoft', 'google']);
    const ms = vi.spyOn(services.microsoftTranslationService, 'translateText');
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer()]);
    await services.translateTextsWithCache('freeAuto', ['x'.repeat(5001)], 'zh-CN');
    expect(ms).not.toHaveBeenCalled();
});
it('does not turn empty native answers into successful translations', async () => {
    pool(['google', 'yandex']);
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer('')]);
    vi.spyOn(services.translationServices.get('yandex')!, 'translateText').mockResolvedValue([answer()]);
    expect((await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN'))?.[0].actualService).toBe('yandex');
});
it('honors the cache switch and forwards explicit sources without caching', async () => {
    pool(['google']); config[CONFIG_KEY.TRANSLATION_CACHE_SWITCH] = false;
    vi.spyOn(services.googleTranslationService, 'translateText').mockResolvedValue([answer()]);
    await services.translateTextsWithCache('freeAuto', ['hello'], 'zh-CN', undefined, 'en');
    expect(mocks.cacheGet).not.toHaveBeenCalled(); expect(mocks.cachePut).not.toHaveBeenCalled();
});
