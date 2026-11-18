// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '@/entrypoints/popup/App';
import { CONFIG_KEY, DB_ACTION, DEFAULT_STRATEGY, TAB_ACTION, VIEW_STRATEGY } from '@/main/constants';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  ui: { theme: true, help: true, globalSwitch: true, defaultStrategy: true, alwaysTranslateSite: true, neverTranslateSite: true, bilingualHighlight: true, aiWriting: true },
  services: [
    { value: 'microsoft', label: 'Microsoft', iconId: 'microsoft', isAi: false },
    { value: 'google', label: 'Google', iconId: 'google', isAi: false },
  ],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { getManifest: () => ({ version: '1.0.1' }), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }, tabs: { create: vi.fn() } } }));
vi.mock('@/utils/message', () => ({ sendMessageToBackground: mocks.send, sendMessageToTab: vi.fn(async () => {}), sendMessageToAllTabs: vi.fn(async () => {}) }));
vi.mock('@/utils/popupPrefs', () => ({ usePopupPrefs: () => mocks.ui, loadPopupPrefs: async () => mocks.ui }));
vi.mock('@/utils/theme', () => ({ useThemeSetting: () => 'light', useResolvedTheme: () => 'light', THEME_OPTIONS: [] }));
vi.mock('@/utils/service', () => ({
  buildServiceOptions: () => mocks.services,
  resolveActiveService: (value?: string) => value || 'microsoft',
  getTranslateService: async () => ({ activeService: 'microsoft', enabledTranslateServices: [], enabledAiProviders: [], aiUsedForTranslatePage: false }),
  getAiTranslateService: async () => ({ activeService: 'microsoft', enabledTranslateServices: [], enabledAiProviders: [] }),
}));
vi.mock('@/entrypoints/popup/ManualTranslator', () => ({ ManualTranslator: () => null }));
// Use native selects to verify real change handlers without Radix layout APIs.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: any) => <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{typeof children === 'string' ? children : value}</option>,
}));

let root: Root;
let container: HTMLDivElement;
const advanced = () => container.querySelector<HTMLButtonElement>('button[aria-controls="popup-page-settings"]')!;
const serviceSection = () => container.querySelector<HTMLElement>('section[aria-label="Other translation services"]')!;
const choose = async (index: number, value: string) => {
  await act(async () => {
    const select = serviceSection().querySelectorAll('select')[index];
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null });
  mocks.send.mockReset().mockImplementation(async (message) => {
    if (message.action === DB_ACTION.CONFIG_GET) return ({
      [CONFIG_KEY.GLOBAL_SWITCH]: true,
      [CONFIG_KEY.VIEW_STRATEGY]: VIEW_STRATEGY.DOUBLE,
      [CONFIG_KEY.TARGET_LANGUAGE]: 'zh-CN',
      [CONFIG_KEY.TRANSLATE_SERVICE]: 'microsoft',
      [CONFIG_KEY.DEFAULT_STRATEGY]: DEFAULT_STRATEGY.AUTO,
      [CONFIG_KEY.BILINGUAL_HIGHLIGHTING_SWITCH]: true,
      [CONFIG_KEY.SELECTION_TRANSLATE_SERVICE]: '',
      [CONFIG_KEY.AI_TRANSLATE_SERVICE]: 'microsoft',
      [CONFIG_KEY.VIDEO_SUBTITLE_TRANSLATE_SERVICE]: 'microsoft',
    } as Record<string, unknown>)[message.data.name];
    if (message.action === TAB_ACTION.TAB_DOMAIN_GET) return 'example.com';
    if (message.action === TAB_ACTION.ID_GET) return 1;
    return {};
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App embedded />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('shows the Fluento brand and loads the logo without depending on storage identity variables', () => {
  const header = container.querySelector('.popup-header')!;
  expect(header.textContent).toContain('Fluento');
  expect(header.querySelector('img')?.getAttribute('src')).toBe('/Fluento.svg');
});

it('shows all three service pickers inline under an icon heading, without a summary popup', async () => {
  expect(advanced().getAttribute('aria-expanded')).toBe('false');
  await act(async () => advanced().click());
  const section = serviceSection();
  expect(section.querySelector('h3 svg')).toBeTruthy();
  expect(section.textContent).toContain('Selection translation');
  expect(section.textContent).toContain('Translate input box (AI Writing)');
  expect(section.textContent).toContain('Video subtitles');
  expect(section.querySelectorAll('select')).toHaveLength(3);
  expect(section.querySelector('button')).toBeNull();
  expect(container.querySelector('[class*="backdrop-blur"]')).toBeNull();
});

it('keeps each service setting independent and preserves the follow-page option', async () => {
  await act(async () => advanced().click());
  expect(serviceSection().querySelectorAll('select')[0].value).toBe('__follow__');
  await choose(0, 'google');
  await choose(1, 'google');
  await choose(2, 'google');
  await choose(0, '__follow__');
  const writes = mocks.send.mock.calls.map(([message]) => message).filter((message) => message.action === DB_ACTION.CONFIG_SET);
  expect(writes.map((message) => message.data)).toEqual([
    { name: CONFIG_KEY.SELECTION_TRANSLATE_SERVICE, value: 'google' },
    { name: CONFIG_KEY.AI_TRANSLATE_SERVICE, value: 'google' },
    { name: CONFIG_KEY.VIDEO_SUBTITLE_TRANSLATE_SERVICE, value: 'google' },
    { name: CONFIG_KEY.SELECTION_TRANSLATE_SERVICE, value: '' },
  ]);
  await act(async () => advanced().click());
  await act(async () => advanced().click());
  expect(serviceSection().querySelectorAll('select')[1].value).toBe('google');
});
