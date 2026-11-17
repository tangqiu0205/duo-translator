// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionCard, type SelectionCardProps } from '@/main/aiWriting/SelectionCard';

const mocks = vi.hoisted(() => ({ copy: vi.fn(), toggle: vi.fn() }));
vi.mock('@/main/aiWriting/i18n', () => ({ t: (key: string, fallback: string) => ({
    selectionPopupSectionOriginal: '原文', selectionPopupSectionTranslation: '译文', popupFollowPage: '跟随网页设置',
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
        serviceOptions: [
            { value: 'microsoft', iconId: 'microsoft', isAi: false, label: 'Microsoft' },
            { value: 'google', iconId: 'google', isAi: false, label: 'Google' },
        ], serviceValue: '', onServiceChange: vi.fn(), followServiceLabel: 'Microsoft',
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

it('shows concrete engine/language values, a bundled engine icon and a passive follow-page status', async () => {
    await render(props());
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('跟随网页设置');
    expect(status.closest('button')).toBeNull();
    expect(status.querySelector('button')).toBeNull();
    const engine = container.querySelector('select[aria-label="Translate service"]')!;
    const language = container.querySelector('select[aria-label="Target language"]')!;
    expect(engine.parentElement?.querySelector('span[aria-hidden="true"].truncate')?.textContent).toBe('Microsoft');
    expect(language.parentElement?.querySelector('span[aria-hidden="true"].truncate')?.textContent).toBe('Chinese');
    expect(engine.parentElement?.querySelector('.fluento-selection-engine-icon svg')).not.toBeNull();
    expect(engine.parentElement?.querySelector('img')).toBeNull();
    expect(container.querySelector('svg.lucide-arrow-left-right')?.getAttribute('aria-hidden')).toBe('true');
});

it.each([
    ['microsoft', '', false], ['', 'zh-CN', false], ['google', 'en', false], ['', '', true],
] as const)('hides follow-page status with service=%s, language=%s and multi-service=%s', async (service, language, multi) => {
    const value = props(); value.serviceValue = service; value.langValue = language; value.prefs.multiService = multi;
    await render(value);
    expect(container.querySelector('[role="status"]')).toBeNull();
});

it('retains independent picker callbacks and lets either dropdown restore following', async () => {
    const value = props();
    await render(value);
    const engine = container.querySelector<HTMLSelectElement>('select[aria-label="Translate service"]')!;
    const language = container.querySelector<HTMLSelectElement>('select[aria-label="Target language"]')!;
    await act(async () => {
        engine.value = 'google'; engine.dispatchEvent(new Event('change', { bubbles: true }));
        language.value = 'en'; language.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(value.onServiceChange).toHaveBeenCalledWith('google');
    expect(value.onLangChange).toHaveBeenCalledWith('en');
    value.serviceValue = 'google'; value.langValue = 'en'; await render(value);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
        engine.value = ''; engine.dispatchEvent(new Event('change', { bubbles: true }));
        language.value = ''; language.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(value.onServiceChange).toHaveBeenLastCalledWith('');
    expect(value.onLangChange).toHaveBeenLastCalledWith('');
    value.serviceValue = ''; value.langValue = ''; await render(value);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('跟随网页设置');
});

it('keeps the passive status visible when pickers are tucked into settings', async () => {
    const value = props(); value.prefs.hideHeaderConfig = true;
    await render(value);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('跟随网页设置');
    expect(container.querySelector('select')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click());
    expect(container.querySelector('select[aria-label="Translate service"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Target language"]')).not.toBeNull();
});

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
