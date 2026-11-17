// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionCard, type SelectionCardProps } from '@/main/aiWriting/SelectionCard';

const mocks = vi.hoisted(() => ({ copy: vi.fn(), toggle: vi.fn() }));
vi.mock('@/main/aiWriting/i18n', () => ({ t: (key: string, fallback: string) => ({
    selectionPopupSectionOriginal: '原文', selectionPopupSectionTranslation: '译文',
} as Record<string, string>)[key] ?? fallback }));
vi.mock('@/main/aiWriting/useCopyFeedback', () => ({ useCopyFeedback: () => [false, mocks.copy] }));

let root: Root;
let container: HTMLDivElement;
function props(): SelectionCardProps {
    return {
        prefs: { multiService: false, services: [], dict: false, dictExamples: false,
            showOriginal: true, originalTts: true, originalCopy: true,
            translationTts: true, translationCopy: true, hideHeaderConfig: false },
        origText: 'Your First API Call', origLang: 'en', origExpanded: false, onToggleOrigExpanded: vi.fn(),
        runs: [{ key: 'microsoft', label: 'Microsoft', output: '你的首次 API 调用', running: false, error: null }],
        targetLang: 'zh-CN', dictEntry: null, dictLoading: false, dictError: null,
        serviceOptions: [], serviceValue: '', onServiceChange: vi.fn(), followServiceLabel: 'Microsoft',
        selectedServices: ['microsoft'], onToggleService: vi.fn(), langValue: '', onLangChange: vi.fn(),
        followLangLabel: 'Chinese', pinned: false, onTogglePin: vi.fn(), onClose: vi.fn(),
        tts: { playingKey: null, toggle: mocks.toggle } as unknown as SelectionCardProps['tts'], cardWidth: 460,
    };
}
async function render(value: SelectionCardProps) {
    await act(async () => root.render(<SelectionCard {...value} />));
}
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('labels source and translation without including labels in copy or speech', async () => {
    await render(props());
    expect(container.querySelector('[data-kind="original"]')?.textContent).toBe('原文');
    expect(container.querySelector('[data-kind="translation"]')?.textContent).toBe('译文');
    const copies = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy"]');
    await act(async () => { copies[0].click(); copies[1].click(); });
    expect(mocks.copy.mock.calls).toEqual([['Your First API Call'], ['你的首次 API 调用']]);
    const speech = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Play"]');
    await act(async () => { speech[0].click(); speech[1].click(); });
    expect(mocks.toggle.mock.calls).toEqual([
        ['orig', 'Your First API Call', 'en'], ['trans:microsoft', '你的首次 API 调用', 'zh-CN'],
    ]);
});

it('hides the source badge together with the original block', async () => {
    const value = props(); value.prefs.showOriginal = false;
    await render(value);
    expect(container.querySelector('[data-kind="original"]')).toBeNull();
    expect(container.querySelector('[data-kind="translation"]')).not.toBeNull();
});

it('retains badges for long text and preserves the original expansion toggle', async () => {
    const value = props(); value.origText = 'First line\nSecond line'; value.runs[0].output = '第一行\n第二行';
    await render(value);
    expect(container.querySelectorAll('.fluento-selection-label')).toHaveLength(2);
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await act(async () => expand.click());
    expect(value.onToggleOrigExpanded).toHaveBeenCalledTimes(1);
});

it('labels each service result while preserving provider names, loading and errors', async () => {
    const value = props(); value.prefs.multiService = true;
    value.runs = [
        { key: 'microsoft', label: 'Microsoft', output: '', running: true, error: null },
        { key: 'google', label: 'Google', output: '', running: false, error: 'Request failed' },
    ];
    await render(value);
    expect(container.querySelectorAll('[data-kind="translation"]')).toHaveLength(2);
    for (const text of ['Microsoft', 'Google', 'Streaming...', 'Request failed']) expect(container.textContent).toContain(text);
});
