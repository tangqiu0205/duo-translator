import { describe, expect, it } from 'vitest';
import { CONFIG_KEY, DEFAULT_VALUE } from '@/main/constants';
import { hasMinimumTranslationTextLength, normalizeMinTranslationTextLength } from '@/main/translationTextLength';

describe('minimum webpage translation length', () => {
    it('defaults to two characters and registers a persistent config key', () => {
        expect(CONFIG_KEY.MIN_TRANSLATION_TEXT_LENGTH).toBe('minTranslationTextLength');
        expect(DEFAULT_VALUE.MIN_TRANSLATION_TEXT_LENGTH).toBe(2);
    });
    it.each([undefined, null, '', ' ', 'invalid', NaN, Infinity, -Infinity, {}, [], true])('uses the default for invalid config %s', value => {
        expect(normalizeMinTranslationTextLength(value)).toBe(2);
    });
    it.each([[0, 1], [-5, 1], [1, 1], [5, 5], [20, 20], [999, 20], ['5', 5], [4.8, 4]])('normalizes %s to %s', (value, expected) => {
        expect(normalizeMinTranslationTextLength(value)).toBe(expected);
    });
    it.each([
        ['A', 2, false], ['ab', 2, true], ['book', 5, false], ['hello', 5, true],
        ['字', 2, false], ['中文', 2, true], ['😀', 2, false], ['😀a', 2, true],
        ['  book\n', 5, false], ['a\n\t b', 3, true], ['a\n\t b', 4, false],
        ['a\u200bb', 3, false], ['\u200b', 1, false], ['', 1, false], [' \n\t', 1, false],
        ['x', 1, true], ['hello world', 5, true], ['x'.repeat(50_000), 20, true],
    ])('checks normalized source text %j at minimum %s', (text, minimum, expected) => {
        expect(hasMinimumTranslationTextLength(text, minimum)).toBe(expected);
    });
});
