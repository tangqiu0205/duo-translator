// Request-time exclusion only. Unknown/mixed language evidence is never a
// reason to hide a paragraph, and provider replies cannot change this verdict.
import { shouldSkipLocalText } from '@/main/localLanguageDetection';

export interface LocalLanguagePartition<T> {
    excluded: T[];
    keep: T[];
}

export async function partitionByLocalLanguage<T>(
    items: T[], textOf: (item: T) => string, excludedLanguages: Set<string>, signal?: AbortSignal,
): Promise<LocalLanguagePartition<T>> {
    if (excludedLanguages.size === 0) return { excluded: [], keep: items };
    const decisions: Array<{ item: T; text: string; skip: boolean }> = [];
    // Sequential within a small batch; the detector also has a frame-wide
    // concurrency budget. Cache hits do not invoke browser detection again.
    for (const item of items) {
        const text = textOf(item);
        decisions.push({ item, text, skip: await shouldSkipLocalText(text, excludedLanguages, signal) });
    }
    const excluded: T[] = [], keep: T[] = [];
    for (const { item, text, skip } of decisions) {
        // Detection is asynchronous: an edited source invalidates its verdict.
        if (textOf(item) === text && skip) excluded.push(item);
        else keep.push(item);
    }
    return { excluded, keep };
}
