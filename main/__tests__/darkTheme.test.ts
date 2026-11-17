import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const paths = ['entrypoints/popup/popup.css', 'entrypoints/options/options.css', 'main/aiWriting/aiWriting.css'];
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
function tokens(path: string): Record<string, string> {
    const block = read(path).match(/@theme\s*\{([\s\S]*?)\}/)![1];
    return Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
function channels(hex: string): number[] {
    expect(hex).toMatch(/^#[\da-f]{6}$/i);
    return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
function luminance(hex: string): number {
    const linear = channels(hex).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first: string, second: string): number {
    const a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it('uses matching neutral charcoal surfaces across popup, settings and in-page panels', () => {
    for (const path of paths) {
        const theme = tokens(path);
        expect(theme.bg).toBe('#141414');
        expect(theme.surface).toBe('#1c1c1c');
        expect(theme['surface-2']).toBe('#242424');
        expect(theme.accent).toBe('#79c4ae');
        for (const name of ['bg', 'surface', 'surface-2', 'ink', 'ink-soft', 'ink-mute']) {
            const rgb = channels(theme[name]);
            expect(Math.max(...rgb) - Math.min(...rgb), path + ':' + name).toBe(0);
        }
    }
});
it('keeps text and primary button contrast readable on the dark surfaces', () => {
    for (const path of paths) {
        const theme = tokens(path);
        for (const background of ['bg', 'surface', 'surface-2']) {
            for (const foreground of ['ink', 'ink-soft', 'ink-mute']) {
                expect(contrast(theme[foreground], theme[background]), path + ':' + foreground).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(contrast(theme['accent-ink'], theme.accent)).toBeGreaterThanOrEqual(4.5);
    }
});
it('removes the blue settings-page backdrop and retains the existing light-theme palette', () => {
    const settings = read(paths[1]);
    const body = settings.match(/html,\s*body\s*\{([\s\S]*?)\}/)![1];
    expect(body).toContain('background: var(--color-bg);');
    expect(body).not.toContain('radial-gradient');
    expect(read(paths[0]).split('html[data-theme="light"]')[1]).toContain('--color-bg: #f3f7fc;');
    expect(settings.split('html[data-theme="light"]')[1]).toContain('--color-bg: #f4f5f9;');
    expect(read(paths[2]).split('.fluento-ai-root[data-theme="light"] {')[1]).toContain('--color-bg: #f3f5fa;');
});
