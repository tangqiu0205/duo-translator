import type { Worker } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { sendAction } from '../common/utils';
import { mockTranslateProviders } from '../mocks/translateRoutes';

const content = `<main><h1 id="title">Article title</h1><article><p id="body">This is the main paragraph with enough useful article text.</p><nav><p id="nav">Navigation inside the article</p></nav><aside><p id="aside">Related reading links</p></aside><button id="button">Subscribe to this publication</button></article></main><footer><p id="footer">Footer and company information</p></footer>`;
const noMain = `<div><p id="body">The reading content on this page has no semantic container.</p></div><nav><p id="nav">Website navigation and account settings</p></nav>`;

const setScope = (worker: Worker, scope: 'all' | 'main') => worker.evaluate(async scope => {
    await chrome.storage.local.set({ fluento_config_pageTranslationScope: scope });
    const tab = (await chrome.tabs.query({})).find(tab => tab.url?.endsWith('/translation-scope.html'));
    await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { pageTranslationScope: scope } });
}, scope);

test('the scope setting is in Options, persists, and is not shown in Popup', async ({ page, seedConfig, extensionId, serviceWorker }) => {
    await seedConfig({ fluento_config_interfaceLanguage: 'en' });
    const base = `chrome-extension://${extensionId}`;
    await page.goto(`${base}/options.html#translation`);
    const scope = page.getByRole('combobox', { name: 'Translation scope', exact: true });
    await expect(scope).toHaveText('Full page');
    await scope.click();
    await page.getByRole('option', { name: 'Main content only', exact: true }).click();
    await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get('fluento_config_pageTranslationScope')).fluento_config_pageTranslationScope)).toBe('main');
    await page.reload();
    await expect(scope).toHaveText('Main content only');
    await page.goto(`${base}/popup.html`);
    await expect(page.getByText('Display mode', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Translation scope', { exact: true })).toHaveCount(0);
});

test('only main content translates the article and its title, not page chrome', async ({ context, page, seedConfig }) => {
    const recorder = await mockTranslateProviders(context);
    await seedConfig({ fluento_config_pageTranslationScope: 'main' });
    await context.route('**/translation-scope.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + content }));
    await page.goto('/translation-scope.html');
    await expect(page.locator('#title .fluento-translation')).toContainText('「译」');
    await expect(page.locator('#body .fluento-translation')).toContainText('「译」');
    expect(recorder.texts).toHaveLength(2);
    await expect(page.locator('#nav .fluento-translation, #aside .fluento-translation, #footer .fluento-translation, #button .fluento-translation')).toHaveCount(0);
});

for (const view of ['double', 'single']) {
    test(`switching the scope preserves completed main translations in ${view} mode`, async ({ context, page, seedConfig, serviceWorker }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig({ fluento_config_pageTranslationScope: 'all', fluento_config_viewStrategy: view });
        await context.route('**/translation-scope.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + content }));
        await page.goto('/translation-scope.html');
        await expect(page.locator('#body')).toContainText('「译」');
        await expect(page.locator('#footer')).toContainText('「译」');
        const sent = () => recorder.texts.filter(text => text.includes('This is the main paragraph')).length;
        expect(sent()).toBe(1);
        await setScope(serviceWorker, 'main');
        await expect(page.locator('#footer')).toHaveText('Footer and company information');
        await expect(page.locator('#body')).toContainText('「译」');
        await expect(page.locator('#title')).toContainText('「译」');
        await setScope(serviceWorker, 'all');
        await expect(page.locator('#footer')).toContainText('「译」');
        expect(sent()).toBe(1);
    });
}

test('an explicit site rule can select custom title and article roots without changing full page mode', async ({ context, page, seedConfig, serviceWorker }) => {
    const recorder = await mockTranslateProviders(context);
    await seedConfig({
        fluento_config_pageTranslationScope: 'main',
        fluento_config_siteRuleUser: [{
            id: 'main-test', name: 'Main content fixture', includeUrls: ['*://localhost:5566/translation-scope.html*'],
            mainContentSelectors: ['#short-title', '.reading'], excludeSelectors: ['#ad'],
        }],
    });
    await context.route('**/translation-scope.html', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><h1 id="short-title">Hi</h1><div class="reading"><p id="body">This is the article text inside a custom element.</p><p id="ad">Sponsored material to leave alone.</p></div><p id="outside">Page settings should not count as an article.</p>',
    }));
    await page.goto('/translation-scope.html');
    await expect(page.locator('#short-title .fluento-translation')).toContainText('「译」');
    await expect(page.locator('#body .fluento-translation')).toContainText('「译」');
    expect(recorder.texts).toHaveLength(2);
    await expect(page.locator('#ad .fluento-translation')).toHaveCount(0);
    await setScope(serviceWorker, 'all');
    await expect(page.locator('#outside .fluento-translation')).toContainText('「译」');
    await expect(page.locator('#ad .fluento-translation')).toHaveCount(0);
});

test('a full-page response arriving after narrowing the scope cannot write outside the article', async ({ context, page, seedConfig, serviceWorker }) => {
    await seedConfig({ fluento_config_pageTranslationScope: 'all' });
    await context.route('**/translation-scope.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + content }));
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await context.route('**/translate-pa.googleapis.com/**', async route => {
        const texts = route.request().postDataJSON()[0][0] as string[];
        const old = texts.some(text => text.includes('Footer and company information'));
        if (old) { held = true; await hold; }
        await route.fulfill({ json: [texts.map(text => text.replace(/(<a i=\d+>)/g, `$1${old ? 'Stale' : '「译」'}`)), texts.map(() => 'en')] });
    });
    try {
        await page.goto('/translation-scope.html');
        await expect.poll(() => held).toBe(true);
        await setScope(serviceWorker, 'main');
        release();
        await expect(page.locator('#body')).toContainText('「译」');
        await expect(page.locator('#footer')).toHaveText('Footer and company information');
        await expect(page.locator('.fluento-translation').filter({ hasText: 'Stale' })).toHaveCount(0);
    } finally { release(); }
});

test('missing main content offers a one-page full translation without changing the setting', async ({ context, page, seedConfig, serviceWorker }) => {
    const recorder = await mockTranslateProviders(context);
    await seedConfig({ fluento_config_pageTranslationScope: 'main', fluento_config_interfaceLanguage: 'en' });
    await context.route('**/translation-scope.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + noMain }));
    await page.goto('/translation-scope.html');
    const notice = page.locator('#fluento-page-scope-notice');
    await expect(notice.getByRole('status')).toContainText('Main content not found');
    expect(recorder.requests).toBe(0);
    await notice.getByRole('button', { name: 'Translate full page' }).click();
    await expect(page.locator('#body .fluento-translation')).toContainText('「译」');
    await expect(page.locator('#nav .fluento-translation')).toContainText('「译」');
    await expect(notice).toHaveCount(0);
    expect(await serviceWorker.evaluate(async () => (await chrome.storage.local.get('fluento_config_pageTranslationScope')).fluento_config_pageTranslationScope)).toBe('main');
    await sendAction(serviceWorker, 'showOriginal');
    await expect(page.locator('.fluento-translation')).toHaveCount(0);
    await sendAction(serviceWorker, 'translate');
    await expect(notice.getByRole('button')).toBeVisible();
    await expect(page.locator('.fluento-translation')).toHaveCount(0);
});
