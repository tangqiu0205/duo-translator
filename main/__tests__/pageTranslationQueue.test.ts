import { describe, expect, it } from 'vitest';
import { batchPageUnits, PageTranslationQueue } from '@/main/pageTranslationQueue';

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
};

describe('page translation scheduling', () => {
    it('merges short paragraphs into batches of at most four', () => {
        const units = Array.from({ length: 11 }, () => ({ container: {}, text: 'short' }));
        const batches = batchPageUnits(units, u => u.container, u => u.text.length);
        expect(batches.map(batch => batch.length)).toEqual([4, 4, 3]);
        expect(batches.flat()).toEqual(units);
    });
    it('separates long paragraphs without splitting their contents', () => {
        const units = [800, 1800, 100, 5000, 50].map(length => ({ container: {}, text: 'x'.repeat(length) }));
        expect(batchPageUnits(units, u => u.container, u => u.text.length).map(b => b.length)).toEqual([1, 2, 1, 1]);
    });
    it('keeps units sharing a mutation guard together', () => {
        const container = {};
        const units = [{ container, length: 2000 }, { container: {}, length: 300 }, { container, length: 2000 }];
        expect(batchPageUnits(units, u => u.container, u => u.length)).toEqual([[units[0], units[2]], [units[1]]]);
    });
    it('limits concurrency and allows later batches to finish before an earlier slow one', async () => {
        const queue = new PageTranslationQueue(2);
        const slow = deferred(), fast = deferred();
        const started: number[] = [], finished: number[] = [];
        const first = queue.run(async () => { started.push(1); await slow.promise; finished.push(1); }, () => 0);
        const second = queue.run(async () => { started.push(2); await fast.promise; finished.push(2); }, () => 0);
        const third = queue.run(async () => { started.push(3); finished.push(3); }, () => 0);
        await Promise.resolve(); await Promise.resolve();
        expect(started).toEqual([1, 2]);
        fast.resolve();
        await Promise.all([second, third]);
        expect(started).toEqual([1, 2, 3]);
        expect(finished).toEqual([2, 3]);
        slow.resolve(); await first;
        expect(finished).toEqual([2, 3, 1]);
    });
    it('re-evaluates queued priorities when the reader scrolls', async () => {
        const queue = new PageTranslationQueue(1), hold = deferred();
        const first = queue.run(() => hold.promise, () => -1);
        const started: string[] = [];
        let distance = 200;
        const near = queue.run(async () => { started.push('near'); }, () => 100);
        const moved = queue.run(async () => { started.push('moved'); }, () => distance);
        await Promise.resolve(); await Promise.resolve();
        distance = 0; hold.resolve();
        await Promise.all([first, near, moved]);
        expect(started).toEqual(['moved', 'near']);
    });
    it('removes cancelled queued work immediately and never sends it', async () => {
        const queue = new PageTranslationQueue(1), hold = deferred(), controller = new AbortController();
        const active = queue.run(() => hold.promise, () => 0);
        let ran = false;
        const cancelled = queue.run(async () => { ran = true; }, () => 1, controller.signal);
        const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort(); await assertion;
        hold.resolve(); await active;
        expect(ran).toBe(false);
    });
    it('releases slots after failures and refuses pre-cancelled work', async () => {
        const queue = new PageTranslationQueue(1), controller = new AbortController(); controller.abort();
        await expect(queue.run(async () => 1, () => 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        await expect(queue.run(async () => { throw Error('offline'); }, () => 0)).rejects.toThrow('offline');
        await expect(queue.run(async () => 2, () => 0)).resolves.toBe(2);
    });
});
