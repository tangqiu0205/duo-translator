import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WEB_TRANSLATION_ENDPOINTS, WEB_TRANSLATION_SERVICES, type WebTranslationService } from '@/main/webTranslationConfig';

let module: typeof import('@/main/webTranslator');
const fetchMock = vi.fn();
function payload(id: WebTranslationService, text: unknown): unknown {
    if (id === 'transmart') return { header: { ret_code: 'succ' }, auto_translation: [text] };
    if (id === 'volcengine') return { base_resp: { status_code: 0 }, translation: text };
    if (id === 'modernMt') return { status: 200, data: { translation: text } };
    return { status: 200, content: { translations: [{ translation: text }] } };
}
function reply(id: WebTranslationService, text: unknown): Response { return Response.json(payload(id, text)); }
const requestText = (id: WebTranslationService, body: any): string => id === 'transmart' ? body.source.text_list[0] : id === 'volcengine' ? body.text : body.q;
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
    module = await import('@/main/webTranslator');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('publishes a long paragraph only after all chunks finish, without waiting for the next paragraph', async () => {
    let finishParagraph!: (response: Response) => void;
    let finishNext!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(reply('transmart', '前半'))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finishParagraph = resolve; }))
        .mockImplementationOnce(() => new Promise<Response>(resolve => { finishNext = resolve; }));
    const progress = vi.fn();
    const pending = new module.WebTranslator('transmart').translate(['x'.repeat(1001), 'next paragraph'], 'zh-CN', undefined, undefined, progress);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(progress).not.toHaveBeenCalled();
    finishParagraph(reply('transmart', '后半'));
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith(0, { text: '前半后半', sourceLang: '' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(progress).toHaveBeenCalledTimes(1);
    finishNext(reply('transmart', '下一段'));
    await pending;
    expect(progress).toHaveBeenCalledTimes(2);
});

it.each(WEB_TRANSLATION_SERVICES)('uses the fixed %s endpoint and omits credentials and redirects', async (id) => {
    fetchMock.mockResolvedValue(reply(id, '甲 & 乙 <script>literal</script>'));
    const result = await new module.WebTranslator(id).translate(['A &amp; B &lt;script&gt;literal&lt;/script&gt;'], 'zh-CN');
    expect(result).toEqual([{ text: '甲 &amp; 乙 &lt;script&gt;literal&lt;/script&gt;', sourceLang: '' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEB_TRANSLATION_ENDPOINTS[id]);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(init.headers.Cookie).toBeUndefined(); expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(requestText(id, body)).toBe('A & B <script>literal</script>');
    if (id === 'transmart') {
        expect(body).toMatchObject({ header: { fn: 'auto_translation', client_key: expect.stringMatching(/^browser-chrome-110\.0\.0-Mac OS-/) }, type: 'plain', model_category: 'normal', source: { lang: 'auto' }, target: { lang: 'zh' } });
    } else if (id === 'volcengine') expect(body).toMatchObject({ source_language: 'auto', target_language: 'zh' });
    else if (id === 'lara') {
        expect(init.headers['X-Lara-Client']).toBe('Webapp');
        expect(body).toMatchObject({ source: '', target: 'zh-CN', style: 'faithful', content_type: 'text/plain', adapt_to: [], glossaries: [], instructions: [] });
    } else {
        expect(init.headers['X-HTTP-Method-Override']).toBe('GET');
        const expected = createHash('md5').update(`webkey_E3sTuMjpP8Jez49GcYpDVH7r#${body.ts}#${body.q}`).digest('hex');
        expect(body).toMatchObject({ source: '', target: 'zh-CN', ts: expect.any(Number), verify: expected, multiline: 'true' });
    }
});
it.each(WEB_TRANSLATION_SERVICES)('forwards explicit source and traditional target codes for %s', async (id) => {
    fetchMock.mockResolvedValue(reply(id, '繁體'));
    const result = await new module.WebTranslator(id).translate(['hello'], 'zh-TW', undefined, 'en');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    if (id === 'transmart') expect(body).toMatchObject({ source: { lang: 'en' }, target: { lang: 'zh-tw' } });
    else if (id === 'volcengine') expect(body).toMatchObject({ source_language: 'en', target_language: 'zh-Hant' });
    else expect(body).toMatchObject({ source: 'en', target: 'zh-TW' });
    expect(result[0].sourceLang).toBe('en');
});
it.each(WEB_TRANSLATION_SERVICES)('rejects unsupported language parameters before calling %s', async (id) => {
    await expect(new module.WebTranslator(id).translate(['hello'], 'invalid')).rejects.toMatchObject({ detail: { status: 400 } });
    await expect(new module.WebTranslator(id).translate(['hello'], 'zh-CN', undefined, 'invalid')).rejects.toMatchObject({ detail: { status: 400 } });
    expect(fetchMock).not.toHaveBeenCalled();
});
it.each(WEB_TRANSLATION_SERVICES)('rejects blank or malformed %s business results without caching a partial success', async (id) => {
    fetchMock.mockResolvedValue(reply(id, ''));
    await expect(new module.WebTranslator(id).translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { code: 'invalid-response' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
it.each([400, 403, 412, 429, 500])('exposes HTTP %s without retrying or consuming an error page', async (status) => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
    await expect(new module.WebTranslator('transmart').translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { provider: 'transmart', status } });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
});
it('maps Tencent authentication failure and numeric business errors into structured statuses', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ header: { ret_code: 'Auth-Failed' } }))
        .mockResolvedValueOnce(Response.json({ status: 429 }))
        .mockResolvedValueOnce(Response.json({ base_resp: { status_code: 400 } }));
    await expect(new module.WebTranslator('transmart').translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { status: 403 } });
    await expect(new module.WebTranslator('lara').translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { status: 429 } });
    await expect(new module.WebTranslator('volcengine').translate(['hello'], 'zh-CN')).rejects.toMatchObject({ detail: { status: 400 } });
});
it('rejects invalid JSON and bounds response size', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>error</html>')).mockResolvedValueOnce(new Response('x'.repeat(1_000_001)));
    await expect(new module.WebTranslator('lara').translate(['hello'], 'zh-CN')).rejects.toThrow('valid JSON');
    await expect(new module.WebTranslator('lara').translate(['hello'], 'zh-CN')).rejects.toThrow('size limit');
});
it('preserves paragraph order, CRLF and edge whitespace without sending blank chunks', async () => {
    fetchMock.mockImplementation(async (_url, init) => reply('lara', JSON.parse(init.body).q.toUpperCase()));
    const result = await new module.WebTranslator('lara').translate(['  first\r\n second  ', 'third', ' \n '], 'zh-CN');
    expect(result.map((item) => item.text)).toEqual(['  FIRST\r\n SECOND  ', 'THIRD', ' \n ']);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).q)).toEqual(['first', 'second', 'third']);
});
it('preserves mapping tags and repairs them locally when a plain-text provider drops tags', async () => {
    fetchMock.mockResolvedValueOnce(reply('lara', '你好世界'))
        .mockResolvedValueOnce(reply('lara', '你好')).mockResolvedValueOnce(reply('lara', '世界'));
    const result = await new module.WebTranslator('lara').translate(['Hello <b0>world</b0>'], 'zh-CN');
    expect(result[0].text).toBe('你好 <b0>世界</b0>');
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).q)).toEqual(['Hello <b0>world</b0>', 'Hello', 'world']);
});
it('splits long paragraphs without losing text or exceeding the per-request character budget', async () => {
    fetchMock.mockImplementation(async (_url, init) => reply('lara', JSON.parse(init.body).q));
    const original = '词'.repeat(2100);
    const result = new module.WebTranslator('lara').translate([original], 'en');
    await vi.advanceTimersByTimeAsync(0);
    expect((await result)[0].text).toBe(original);
    const queries = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).q);
    expect(queries.map((query) => Array.from(query).length)).toEqual([1000, 1000, 100]);
    expect(queries.join('')).toBe(original);
});
it('shares a rolling three-per-second and two-concurrent budget across instances of one provider', async () => {
    let active = 0, maximum = 0;
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
        starts.push(Date.now()); maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 10)); active--;
        return reply('lara', 'ok');
    });
    const jobs = Array.from({ length: 4 }, () => new module.WebTranslator('lara').translate(['text'], 'en'));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(3); expect(maximum).toBe(2);
    await vi.advanceTimersByTimeAsync(11); await Promise.all(jobs);
    expect(starts[3] - starts[0]).toBeGreaterThanOrEqual(1000);
});
it('does not share request budgets between independent vendors', async () => {
    fetchMock.mockImplementation(async (url) => reply(WEB_TRANSLATION_SERVICES.find((id) => WEB_TRANSLATION_ENDPOINTS[id] === url)!, 'ok'));
    const jobs = WEB_TRANSLATION_SERVICES.map((id) => new module.WebTranslator(id).translate(['text'], 'en'));
    await vi.advanceTimersByTimeAsync(0); await Promise.all(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(4);
});
it('removes a cancelled queued request before it sends text', async () => {
    const releases: Array<() => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { releases.push(() => resolve(reply('lara', 'ok'))); }));
    const first = new module.WebTranslator('lara').translate(['one'], 'en');
    const second = new module.WebTranslator('lara').translate(['two'], 'en');
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const queued = new module.WebTranslator('lara').translate(['never sent'], 'en', controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    releases.forEach((release) => release()); await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('honors already-aborted and active cancellation without sending fallback requests', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new module.WebTranslator('lara').translate(['text'], 'en', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const active = new AbortController();
    const job = new module.WebTranslator('lara').translate(['text'], 'en', active.signal);
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); active.abort(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
});
it('times out an individual request and releases its timer', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const job = new module.WebTranslator('modernMt').translate(['text'], 'en');
    const rejected = expect(job).rejects.toMatchObject({ detail: { code: 'timeout', status: 408 } });
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(vi.getTimerCount()).toBe(0);
});
it('keeps graphemes, surrogate pairs and mapping markers intact at chunk boundaries', () => {
    const family = '👨‍👩‍👧‍👦';
    const text = '123456789<b12>文字</b12>' + family.repeat(8);
    const chunks = [...module.splitWebTranslationText(text, 10)];
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 10)).toBe(true);
    expect(chunks.every((chunk) => !/<[^>]*$/.test(chunk))).toBe(true);
    expect(chunks.filter((chunk) => chunk.includes('👨')).every((chunk) => chunk.includes(family))).toBe(true);
});
it('refuses an atom larger than the chunk budget rather than silently truncating it', () => {
    expect(() => [...module.splitWebTranslationText('👨‍👩‍👧‍👦', 3)]).toThrow('exceeds');
    expect(() => [...module.splitWebTranslationText('<b12345>', 3)]).toThrow('exceeds');
});
