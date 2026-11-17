// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FreeTranslationDialog } from '@/components/options/FreeTranslationDialog';
import { CONFIG_KEY } from '@/main/constants';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), close: vi.fn(), saved: vi.fn() }));
vi.mock('@/utils/db', () => ({ getConfig: mocks.get, setConfigOrThrow: mocks.save }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback || _key }) }));
let root: Root;
let container: HTMLDivElement;
const button = (name: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === name)!;
const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
const render = async (open = true) => { await act(async () => root.render(<FreeTranslationDialog open={open} onClose={mocks.close} onSaved={mocks.saved} />)); };
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.get.mockReset().mockResolvedValue(undefined);
    mocks.save.mockReset().mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('defaults to four non-login providers and opens without saving or testing connections', async () => {
    await render();
    expect(switches()).toHaveLength(11);
    expect(switches().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
    expect(button('Automatic routing').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Doubao routes use your browser login and are opt-in');
});
it.each(['transmart', 'volcengine', 'lara', 'modernMt'])('requires an explicit opt-in before adding %s to the pool', async (id) => {
    await render();
    const control = document.querySelector<HTMLButtonElement>(`button[aria-label="${id}Translate"]`)!;
    expect(control.getAttribute('aria-checked')).toBe('false');
    await act(async () => control.click());
    await act(async () => button('Save').click());
    expect(mocks.save).toHaveBeenCalledWith(CONFIG_KEY.FREE_TRANSLATION, { mode: 'balanced', services: ['microsoft', 'google', 'yandex', 'bilibili', id] });
});
it('can reorder priorities and persists the selected mode and order as one setting', async () => {
    await render();
    await act(async () => button('Priority order').click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Move up: Google"]')!.click());
    await act(async () => button('Save').click());
    expect(mocks.save).toHaveBeenCalledWith(CONFIG_KEY.FREE_TRANSLATION, { mode: 'ordered', services: ['google', 'microsoft', 'yandex', 'bilibili'] });
    expect(mocks.saved).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
});
it('requires at least one enabled participant before saving', async () => {
    await render();
    for (let i = 0; i < 4; i++) {
        await act(async () => switches().find((item) => item.getAttribute('aria-checked') === 'true')!.click());
    }
    expect(button('Save').disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Select at least one');
    expect(mocks.save).not.toHaveBeenCalled();
});
it('keeps globally disabled providers out of the available selection', async () => {
    mocks.get.mockImplementation(async (key: string) => key === CONFIG_KEY.DISABLED_TRANSLATE_SERVICES ? ['doubao'] : undefined);
    await render();
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="doubaoTranslate"]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Disabled in service settings');
});
it('does not permit saving when the entire selected pool is globally disabled', async () => {
    mocks.get.mockImplementation(async (key: string) => key === CONFIG_KEY.DISABLED_TRANSLATE_SERVICES ? ['microsoft', 'google', 'yandex', 'bilibili'] : undefined);
    await render(); expect(button('Save').disabled).toBe(true);
});
it('retains the draft and exposes a failed save rather than closing successfully', async () => {
    mocks.save.mockRejectedValue(new Error('storage unavailable'));
    await render(); await act(async () => button('Save').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable');
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.saved).not.toHaveBeenCalled();
    expect(button('Save').disabled).toBe(false);
});
it('discards unsaved changes and reloads stored settings on reopen', async () => {
    await render(); await act(async () => button('Priority order').click());
    await render(false); await render();
    expect(button('Automatic routing').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.save).not.toHaveBeenCalled();
});
