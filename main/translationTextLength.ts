import { DEFAULT_VALUE } from '@/main/constants';

export const MIN_TRANSLATION_TEXT_LENGTH_MIN = 1;
export const MIN_TRANSLATION_TEXT_LENGTH_MAX = 20;

/** Shared by storage reads, imported values, settings and live config updates. */
export function normalizeMinTranslationTextLength(value: unknown): number {
    const parsed = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_VALUE.MIN_TRANSLATION_TEXT_LENGTH;
    return Math.min(MIN_TRANSLATION_TEXT_LENGTH_MAX, Math.max(MIN_TRANSLATION_TEXT_LENGTH_MIN, Math.floor(parsed)));
}

/** Plain source text only: HTML/placeholder markup must never reach this test. */
export function hasMinimumTranslationTextLength(text: string, minimum: number): boolean {
    const normalized = text.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
    let count = 0;
    // Code points, not UTF-16 code units or UTF-8 bytes. Stop as soon as the
    // bounded threshold is met instead of allocating an array for long prose.
    for (const _character of normalized) {
        if (++count >= minimum) return true;
    }
    return false;
}
