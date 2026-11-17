import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FreeTranslationRouter } from '@/main/freeTranslationRouter';
import { defaultFreeTranslationSettings, readFreeTranslationSettings } from '@/main/freeTranslationConfig';

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('defaults to keyless providers without login, excluding local AI and paid services', () => {
    expect(readFreeTranslationSettings(undefined)).toEqual({ mode: 'balanced', services: ['microsoft', 'google', 'yandex', 'bilibili'] });
    const first = defaultFreeTranslationSettings(); first.services.pop();
    expect(defaultFreeTranslationSettings().services).toHaveLength(4);
});
it.each([
    { mode: 'balanced', services: [] }, { mode: 'random', services: ['google'] },
    { mode: 'balanced', services: ['builtin'] }, { mode: 'ordered', services: ['deepl'] },
    { mode: 'ordered', services: ['ai:private'] }, { mode: 'ordered', services: ['freeAuto'] }, 'bad',
])('rejects invalid or non-free pool settings %j', (value) => {
    expect(() => readFreeTranslationSettings(value)).toThrow('Invalid free translation settings');
});
it('deduplicates participants without changing their configured priority', () => {
    expect(readFreeTranslationSettings({ mode: 'ordered', services: ['google', 'microsoft', 'google'] }).services).toEqual(['google', 'microsoft']);
});
it('tries configured priorities sequentially and returns the actual route', async () => {
    const work = vi.fn().mockRejectedValueOnce(Object.assign(new Error('limited'), { status: 429 })).mockResolvedValueOnce('translated');
    const result = await new FreeTranslationRouter().run(['microsoft', 'google', 'yandex'], 'ordered', work);
    expect(result).toEqual({ service: 'google', value: 'translated' });
    expect(work.mock.calls.map(([id]) => id)).toEqual(['microsoft', 'google']);
    expect(work.mock.calls[0][1].aborted).toBe(true);
});
it('switches on a provider-internal abort when the caller has not cancelled', async () => {
    const work = vi.fn().mockRejectedValueOnce(new DOMException('provider timeout', 'AbortError')).mockResolvedValueOnce('ok');
    expect((await new FreeTranslationRouter().run(['microsoft', 'google'], 'ordered', work)).service).toBe('google');
});
it('cools a failed service across requests, then permits a recovery attempt', async () => {
    const router = new FreeTranslationRouter();
    const work = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue('ok');
    await router.run(['microsoft', 'google'], 'ordered', work);
    work.mockClear();
    await expect(router.run(['microsoft'], 'ordered', work)).rejects.toThrow('cooling down');
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await router.run(['microsoft'], 'ordered', work)).service).toBe('microsoft');
});
it('does not cool a service for a text-specific HTTP 400', async () => {
    const router = new FreeTranslationRouter();
    const work = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unsupported language'), { status: 400 })).mockResolvedValue('ok');
    await router.run(['microsoft', 'google'], 'ordered', work);
    expect((await router.run(['microsoft'], 'ordered', work)).service).toBe('microsoft');
});
it('shares login and rate-limit failures across all Doubao routes', async () => {
    const work = vi.fn().mockRejectedValueOnce({ detail: { code: 'auth' } }).mockResolvedValue('ok');
    const router = new FreeTranslationRouter();
    expect((await router.run(['doubao', 'doubaoVolc', 'doubaoMicrosoft', 'google'], 'ordered', work)).service).toBe('google');
    expect(work.mock.calls.map(([id]) => id)).toEqual(['doubao', 'google']);
});
it('balances by observed latency rather than always picking the first service', async () => {
    const work = vi.fn(async (id: string) => {
        if (id === 'microsoft') vi.setSystemTime(Date.now() + 9000);
        return 'ok';
    });
    const router = new FreeTranslationRouter(() => 0.45);
    expect((await router.run(['microsoft', 'google'], 'balanced', work)).service).toBe('microsoft');
    expect((await router.run(['microsoft', 'google'], 'balanced', work)).service).toBe('google');
});
it('does not count three Doubao engine labels as three independent backends', async () => {
    const work = vi.fn(async () => 'ok');
    expect((await new FreeTranslationRouter(() => 0.6).run(['doubao', 'doubaoVolc', 'doubaoMicrosoft', 'google'], 'balanced', work)).service).toBe('google');
});
it('does not start work for an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const work = vi.fn();
    await expect(new FreeTranslationRouter().run(['google'], 'ordered', work, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
});
it('cancels an active request immediately without starting a fallback or cooling the route', async () => {
    const router = new FreeTranslationRouter();
    const controller = new AbortController();
    const work = vi.fn((_id: string, _signal: AbortSignal) => new Promise<string>(() => {}));
    const result = router.run(['microsoft', 'google'], 'ordered', work, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejected;
    expect(work).toHaveBeenCalledTimes(1);
    expect(work.mock.calls[0][1].aborted).toBe(true);
    expect((await router.run(['microsoft'], 'ordered', async () => 'ok')).service).toBe('microsoft');
});
it('bounds individual attempts and the total deadline even if a provider ignores abort', async () => {
    const router = new FreeTranslationRouter(() => 0, 10, 25);
    const work = vi.fn((_id: string, _signal: AbortSignal) => new Promise<string>(() => {}));
    const result = router.run(['microsoft', 'google', 'yandex'], 'ordered', work);
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(work).toHaveBeenCalledTimes(3);
    expect(work.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});
it('does not release real concurrency slots just because callers timed out', async () => {
    const router = new FreeTranslationRouter(() => 0, 10, 100);
    const work = vi.fn(() => new Promise<string>(() => {}));
    const runs = Array.from({ length: 5 }, () => router.run(['google'], 'ordered', work).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(runs);
    expect(work).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
});
it('does not start queued work on a route that entered cooldown while waiting', async () => {
    const router = new FreeTranslationRouter();
    const finish: Array<(value: string) => void> = [];
    let fail!: (reason: unknown) => void;
    const work = vi.fn((id: string) => id === 'microsoft' ? Promise.resolve('fallback')
        : new Promise<string>((resolve, reject) => { finish.push(resolve); fail = reject; }));
    const active = Array.from({ length: 4 }, () => router.run(['google'], 'ordered', work).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
    const queued = router.run(['google', 'microsoft'], 'ordered', work);
    fail(Object.assign(new Error('limited'), { status: 429 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mock.calls.filter(([id]) => id === 'google')).toHaveLength(4);
    expect((await queued).service).toBe('microsoft');
    finish.forEach((resolve) => resolve('old success'));
    await Promise.all(active);
});
it('does not let a late success erase a newer concurrent failure cooldown', async () => {
    const router = new FreeTranslationRouter();
    let complete!: (value: string) => void;
    const first = router.run(['google'], 'ordered', () => new Promise<string>((resolve) => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    await expect(router.run(['google'], 'ordered', async () => { throw new Error('new failure'); })).rejects.toThrow('new failure');
    complete('old success'); await first;
    await expect(router.run(['google'], 'ordered', async () => 'must not run')).rejects.toThrow('cooling down');
});
