// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManualTranslator } from '@/entrypoints/popup/ManualTranslator';
import { emptyManualDraft, MANUAL_DRAFT_KEY, MANUAL_TEXT_LIMIT, prepareManualText, readManualDraft, readManualText } from '@/entrypoints/popup/manualTranslation';
import { TRANSLATE_SERVICE } from '@/main/constants';

const mocks = vi.hoisted(() => ({ translate: vi.fn(), toggle: vi.fn(), stop: vi.fn(), success: vi.fn(), copy: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) }));
vi.mock('@/main/translateClient', () => ({ translateTexts: mocks.translate }));
vi.mock('@/main/aiWriting/useTts', () => ({ useTts: () => ({ playingKey: null, toggle: mocks.toggle, stop: mocks.stop }) }));
// Native selects exercise the state transitions without depending on Radix's
// pointer capture / layout APIs (not implemented by jsdom).
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, disabled, onValueChange }: any) => <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{typeof children === 'string' ? children : value}</option>,
}));

let root: Root;
let container: HTMLDivElement;
const services = [
  { value: 'microsoft', label: 'Microsoft', iconId: 'microsoft', isAi: false },
  { value: 'google', label: 'Google', iconId: 'google', isAi: false },
  { value: 'ai:one', label: 'AI', iconId: 'openai', isAi: true },
  { value: 'doubao', label: 'Doubao', iconId: 'doubao', isAi: false },
  { value: 'freeAuto', label: 'Free translation', iconId: 'freeAuto', isAi: false },
];
const button = (text: string) => Array.from(container.querySelectorAll('button')).find((element) => element.textContent === text)!;
const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const render = async (embedded = false, page?: { target: string; service: string }) => {
  await act(async () => root.render(<ManualTranslator services={services} defaultService="microsoft" embedded={embedded} onSuccess={mocks.success} pageTargetLanguage={page?.target} pageService={page?.service} />));
};
const input = async (text: string) => {
  await act(async () => {
    const textarea = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const choose = async (index: number, value: string) => {
  await act(async () => {
    const select = container.querySelectorAll('select')[index];
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
    clear: () => saved.clear(),
  });
  vi.clearAllMocks();
  mocks.translate.mockReset();
  mocks.copy.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('starts with an empty, disabled translator and independent Chinese target', async () => {
  await render();
  expect(button('Translate').disabled).toBe(true);
  expect(container.querySelectorAll('select')[1].value).toBe('zh-CN');
  expect(container.querySelector('textarea')?.maxLength).toBe(MANUAL_TEXT_LIMIT);
});

it('translates with explicit languages via Ctrl+Enter and exposes copy, speech and expansion', async () => {
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: 'How is the performance of this project?', sourceLang: 'zh-CN' }]);
  await render();
  await choose(0, 'zh-CN');
  await choose(1, 'en');
  await input('这个项目的性能表现如何？');
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
  expect(mocks.translate).toHaveBeenCalledWith('microsoft', ['这个项目的性能表现如何？'], 'en', expect.any(AbortSignal), 'zh-CN');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('How is the performance of this project?');
  expect(mocks.success).toHaveBeenCalledTimes(1);
  expect(button('Original').getAttribute('aria-expanded')).toBe('false');
  expect([...container.querySelectorAll('p')].some((element) => element.textContent === '这个项目的性能表现如何？')).toBe(false);
  await act(async () => byLabel('Copy translation').click());
  expect(mocks.copy).toHaveBeenCalledWith('How is the performance of this project?');
  expect(container.textContent).toContain('Copied');
  await act(async () => byLabel('Read original').click());
  expect(mocks.toggle).toHaveBeenCalledWith('original', '这个项目的性能表现如何？', 'zh-CN');
  await act(async () => byLabel('Expand translation').click());
  expect(byLabel('Collapse translation').getAttribute('aria-expanded')).toBe('true');
  await act(async () => button('Original').click());
  expect(button('Original').getAttribute('aria-expanded')).toBe('true');
  expect([...container.querySelectorAll('p')].some((element) => element.textContent === '这个项目的性能表现如何？')).toBe(true);
  await act(async () => button('Original').click());
  expect(button('Original').getAttribute('aria-expanded')).toBe('false');
});

it.each(['ai:one', 'doubao', 'microsoft'])('does not send text to a separate detector when %s omits the source language', async (service) => {
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: '你好', sourceLang: '' }]);
  await render();
  await choose(2, service);
  await input('private input');
  await act(async () => button('Translate').click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('你好');
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(byLabel('Read original').disabled).toBe(true);
  expect(byLabel('Read translation').disabled).toBe(false);
  await act(async () => byLabel('Read translation').click());
  expect(mocks.toggle).toHaveBeenCalledWith('result', '你好', 'zh-CN');
});

it('shows the actual pool service and keeps explicit source selection available', async () => {
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: '你好 &amp; 世界', sourceLang: 'en', actualService: 'google' }]);
  await render();
  await choose(2, 'freeAuto');
  expect(container.querySelectorAll('select')[0].disabled).toBe(false);
  await choose(0, 'en');
  await input('Hello & world');
  await act(async () => button('Translate').click());
  expect(mocks.translate).toHaveBeenCalledWith('freeAuto', ['Hello &amp; world'], 'zh-CN', expect.any(AbortSignal), 'en');
  expect(container.querySelector('[role="status"]')?.textContent).toBe('你好 & 世界');
  const result = container.querySelector('[aria-label="Translation result"]')!;
  const title = Array.from(result.querySelectorAll('span')).find((span) => span.textContent === 'Translation result');
  expect(title?.nextElementSibling?.textContent).toBe('Service: google');
  expect(mocks.translate).toHaveBeenCalledTimes(1);
});

it('ignores the composition Enter key, while supporting Cmd+Enter', async () => {
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: '你好', sourceLang: 'en' }]);
  await render();
  await input('hello');
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })));
  expect(mocks.translate).not.toHaveBeenCalled();
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })));
  expect(mocks.translate).toHaveBeenCalledTimes(1);
});

it('aborts stale requests when the draft changes and prevents duplicate dispatch', async () => {
  let resolve!: (value: unknown) => void;
  mocks.translate.mockReturnValue(new Promise((done) => { resolve = done; }));
  await render();
  await input('first');
  await act(async () => { button('Translate').click(); button('Translate').click(); });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  const signal = mocks.translate.mock.calls[0][3] as AbortSignal;
  expect(button('Translating…').disabled).toBe(true);
  await input('second');
  expect(signal.aborted).toBe(true);
  await act(async () => resolve([{ translatedMappedHtmlText: 'stale', sourceLang: 'en' }]));
  expect(container.textContent).not.toContain('stale');
  expect(mocks.success).not.toHaveBeenCalled();
});

it('shows provider failures and supports retry without losing input', async () => {
  mocks.translate.mockRejectedValueOnce(new Error('HTTP 429')).mockResolvedValueOnce([{ translatedMappedHtmlText: '你好', sourceLang: 'en' }]);
  await render();
  await input('hello');
  await act(async () => button('Translate').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 429');
  expect(container.querySelector('textarea')?.value).toBe('hello');
  await act(async () => button('Retry translation').click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe('你好');
});

it('opens empty each time, migrates old content away and remembers only translation settings', async () => {
  const preferences = { source: 'en', target: 'fr', service: 'google', followPage: false };
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({
    ...preferences, text: 'previous input',
    result: { text: 'old result', original: 'previous input', sourceLang: 'en', targetLang: 'fr', service: 'google' },
  }));
  await render();
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(container.querySelectorAll('select')[0].value).toBe('en');
  expect(container.querySelectorAll('select')[1].value).toBe('fr');
  expect(container.querySelectorAll('select')[2].value).toBe('google');
  expect(JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!)).toEqual(preferences);

  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: 'bonjour', sourceLang: 'en' }]);
  await input('hello');
  await act(async () => button('Translate').click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('bonjour');
  expect(JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!)).toEqual(preferences);

  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.success.mockClear();
  await render();
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(button('Translate').disabled).toBe(true);
  expect(mocks.success).not.toHaveBeenCalled();
  expect(container.querySelectorAll('select')[1].value).toBe('fr');
});

it('does not read or overwrite real drafts in the settings preview', async () => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ ...emptyManualDraft('microsoft'), text: 'private draft' }));
  await render(true);
  expect(container.querySelector('textarea')?.value).toBe('');
  await input('preview');
  expect(JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!).text).toBe('private draft');
});

it('surfaces corrupt drafts without overwriting them until the user edits', async () => {
  localStorage.setItem(MANUAL_DRAFT_KEY, 'invalid json');
  await render();
  expect(container.querySelector('[role="alert"]')).toBeTruthy();
  expect(localStorage.getItem(MANUAL_DRAFT_KEY)).toBe('invalid json');
  await input('new draft');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!)).not.toHaveProperty('text');
  expect(container.querySelector('textarea')?.value).toBe('new draft');
});

it('switches AI engines to automatic source detection and invalidates old results', async () => {
  await render();
  await choose(0, 'en');
  await choose(2, 'ai:one');
  expect(container.querySelectorAll('select')[0].disabled).toBe(true);
  expect(container.querySelectorAll('select')[0].value).toBe('auto');
  expect(container.textContent).toContain('AI engines detect');
});

it('uses automatic source detection for Doubao and preserves the source control for other engines', async () => {
  await render();
  await choose(0, 'en');
  await choose(2, 'doubao');
  expect(container.querySelectorAll('select')[0].value).toBe('auto');
  expect(container.querySelectorAll('select')[0].disabled).toBe(true);
  expect(container.textContent).toContain('This engine detects the source language automatically.');
  await choose(2, 'microsoft');
  expect(container.querySelectorAll('select')[0].disabled).toBe(false);
});

it.each(['doubao', 'doubaoVolc', 'doubaoMicrosoft', 'ai:one'])('normalizes the source after falling back to %s', async (service) => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ source: 'en', target: 'fr', service: 'removed-provider', followPage: false }));
  const options = [{ value: service, label: service, iconId: 'doubao', isAi: service.startsWith('ai:') }];
  await act(async () => root.render(<ManualTranslator services={options} defaultService={service} onSuccess={mocks.success} />));
  expect(container.querySelectorAll('select')[0].value).toBe('auto');
  expect(container.querySelectorAll('select')[0].disabled).toBe(true);
  expect(container.querySelectorAll('select')[1].value).toBe('fr');
  expect(JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!)).toMatchObject({ source: 'auto', service });
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: 'bonjour', sourceLang: 'en' }]);
  await input('hello');
  await act(async () => button('Translate').click());
  expect(mocks.translate).toHaveBeenCalledWith(service, ['hello'], 'fr', expect.any(AbortSignal), undefined);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('bonjour');
});

it.each(['doubao', 'ai:one'])('normalizes a previously saved forced source for %s', async (service) => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ source: 'en', target: 'fr', service, followPage: false }));
  await render();
  expect(container.querySelectorAll('select')[0].value).toBe('auto');
  expect(container.querySelectorAll('select')[0].disabled).toBe(true);
  expect(container.querySelectorAll('select')[2].value).toBe(service);
});

it('preserves an explicit source when falling back to an engine that supports it', async () => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ source: 'en', target: 'fr', service: 'removed-provider', followPage: false }));
  await render();
  expect(container.querySelectorAll('select')[0].value).toBe('en');
  expect(container.querySelectorAll('select')[0].disabled).toBe(false);
  expect(container.querySelectorAll('select')[2].value).toBe('microsoft');
});

it('keeps text languages, engine and results independent of webpage settings by default', async () => {
  mocks.translate.mockResolvedValue([{ translatedMappedHtmlText: 'bonjour', sourceLang: 'en' }]);
  await render(false, { target: 'en', service: 'microsoft' });
  await choose(1, 'fr');
  await choose(2, 'google');
  await input('hello');
  await act(async () => button('Translate').click());
  expect(mocks.translate).toHaveBeenCalledWith('google', ['hello'], 'fr', expect.any(AbortSignal), undefined);
  await render(false, { target: 'ja', service: 'microsoft' });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('bonjour');
  expect(container.querySelectorAll('select')[1].value).toBe('fr');
  expect(container.querySelectorAll('select')[2].value).toBe('google');
});

it('follows webpage selectors only when checked, cancelling outdated requests', async () => {
  let resolve!: (value: unknown) => void;
  mocks.translate.mockReturnValue(new Promise((done) => { resolve = done; }));
  await render(false, { target: 'fr', service: 'google' });
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelectorAll('select')[1].value).toBe('fr');
  expect(container.querySelectorAll('select')[1].disabled).toBe(true);
  expect(container.querySelectorAll('select')[2].disabled).toBe(true);
  await input('hello');
  await act(async () => button('Translate').click());
  const signal = mocks.translate.mock.calls[0][3] as AbortSignal;
  await render(false, { target: 'en', service: 'microsoft' });
  expect(signal.aborted).toBe(true);
  expect(container.querySelector('textarea')?.value).toBe('hello');
  await act(async () => resolve([{ translatedMappedHtmlText: 'stale result', sourceLang: 'en' }]));
  expect(container.textContent).not.toContain('stale result');
  const saved = JSON.parse(localStorage.getItem(MANUAL_DRAFT_KEY)!);
  expect(saved.followPage).toBe(true);
  expect(saved.service).toBe('microsoft');
});

it('does not restore followed results under a conflicting webpage language pair', async () => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ ...emptyManualDraft('microsoft'), followPage: true, text: 'hello', result: { text: '你好', original: 'hello', sourceLang: 'en', targetLang: 'zh-CN', service: 'microsoft' } }));
  await render(false, { target: 'fr', service: 'google' });
  expect(container.querySelector('textarea')?.value).toBe('');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(mocks.success).not.toHaveBeenCalled();
});

it('can stop following and keep independently selected languages across page changes', async () => {
  await render(false, { target: 'fr', service: 'google' });
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  await act(async () => checkbox.click());
  await choose(1, 'ja');
  await choose(2, 'microsoft');
  await render(false, { target: 'en', service: 'google' });
  expect(container.querySelectorAll('select')[1].disabled).toBe(false);
  expect(container.querySelectorAll('select')[1].value).toBe('ja');
  expect(container.querySelectorAll('select')[2].value).toBe('microsoft');
});

it.each(['transmart', 'volcengine', 'lara', 'modernMt'])('escapes and decodes %s manual text exactly once', (id) => {
  const text = 'A & B <tag> &amp;';
  const escaped = 'A &amp; B &lt;tag&gt; &amp;amp;';
  expect(prepareManualText(id, text)).toBe(escaped);
  expect(readManualText(id, escaped)).toBe(text);
});

it('escapes HTML-backed plain inputs and decodes output without executing markup', () => {
  expect(prepareManualText(TRANSLATE_SERVICE.GOOGLE, '<script>A & B</script>')).toBe('&lt;script&gt;A &amp; B&lt;/script&gt;');
  expect(readManualText(TRANSLATE_SERVICE.GOOGLE_CLOUD, '&lt;b&gt;A &amp; B&lt;/b&gt;')).toBe('<b>A & B</b>');
  expect(prepareManualText(TRANSLATE_SERVICE.MICROSOFT, 'A & B')).toBe('A & B');
});

it('ignores stale legacy input and results when loading saved settings', () => {
  localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ ...emptyManualDraft('microsoft'), text: 'new', result: { text: 'old', original: 'old', targetLang: 'zh-CN', sourceLang: 'en', service: 'microsoft' } }));
  expect(readManualDraft(localStorage, emptyManualDraft('microsoft'))).toMatchObject({ text: '', result: null, service: 'microsoft' });
});
