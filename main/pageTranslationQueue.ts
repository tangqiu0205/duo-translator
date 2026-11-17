// A frame-wide budget: scrolling must not create an unbounded provider queue.
export class PageTranslationQueue {
    private active = 0;
    private scheduled = false;
    private jobs: Array<{ priority: () => number; start: () => void }> = [];

    constructor(private readonly concurrency = 2) {}

    run<T>(work: () => Promise<T>, priority: () => number, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const abort = () => {
                const index = this.jobs.indexOf(job);
                if (index < 0) return; // Running work owns its cancellation.
                this.jobs.splice(index, 1);
                signal?.removeEventListener('abort', abort);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const job = { priority, start: () => {
                signal?.removeEventListener('abort', abort);
                this.active++;
                void Promise.resolve().then(work).then(resolve, reject).finally(() => {
                    this.active--;
                    this.pump();
                });
            } };
            if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
            this.jobs.push(job);
            signal?.addEventListener('abort', abort, { once: true });
            if (!this.scheduled) {
                this.scheduled = true;
                queueMicrotask(() => { this.scheduled = false; this.pump(); });
            }
        });
    }

    private pump() {
        while (this.active < this.concurrency && this.jobs.length) {
            // Re-evaluate viewport proximity when a slot opens, not just when
            // the page was scanned: the reader may have scrolled meanwhile.
            this.jobs.sort((a, b) => a.priority() - b.priority());
            this.jobs.shift()!.start();
        }
    }
}

/** Keep a container's units together: mutation guards are container-scoped. */
export function batchPageUnits<T>(items: T[], containerOf: (item: T) => object, lengthOf: (item: T) => number): T[][] {
    const groups = new Map<object, T[]>();
    for (const item of items) {
        const key = containerOf(item);
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
    }
    const batches: T[][] = [];
    let batch: T[] = [], chars = 0;
    for (const group of groups.values()) {
        const size = group.reduce((sum, item) => sum + lengthOf(item), 0);
        if (batch.length && (batch.length + group.length > 4 || chars + size > 2400)) {
            batches.push(batch); batch = []; chars = 0;
        }
        batch.push(...group); chars += size;
    }
    if (batch.length) batches.push(batch);
    return batches;
}
