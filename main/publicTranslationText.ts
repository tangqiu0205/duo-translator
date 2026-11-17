// Worker-safe mapped HTML handling. Public models see readable text, while
// callers always receive escaped output with the DOM's <bN> markers intact.
import { placeholdersPreserved, stripPlaceholders } from '@/main/builtinAi/placeholders';
import { checkPublicAbort } from '@/main/publicTranslationRuntime';

export interface PublicTranslation { text: string; sourceLang: string }
type Translate = (texts: string[]) => Promise<PublicTranslation[]>;
export { decode as decodePublicTranslationText, escapeMapped as escapePublicTranslationHtml };
const TAG = /^<\/?b\d+>$/;

function decode(text: string): string {
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
        const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
        if (entity[0] !== '#') return named[entity.toLowerCase()] ?? all;
        const value = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : all;
    });
}
function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeMapped(text: string): string {
    return text.split(/(<\/?b\d+>)/g).map((part) => TAG.test(part) ? part : escape(part)).join('');
}
function assertResults(results: PublicTranslation[], count: number): void {
    if (!Array.isArray(results) || results.length !== count || results.some((item) => !item || typeof item.text !== 'string' || !item.text.trim())) {
        throw new Error('Public translation service returned an incomplete translation batch');
    }
}

export async function translatePublicMapped(
    texts: string[], translate: Translate, signal?: AbortSignal | null,
): Promise<PublicTranslation[]> {
    checkPublicAbort(signal);
    const output = texts.map((text) => ({ text, sourceLang: '' }));
    const active = texts.map((text, index) => ({ index, query: decode(text) }))
        .filter(({ query }) => stripPlaceholders(query).trim());
    if (!active.length) return output;
    const translated = await translate(active.map(({ query }) => query));
    assertResults(translated, active.length);
    checkPublicAbort(signal);
    const repairs: { index: number; parts: string[]; slots: number[] }[] = [];
    active.forEach(({ index }, position) => {
        const item = translated[position];
        const normalized = item.text.replace(/<\s*(\/?)\s*b\s*(\d+)\s*>/g, '<$1b$2>');
        if (!/<\/?b\d+>/.test(texts[index])) {
            output[index] = { text: escape(item.text), sourceLang: item.sourceLang };
            return;
        }
        if (placeholdersPreserved(texts[index], normalized)) {
            output[index] = { text: escapeMapped(normalized), sourceLang: item.sourceLang };
            return;
        }
        const parts = texts[index].split(/(<\/?b\d+>)/g);
        const slots = parts.flatMap((part, slot) => !TAG.test(part) && part.trim() ? [slot] : []);
        repairs.push({ index, parts, slots });
        output[index].sourceLang = item.sourceLang;
    });
    if (repairs.length) {
        // Retry only spans whose markup was lost, preserving the element map
        // locally instead of silently dropping links/emphasis from the page.
        console.warn(`Public translation: repairing inline markup in ${repairs.length} paragraph(s)`);
        const queries = repairs.flatMap(({ parts, slots }) => slots.map((slot) => decode(parts[slot]).trim()));
        const repaired = await translate(queries);
        assertResults(repaired, queries.length);
        let next = 0;
        for (const { index, parts, slots } of repairs) {
            const pieces = parts.map((part) => TAG.test(part) ? part : escape(decode(part)));
            for (const slot of slots) {
                const original = decode(parts[slot]);
                const before = original.match(/^\s*/)?.[0] || '';
                const after = original.match(/\s*$/)?.[0] || '';
                pieces[slot] = escape(before + repaired[next++].text.trim() + after);
            }
            output[index].text = pieces.join('');
        }
    }
    checkPublicAbort(signal);
    return output;
}
