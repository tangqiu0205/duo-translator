import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sseEvents, sseFrames } from '@/main/aiServiceShared';

const mocks = vi.hoisted(() => ({ rules: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
    runtime: { getURL: () => 'chrome-extension://abcdefghijklmnop/' },
    declarativeNetRequest: { updateSessionRules: mocks.rules },
} }));
let runtime: typeof import('@/main/publicTranslationRuntime');
beforeEach(async () => {
    vi.resetModules();
    mocks.rules.mockReset().mockResolvedValue(undefined);
    runtime = await import('@/main/publicTranslationRuntime');
});
afterEach(() => { vi.useRealTimers(); });

it('scopes header rules to our background POST requests and exact provider endpoints', async () => {
    await runtime.ensurePublicHeaders('bilibili');
    await runtime.ensurePublicHeaders('doubao');
    expect(mocks.rules).toHaveBeenCalledTimes(2);
    const rules = mocks.rules.mock.calls.map(([arg]) => arg.addRules[0]);
    for (const rule of rules) {
        expect(rule.condition).toMatchObject({ initiatorDomains: ['abcdefghijklmnop'], requestMethods: ['post'], resourceTypes: ['xmlhttprequest'], tabIds: [-1] });
    }
    expect(rules[0].action.requestHeaders).toEqual([{ header: 'origin', operation: 'remove' }]);
    expect(rules[1].action.requestHeaders).toEqual([{ header: 'origin', operation: 'set', value: 'chrome-extension://dbjibobgilijgolhjdcbdebjhejelffo' }]);
    const index = new RegExp(rules[0].condition.regexFilter);
    expect(index.test('https://index-translate.bilibili.com/v1/chat/completions')).toBe(true);
    expect(index.test('https://index-translate.bilibili.com/v1/chat/completions/other')).toBe(false);
    const doubao = new RegExp(rules[1].condition.regexFilter);
    expect(doubao.test('https://www.doubao.com/alice/user/launch?aid=586864')).toBe(true);
    expect(doubao.test('https://www.doubao.com/samantha/plugin/stream_article_translate?x=1')).toBe(true);
    expect(doubao.test('https://www.doubao.com/samantha/plugin/translate?x=1')).toBe(true);
    expect(doubao.test('https://www.doubao.com/samantha/image/translate?x=1')).toBe(false);
    expect(doubao.test('https://evil.example/samantha/plugin/translate')).toBe(false);
    await runtime.ensurePublicHeaders('bilibili');
    expect(mocks.rules).toHaveBeenCalledTimes(2);
});

it('shares simultaneous setup and retries failed header preparation', async () => {
    mocks.rules.mockRejectedValueOnce(new Error('permission denied'));
    await expect(Promise.all([runtime.ensurePublicHeaders('doubao'), runtime.ensurePublicHeaders('doubao')])).rejects.toThrow('permission denied');
    expect(mocks.rules).toHaveBeenCalledTimes(1);
    await runtime.ensurePublicHeaders('doubao');
    expect(mocks.rules).toHaveBeenCalledTimes(2);
});

it('enforces both the rolling request budget and maximum concurrency', async () => {
    vi.useFakeTimers();
    const limiter = new runtime.PublicRequestLimiter(3, 1000, 2);
    const starts: number[] = [];
    let active = 0, maximum = 0;
    const work = async () => {
        starts.push(Date.now()); active++; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--; return 'ok';
    };
    const jobs = Array.from({ length: 4 }, () => limiter.run(work));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(3);
    expect(maximum).toBe(2);
    await vi.advanceTimersByTimeAsync(11);
    expect(await Promise.all(jobs)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(starts[3] - starts[0]).toBeGreaterThanOrEqual(1000);
});

it('removes queued cancelled jobs without poisoning the next request', async () => {
    const limiter = new runtime.PublicRequestLimiter(3, 1000, 1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const controller = new AbortController();
    const cancelledWork = vi.fn(async () => 'cancelled');
    const second = limiter.run(cancelledWork, controller.signal);
    const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection;
    release(); await first;
    await expect(limiter.run(async () => { throw new Error('network'); })).rejects.toThrow('network');
    expect(await limiter.run(async () => 'next')).toBe('next');
    expect(cancelledWork).not.toHaveBeenCalled();
});

it('parses fragmented CRLF, multi-line data, Unicode and a final frame without a separator', async () => {
    const bytes = new TextEncoder().encode('event: json\r\ndata: 你\r\ndata: 好\r\n\r\nevent: done\r\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
        controller.close();
    } });
    const events = [];
    for await (const event of sseEvents(body)) events.push(event);
    expect(events).toEqual([{ event: 'json', data: '你\n好' }, { event: 'done', data: '' }]);
    expect(body.locked).toBe(false);
});

it('cancels the upstream reader when an SSE consumer stops early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel });
    for await (const frame of sseFrames(body)) { expect(frame).toBe('first'); break; }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
});
