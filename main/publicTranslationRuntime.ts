// BACKGROUND ONLY. Header rules apply only to our background POST requests at
// fixed provider endpoints. Never read cookies or modify arbitrary page traffic.
import { browser } from 'wxt/browser';

import type { WebTranslationService } from '@/main/webTranslationConfig';

type HeaderProvider = 'bilibili' | 'doubao';
export type PublicProvider = HeaderProvider | WebTranslationService;
export class PublicTranslationError extends Error {
    readonly detail: { code: string; provider: PublicProvider; status?: number };
    constructor(provider: PublicProvider, code: string, message: string, status?: number) {
        super(message);
        this.name = 'PublicTranslationError';
        this.detail = { provider, code, ...(status === undefined ? {} : { status }) };
    }
}

export function checkPublicAbort(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError');
}

const headersReady = new Map<HeaderProvider, Promise<void>>();
export async function ensurePublicHeaders(provider: HeaderProvider): Promise<void> {
    let ready = headersReady.get(provider);
    if (!ready) {
        ready = (async () => {
            const api = browser.declarativeNetRequest;
            if (!api?.updateSessionRules) throw new Error(`${provider}: this browser cannot prepare the required request headers`);
            const id = provider === 'bilibili' ? 6001 : 6002;
            const condition = {
                regexFilter: provider === 'bilibili'
                    ? '^https://index-translate\\.bilibili\\.com/v1/chat/completions(?:\\?|$)'
                    : '^https://www\\.doubao\\.com/(?:alice/user/launch|samantha/plugin/(?:stream_article_translate|translate))(?:\\?|$)',
                initiatorDomains: [new URL(browser.runtime.getURL('/')).hostname],
                requestMethods: ['post' as const], resourceTypes: ['xmlhttprequest' as const], tabIds: [-1],
            };
            await api.updateSessionRules({
                removeRuleIds: [id],
                addRules: [{
                    id, priority: 1, condition,
                    action: { type: 'modifyHeaders', requestHeaders: [provider === 'bilibili'
                        ? { header: 'origin', operation: 'remove' }
                        : { header: 'origin', operation: 'set', value: 'chrome-extension://dbjibobgilijgolhjdcbdebjhejelffo' }] },
                }],
            });
        })();
        headersReady.set(provider, ready);
    }
    try { await ready; } catch (error) {
        // A failed setup must remain retryable instead of poisoning this worker.
        if (headersReady.get(provider) === ready) headersReady.delete(provider);
        throw error;
    }
}

interface Job {
    signal?: AbortSignal | null;
    cancel: () => void;
    start: () => void;
}

/** Rolling request budget shared across all tabs, including queued cancellation. */
export class PublicRequestLimiter {
    private active = 0;
    private starts: number[] = [];
    private waiting: Job[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    constructor(private limit = 3, private interval = 1000, private concurrency = 2) { }

    run<T>(work: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
        try { checkPublicAbort(signal); } catch (error) { return Promise.reject(error); }
        return new Promise<T>((resolve, reject) => {
            const job: Job = {
                signal,
                cancel: () => {
                    const index = this.waiting.indexOf(job);
                    if (index < 0) return;
                    this.waiting.splice(index, 1);
                    signal?.removeEventListener('abort', job.cancel);
                    reject(new DOMException('Translation cancelled', 'AbortError'));
                    this.pump();
                },
                start: () => {
                    signal?.removeEventListener('abort', job.cancel);
                    this.active++;
                    this.starts.push(Date.now());
                    void Promise.resolve().then(() => { checkPublicAbort(signal); return work(); })
                        .then(resolve, reject).finally(() => { this.active--; this.pump(); });
                },
            };
            this.waiting.push(job);
            signal?.addEventListener('abort', job.cancel, { once: true });
            this.pump();
        });
    }
    private pump(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const now = Date.now();
        this.starts = this.starts.filter((time) => time > now - this.interval);
        while (this.waiting.length && this.active < this.concurrency) {
            if (this.starts.length >= this.limit) {
                this.timer = setTimeout(() => this.pump(), Math.max(1, this.starts[0] + this.interval - Date.now()));
                return;
            }
            this.waiting.shift()!.start();
        }
    }
}
