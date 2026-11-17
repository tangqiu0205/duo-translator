import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
    const event = () => {
        const listeners = new Set<(...args: any[]) => void>();
        return { listeners, addListener: (fn: (...args: any[]) => void) => listeners.add(fn),
            removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
            emit: (...args: any[]) => { for (const fn of [...listeners]) fn(...args); } };
    };
    const onConnect = event();
    let client: any, server: any;
    const connect = vi.fn(({ name }: { name: string }) => {
        let disconnected = false;
        client = { name, onMessage: event(), onDisconnect: event(),
            postMessage: (message: any) => queueMicrotask(() => { if (!disconnected) server.onMessage.emit(message); }),
            disconnect: vi.fn(() => { if (disconnected) return; disconnected = true; server.onDisconnect.emit(); }) };
        server = { name, onMessage: event(), onDisconnect: event(),
            postMessage: (message: any) => queueMicrotask(() => { if (!disconnected) client.onMessage.emit(message); }),
            disconnect: () => { if (disconnected) return; disconnected = true; client.onDisconnect.emit(); } };
        onConnect.emit(server);
        return client;
    });
    return { onConnect, connect, client: () => client, server: () => server };
});
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: mock.connect, onConnect: mock.onConnect } } }));
import { registerTranslationProgress, requestTranslationProgress } from '@/main/translationProgress';
import type { TranslateResult } from '@/main/translateClient';
const result = (text: string) => ({ translatedMappedHtmlText: text, sourceLang: 'en', score: 1 }) as TranslateResult;
const request = { service: 'doubao', texts: ['one', 'two'], targetLang: 'zh-CN' };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => { mock.onConnect.listeners.clear(); mock.connect.mockClear(); });
afterEach(() => vi.useRealTimers());

describe('page translation progress transport', () => {
    it('delivers complete paragraphs before the whole batch finishes, scoped to one port', async () => {
        let finish!: (results: TranslateResult[]) => void;
        registerTranslationProgress(async (_request, _signal, progress) => {
            progress(1, result('第二段'));
            return new Promise(resolve => { finish = resolve; });
        });
        const progress = vi.fn();
        const pending = requestTranslationProgress(request, undefined, 1000, progress);
        await tick();
        expect(progress).toHaveBeenCalledWith(1, result('第二段'));
        expect(mock.client().disconnect).not.toHaveBeenCalled();
        finish([result('第一段'), result('第二段')]);
        await expect(pending).resolves.toHaveLength(2);
        expect(mock.client().onMessage.listeners.size).toBe(0);
        expect(mock.client().onDisconnect.listeners.size).toBe(0);
    });
    it('disconnects and cancels the upstream work on abort', async () => {
        let upstream!: AbortSignal;
        registerTranslationProgress(async (_request, signal) => { upstream = signal; return new Promise(() => {}); });
        const controller = new AbortController(), progress = vi.fn();
        const pending = requestTranslationProgress(request, controller.signal, 1000, progress);
        const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await tick(); controller.abort(); await assertion;
        expect(upstream.aborted).toBe(true);
        mock.client().onMessage.emit({ type: 'result', index: 0, result: result('late') });
        expect(progress).not.toHaveBeenCalled();
    });
    it('times out explicitly, cancelling the upstream work', async () => {
        vi.useFakeTimers();
        let upstream!: AbortSignal;
        registerTranslationProgress(async (_request, signal) => { upstream = signal; return new Promise(() => {}); });
        const pending = requestTranslationProgress(request, undefined, 20, vi.fn());
        const assertion = expect(pending).rejects.toThrow('request timeout');
        await tick(); await vi.advanceTimersByTimeAsync(20); await assertion;
        expect(upstream.aborted).toBe(true);
    });
    it('preserves provider failure details after delivering an earlier paragraph', async () => {
        registerTranslationProgress(async (_request, _signal, progress) => {
            progress(0, result('第一段'));
            throw Object.assign(Error('rate limited'), { detail: { code: 'rate-limit' } });
        });
        const progress = vi.fn();
        await expect(requestTranslationProgress(request, undefined, 1000, progress))
            .rejects.toMatchObject({ message: 'rate limited', detail: { code: 'rate-limit' } });
        expect(progress).toHaveBeenCalledTimes(1);
    });
    it('rejects unexpected disconnects instead of silently succeeding', async () => {
        registerTranslationProgress(async () => new Promise(() => {}));
        const pending = requestTranslationProgress(request, undefined, 1000, vi.fn());
        const assertion = expect(pending).rejects.toThrow('closed before completion');
        mock.server().disconnect(); await assertion;
    });
    it('rejects invalid progress indices', async () => {
        registerTranslationProgress(async (_request, _signal, progress) => { progress(4, result('wrong')); return []; });
        await expect(requestTranslationProgress(request, undefined, 1000, vi.fn())).rejects.toThrow('Invalid page translation progress');
    });
    it('refuses pre-aborted calls without opening a connection', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(requestTranslationProgress(request, controller.signal, 1000, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
        expect(mock.connect).not.toHaveBeenCalled();
    });
    it('does not run the same request twice if the port receives duplicate start messages', async () => {
        const run = vi.fn(async () => new Promise<TranslateResult[]>(() => {}));
        registerTranslationProgress(run);
        const controller = new AbortController();
        const pending = requestTranslationProgress(request, controller.signal, 1000, vi.fn());
        const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        mock.client().postMessage(request);
        await tick(); expect(run).toHaveBeenCalledTimes(1);
        controller.abort(); await assertion;
    });
});
