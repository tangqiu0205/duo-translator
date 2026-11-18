import { browser } from 'wxt/browser';
import { ACTION } from '@/main/constants';
import { BackgroundRequestError } from '@/utils/message';
import type { TranslateResult } from '@/main/translateClient';

const PORT = 'fluento-page-translation';
export type TranslationProgress = (index: number, result: TranslateResult) => void;
interface Request { service: string; texts: string[]; targetLang: string; sourceLang?: string; scene?: 'subtitle' }
type Runner = (request: Request, signal: AbortSignal, progress: TranslationProgress) => Promise<TranslateResult[] | undefined>;

/** Each port belongs to one caller/frame and one batch; an early disconnect cancels it. */
export function registerTranslationProgress(run: Runner): void {
    browser.runtime.onConnect.addListener(port => {
        if (port.name !== PORT) return;
        const controller = new AbortController();
        let started = false;
        const cancelOnDisconnect = () => controller.abort();
        port.onDisconnect.addListener(cancelOnDisconnect);
        const post = (message: unknown) => {
            if (controller.signal.aborted) return;
            try { port.postMessage(message); } catch { controller.abort(); }
        };
        port.onMessage.addListener((request: Request) => {
            if (started) return;
            started = true;
            if (!request || typeof request.service !== 'string' || typeof request.targetLang !== 'string'
                || !Array.isArray(request.texts) || request.texts.some(text => typeof text !== 'string')) {
                post({ type: 'error', error: { message: 'Invalid page translation request' } });
                return;
            }
            void run(request, controller.signal, (index, result) => post({ type: 'result', index, result }))
                .then(results => {
                    // The client closes the port on `done`. That's not a
                    // cancellation: successful cache writes may still be queued.
                    port.onDisconnect.removeListener(cancelOnDisconnect);
                    post({ type: 'done', results });
                })
                .catch(error => post({ type: 'error', error: {
                    message: error?.message || String(error), name: error?.name,
                    stack: error?.stack, detail: error?.detail, scope: 'Translate texts',
                } }));
        });
    });
}

export function requestTranslationProgress(
    request: Request, signal: AbortSignal | null | undefined, timeout: number, onResult: TranslationProgress,
): Promise<TranslateResult[] | undefined> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const port = browser.runtime.connect({ name: PORT });
        let settled = false;
        const finish = (error?: unknown, results?: TranslateResult[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(heartbeat);
            signal?.removeEventListener('abort', abort);
            port.onMessage.removeListener(message);
            port.onDisconnect.removeListener(disconnect);
            port.disconnect();
            if (error) reject(error); else resolve(results);
        };
        const abort = () => finish(new DOMException('Aborted', 'AbortError'));
        const disconnect = () => finish(new Error('Page translation connection closed before completion'));
        const message = (event: any) => {
            if (settled || signal?.aborted) return;
            if (event?.type === 'result') {
                if (!Number.isInteger(event.index) || event.index < 0 || event.index >= request.texts.length
                    || typeof event.result?.translatedMappedHtmlText !== 'string') {
                    finish(new Error('Invalid page translation progress')); return;
                }
                try { onResult(event.index, event.result); } catch (error) { finish(error); }
            } else if (event?.type === 'done') finish(undefined, event.results);
            else if (event?.type === 'error') finish(new BackgroundRequestError(ACTION.TRANSLATE_TEXTS, event.error));
        };
        const timer = setTimeout(() => finish(new Error(`${ACTION.TRANSLATE_TEXTS} request timeout`)), timeout);
        // Opening a port alone does not keep an MV3 worker alive. Keep the
        // channel active while a slow model is producing its first paragraph.
        const heartbeat = setInterval(() => {
            try { port.postMessage({ type: 'keepalive' }); } catch (error) { finish(error); }
        }, 20_000);
        port.onMessage.addListener(message);
        port.onDisconnect.addListener(disconnect);
        signal?.addEventListener('abort', abort, { once: true });
        try { port.postMessage(request); } catch (error) { finish(error); }
    });
}
