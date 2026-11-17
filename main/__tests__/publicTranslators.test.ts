import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), config: vi.fn(), headers: vi.fn(), stored: new Map<string, unknown>() }));
vi.mock('wxt/browser', () => ({ browser: {
    runtime: { getURL: () => 'chrome-extension://test/' },
    storage: { local: {
        get: async (key: string) => ({ [key]: mocks.stored.get(key) }),
        set: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) mocks.stored.set(key, value); },
    } },
} }));
vi.mock('@/main/storage/configStore', () => ({ configRepo: { get: mocks.config } }));
vi.mock('@/main/publicTranslationRuntime', async (original) => {
    const actual = await original<typeof import('@/main/publicTranslationRuntime')>();
    return { ...actual, ensurePublicHeaders: mocks.headers, PublicRequestLimiter: class {
        run<T>(work: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
            return Promise.resolve().then(() => { actual.checkPublicAbort(signal); return work(); });
        }
    } };
});
import { BilibiliTranslator } from '@/main/bilibiliTranslator';
import { DoubaoTranslator } from '@/main/doubaoTranslator';
import { BILIBILI_ENDPOINT, BILIBILI_MODELS, DOUBAO_ARTICLE_ENDPOINT, DOUBAO_LAUNCH_ENDPOINT, DOUBAO_SUBTITLE_ENDPOINT } from '@/main/publicTranslationConfig';
import { translatePublicMapped } from '@/main/publicTranslationText';

function chat(text: string): Response {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function article(items: unknown[]): Response {
    return new Response(`event: json\r\ndata: ${JSON.stringify({ code: 0, data: { items } })}\r\n\r\nevent: done\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function routeDoubao(reply: (url: string, init: RequestInit) => Response | Promise<Response>): void {
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
        if (url.startsWith(DOUBAO_LAUNCH_ENDPOINT)) return Response.json({ code: 0, data: { config: { ttwid: true, web_id: '1234567890' }, country: 'CN' } });
        return reply(url, init);
    });
}
const calls = (endpoint: string) => mocks.fetch.mock.calls.filter(([url]) => String(url).startsWith(endpoint));

beforeEach(() => {
    vi.clearAllMocks(); mocks.fetch.mockReset();
    mocks.config.mockResolvedValue(BILIBILI_MODELS[0]);
    mocks.headers.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('Bilibili public translation', () => {
    it.each(BILIBILI_MODELS)('reuses OpenAI streaming with %s, placeholder auth and no account cookies', async (model) => {
        mocks.fetch.mockResolvedValue(chat('你好 & 世界'));
        const out = await new BilibiliTranslator(model).translate(['Hello &amp; world'], 'zh-CN');
        expect(out[0].text).toBe('你好 &amp; 世界');
        const [url, init] = mocks.fetch.mock.calls[0];
        expect(url).toBe(BILIBILI_ENDPOINT);
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer not-required' } });
        expect(JSON.parse(init.body)).toMatchObject({ model, stream: true, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'system' }, { role: 'user', content: 'Hello & world' }] });
        expect(mocks.headers).toHaveBeenCalledWith('bilibili');
    });
    it('rejects unsupported stored models before making a network request', async () => {
        mocks.config.mockResolvedValue('unknown-model');
        await expect(new BilibiliTranslator().translate(['hello'], 'zh-CN')).rejects.toThrow('Unsupported Bilibili');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('reports HTTP 412 as WAF blocking without an automatic retry', async () => {
        mocks.fetch.mockResolvedValue(new Response('blocked', { status: 412 }));
        await expect(new BilibiliTranslator().translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { provider: 'bilibili', code: 'waf-blocked', status: 412 } });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });
    it('propagates streamed API errors instead of producing an empty success', async () => {
        mocks.fetch.mockResolvedValue(new Response('data: {"error":{"message":"service is busy"}}\n\n'));
        await expect(new BilibiliTranslator().translate(['hello'], 'zh-CN')).rejects.toThrow('service is busy');
    });
    it('cancels sibling requests when one paragraph fails', async () => {
        const signals: AbortSignal[] = [];
        mocks.fetch.mockImplementation(async (_url, init) => {
            signals.push(init.signal);
            if (signals.length === 1) return new Response('blocked', { status: 412 });
            return new Promise((_resolve, reject) => {
                const abort = () => reject(new DOMException('cancelled', 'AbortError'));
                if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
            });
        });
        await expect(new BilibiliTranslator().translate(['first', 'second'], 'zh-CN')).rejects.toThrow('blocked');
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
});

describe('Doubao public translation', () => {
    it.each([['doubao', '1'], ['doubaoVolc', '0'], ['doubaoMicrosoft', '3']])('selects %s using the shared article endpoint and engine %s', async (service, engine) => {
        routeDoubao(() => article([{ index: 1, res: '世界', detect_lang: 'en' }, { index: 0, res: '你好', detect_lang: 'en' }]));
        const out = await new DoubaoTranslator(service).translate(['Hello', 'world'], 'zh-CN');
        expect(out.map((item) => item.text)).toEqual(['你好', '世界']);
        expect(out.map((item) => item.sourceLang)).toEqual(['en', 'en']);
        const [url, init] = calls(DOUBAO_ARTICLE_ENDPOINT)[0];
        expect(JSON.parse(init.body)).toEqual({ raw_text: ['Hello', 'world'], target_lang: 'zh', translate_service: engine });
        expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer' });
        expect(init.headers.Authorization).toBeUndefined();
        expect(init.headers.Cookie).toBeUndefined();
        const query = new URL(url).searchParams;
        expect(query.get('tea_uuid')).toMatch(/^\d{18}$/);
        expect(query.get('web_id')).toBe(query.get('tea_uuid'));
        expect(query.get('device_id')).toBe('1234567890');
        expect(query.get('region')).toBe('CN');
        expect(query.get('aid')).toBe('586864');
        expect(calls(DOUBAO_LAUNCH_ENDPOINT)).toHaveLength(1);
    });
    it.each([['doubao', '1'], ['doubaoVolc', undefined], ['doubaoMicrosoft', '3']])('uses the numeric subtitle protocol for %s', async (service, engine) => {
        routeDoubao(() => Response.json({ code: 0, data: { items: [{ res: 'hello' }] } }));
        const result = await new DoubaoTranslator(service).translate(['你好'], 'en', undefined, undefined, 'subtitle');
        expect(result[0].text).toBe('hello');
        const [, init] = calls(DOUBAO_SUBTITLE_ENDPOINT)[0];
        expect(JSON.parse(init.body)).toEqual({ raw_text: ['你好'], target_lang: 38, source_lang: 0, ...(engine ? { translate_service: engine } : {}) });
        expect(init.headers['Agw-Js-Conv']).toBe('str');
        expect(calls(DOUBAO_ARTICLE_ENDPOINT)).toHaveLength(0);
    });
    it('requests only missing paragraphs once, preserving original positions', async () => {
        let attempt = 0;
        routeDoubao(() => ++attempt === 1 ? article([{ index: 1, res: '第二段', detect_lang: 'en' }]) : article([{ index: 0, res: '第一段', detect_lang: 'en' }]));
        const out = await new DoubaoTranslator('doubao').translate(['first', 'second'], 'zh-CN');
        expect(out.map((item) => item.text)).toEqual(['第一段', '第二段']);
        expect(calls(DOUBAO_ARTICLE_ENDPOINT).map(([, init]) => JSON.parse(init.body).raw_text)).toEqual([['first', 'second'], ['first']]);
    });
    it('retries empty answers rather than accepting a blank translation', async () => {
        let attempt = 0;
        routeDoubao(() => article([{ index: 0, res: ++attempt === 1 ? '' : '你好', detect_lang: 'en' }]));
        expect((await new DoubaoTranslator('doubao').translate(['hello'], 'zh-CN'))[0].text).toBe('你好');
        expect(calls(DOUBAO_ARTICLE_ENDPOINT)).toHaveLength(2);
    });
    it('fails explicitly if the retry still omits an item', async () => {
        routeDoubao(() => article([]));
        await expect(new DoubaoTranslator('doubao').translate(['hello'], 'zh-CN')).rejects.toThrow('after one retry');
        expect(calls(DOUBAO_ARTICLE_ENDPOINT)).toHaveLength(2);
    });
    it('recognizes login errors and reinitializes the session on a later user retry', async () => {
        routeDoubao(() => new Response('event: err\ndata: {"code":"710012001"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
        const translator = new DoubaoTranslator('doubao');
        await expect(translator.translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { code: 'auth' } });
        routeDoubao(() => article([{ index: 0, res: '你好', detect_lang: 'en' }]));
        expect((await translator.translate(['hello'], 'zh-CN'))[0].text).toBe('你好');
        expect(calls(DOUBAO_LAUNCH_ENDPOINT)).toHaveLength(2);
    });
    it('rejects malformed indices instead of putting text into the wrong paragraph', async () => {
        routeDoubao(() => article([{ index: 99, res: 'wrong' }]));
        await expect(new DoubaoTranslator('doubao').translate(['hello'], 'zh-CN')).rejects.toThrow('invalid translation item');
    });
    it('retains source text when the provider detects the requested target language', async () => {
        routeDoubao(() => article([{ index: 0, res: '', detect_lang: 'en' }]));
        expect((await new DoubaoTranslator('doubao').translate(['hello'], 'en'))[0].text).toBe('hello');
    });
    it('rejects unsupported article targets or forced sources before using a login session', async () => {
        await expect(new DoubaoTranslator('doubao').translate(['hello'], 'uk')).rejects.toThrow('does not support');
        await expect(new DoubaoTranslator('doubao').translate(['hello'], 'zh-CN', undefined, 'en')).rejects.toThrow('automatic source detection');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('honors an already-aborted request before sending text', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(new DoubaoTranslator('doubao').translate(['hello'], 'zh-CN', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});

describe('public mapped HTML adapter', () => {
    it('preserves markers and escapes provider text exactly once', async () => {
        const translate = vi.fn(async () => [{ text: '<b0>A & B</b0>', sourceLang: 'en' }]);
        expect((await translatePublicMapped(['<b0>A &amp; B</b0>'], translate))[0].text).toBe('<b0>A &amp; B</b0>');
        expect(translate).toHaveBeenCalledWith(['<b0>A & B</b0>']);
    });
    it('treats literal escaped marker-like input as text rather than executable DOM markers', async () => {
        const out = await translatePublicMapped(['&lt;b0&gt;hello&lt;/b0&gt;'], async () => [{ text: '<b0>你好</b0>', sourceLang: 'en' }]);
        expect(out[0].text).toBe('&lt;b0&gt;你好&lt;/b0&gt;');
    });
    it('repairs lost formatting by translating spans, never discarding the element map', async () => {
        const translate = vi.fn().mockResolvedValueOnce([{ text: '你好世界', sourceLang: 'en' }])
            .mockResolvedValueOnce([{ text: '你好', sourceLang: 'en' }, { text: '世界', sourceLang: 'en' }]);
        const out = await translatePublicMapped(['<b0>Hello <b1>world</b1></b0>'], translate);
        expect(out[0].text).toBe('<b0>你好 <b1>世界</b1></b0>');
        expect(translate.mock.calls[1][0]).toEqual(['Hello', 'world']);
    });
    it('skips whitespace and empty markup instead of generating model content', async () => {
        const translate = vi.fn();
        expect((await translatePublicMapped([' ', '<b0></b0>'], translate)).map((item) => item.text)).toEqual([' ', '<b0></b0>']);
        expect(translate).not.toHaveBeenCalled();
    });
});
