// BACKGROUND ONLY. Bounded sequential failover; never broadcasts text to race providers.
import type { FreeTranslationProvider, FreeTranslationSettings } from '@/main/freeTranslationConfig';
import { isDoubaoService } from '@/main/publicTranslationConfig';
import { checkPublicAbort, PublicRequestLimiter } from '@/main/publicTranslationRuntime';

interface Health { failures: number; retryAt: number; latency: number; active: number; revision: number }
const family = (id: string) => isDoubaoService(id) ? 'doubao' : id;

function failureStatus(error: unknown): number | undefined {
    const value = error as { status?: number; detail?: { status?: number } } | null;
    return value?.detail?.status ?? value?.status;
}
function cooldown(error: unknown, failures: number): number {
    const status = failureStatus(error);
    const code = (error as { detail?: { code?: string } } | null)?.detail?.code;
    if (status === 400 || status === 422) return 0; // This language/text, not a broken service.
    const base = status === 429 || code === 'rate-limit' ? 120_000
        : [401, 403, 404, 410, 412].includes(status || 0) || code === 'auth' || code === 'waf-blocked' ? 300_000 : 30_000;
    return Math.min(600_000, base * 2 ** Math.min(4, failures));
}

/** Reject promptly on cancellation even if a provider is slow to settle. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason || new DOMException('Translation cancelled', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
}

export class FreeTranslationRouter {
    private readonly health = new Map<string, Health>();
    // Real work retains its slot until it settles, even after caller timeout.
    private readonly limiter = new PublicRequestLimiter(6, 1000, 4);
    constructor(private readonly random = Math.random, private readonly attemptMs = 30_000, private readonly totalMs = 110_000) { }
    private state(id: string): Health {
        const key = family(id);
        let state = this.health.get(key);
        if (!state) {
            state = { failures: 0, retryAt: 0, latency: 1000, active: 0, revision: 0 };
            this.health.set(key, state);
        }
        return state;
    }
    private choose(candidates: FreeTranslationProvider[], mode: FreeTranslationSettings['mode']): FreeTranslationProvider {
        if (mode === 'ordered') return candidates[0];
        const weights = candidates.map((id) => {
            const state = this.state(id);
            const siblings = candidates.filter((other) => family(other) === family(id)).length;
            return 1 / (Math.max(500, state.latency) * (state.failures + 1) * (state.active + 1) * siblings);
        });
        let position = this.random() * weights.reduce((sum, weight) => sum + weight, 0);
        for (let i = 0; i < candidates.length; i++) {
            position -= weights[i];
            if (position < 0) return candidates[i];
        }
        return candidates[candidates.length - 1];
    }
    async run<T>(
        candidates: FreeTranslationProvider[], mode: FreeTranslationSettings['mode'],
        work: (id: FreeTranslationProvider, signal: AbortSignal) => Promise<T>, signal?: AbortSignal | null,
    ): Promise<{ service: FreeTranslationProvider; value: T }> {
        checkPublicAbort(signal);
        if (!candidates.length) throw new Error('No eligible free translation services. Check participating services, enabled services and language support.');
        const deadline = Date.now() + this.totalMs;
        const attempted = new Set<string>();
        const failures: string[] = [];
        while (Date.now() < deadline) {
            checkPublicAbort(signal);
            const ready = candidates.filter((id) => !attempted.has(id) && this.state(id).retryAt <= Date.now());
            if (!ready.length) break;
            const id = this.choose(ready, mode);
            attempted.add(id);
            const state = this.state(id);
            const revision = state.revision;
            let failureRecorded = false;
            const recordFailure = (error: unknown) => {
                if (failureRecorded || signal?.aborted) return;
                failureRecorded = true;
                const delay = cooldown(error, state.failures);
                if (delay && state.revision === revision) {
                    state.retryAt = Date.now() + delay;
                    state.failures++;
                    state.revision++;
                }
            };
            const controller = new AbortController();
            const cancel = () => controller.abort(signal?.reason || new DOMException('Translation cancelled', 'AbortError'));
            signal?.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException('Free translation attempt timed out', 'TimeoutError')),
                Math.min(this.attemptMs, deadline - Date.now()));
            const started = Date.now();
            try {
                const pending = this.limiter.run(async () => {
                    if (state.retryAt > Date.now()) throw new Error('Service entered cooldown while waiting');
                    state.active++;
                    try { return await work(id, controller.signal); }
                    catch (error) {
                        // Publish health before releasing capacity to queued callers.
                        recordFailure(error);
                        throw error;
                    } finally { state.active--; }
                }, controller.signal);
                const value = await abortable(pending, controller.signal);
                checkPublicAbort(signal);
                if (state.revision === revision) {
                    state.failures = 0;
                    state.retryAt = 0;
                    state.revision++;
                }
                state.latency = state.latency * 0.75 + Math.max(1, Date.now() - started) * 0.25;
                return { service: id, value };
            } catch (error) {
                checkPublicAbort(signal);
                recordFailure(error);
                const reason = error instanceof Error ? error.message : String(error);
                failures.push(`${id}: ${reason.slice(0, 300)}`);
                console.warn('Free translation route failed', id, reason.slice(0, 300));
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                controller.abort();
            }
        }
        throw new Error(`Free translation unavailable: ${failures.join('; ') || 'participating services are cooling down; retry later'}`);
    }
}
