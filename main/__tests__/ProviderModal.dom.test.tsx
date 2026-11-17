// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProviderModal } from '@/components/options/ProviderModal';
import { ACTION, STATUS_SUCCESS, STATUS_FAIL } from '@/main/constants';
import { AiProvider, normalizeProvider } from '@/main/aiProvider';

const mocks = vi.hoisted(() => ({ send: vi.fn(), t: (_key: string, fallback?: string, options?: { count: number }) => (fallback ?? _key).replace('{{count}}', String(options?.count)) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.send } } }));
let root: Root;
let container: HTMLDivElement;
const draft = new AiProvider('local', 'custom', 'Local', 'http://localhost:31415/v1/chat/completions', '', '');
const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!;
const render = async (initial = draft) => {
    await act(async () => root.render(<ProviderModal open initial={initial} onClose={() => {}} onSave={() => {}} />));
};
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.send.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('fetches using the unsaved draft with an empty model, then offers the returned model', async () => {
    mocks.send.mockResolvedValue({ status: STATUS_SUCCESS, data: { models: ['auto', 'local-model'] } });
    await render();
    expect(button('Fetch models').disabled).toBe(false);
    await act(async () => button('Fetch models').click());
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ action: ACTION.AI_PROVIDER_MODELS, data: expect.objectContaining({ model: '', apiKey: '' }) }));
    expect(document.querySelectorAll('[role="combobox"]')[1].textContent).toContain('auto');
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Fetched 2 models');
});
it('keeps the current selected model when it is missing from the fetched list', async () => {
    mocks.send.mockResolvedValue({ status: STATUS_SUCCESS, data: { models: ['other'] } });
    await render(normalizeProvider({ ...draft, model: 'auto' }));
    await act(async () => button('Fetch models').click());
    expect(document.querySelectorAll('[role="combobox"]')[1].textContent).toContain('auto');
});
it('pins failures in the dialog while retaining manual entry', async () => {
    mocks.send.mockResolvedValue({ status: STATUS_FAIL, data: { message: 'HTTP 404' } });
    await render();
    await act(async () => button('Fetch models').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404');
    expect(document.querySelector('input[placeholder="model-name"]')).toBeTruthy();
});
it('ignores results from a request for an earlier provider draft', async () => {
    let resolve!: (value: unknown) => void;
    mocks.send.mockReturnValue(new Promise((r) => { resolve = r; }));
    await render();
    await act(async () => button('Fetch models').click());
    expect(button('Fetching...').disabled).toBe(true);
    await render(normalizeProvider({ ...draft, url: 'http://localhost:9999/v1/chat/completions' }));
    await act(async () => resolve({ status: STATUS_SUCCESS, data: { models: ['stale-model'] } }));
    expect(document.body.textContent).not.toContain('stale-model');
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(button('Fetch models').disabled).toBe(false);
    expect(document.querySelector('input[placeholder="model-name"]')).toBeTruthy();
});
