import { test, expect } from '../fixtures/extension';
import { mockTranslateProviders, ZH } from '../mocks/translateRoutes';
import type { Worker } from '@playwright/test';

async function changeExcluded(worker: Worker, languages: string[]) {
    await worker.evaluate(async value => {
        await chrome.storage.local.set({ fluento_config_noTranslateLanguages: value });
        const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('localhost:5566'));
        await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { noTranslateLanguages: value } });
    }, languages);
}

test.describe('local-only webpage language exclusion (mocked providers)', () => {
    test('filters reliable English/target-language text before requests but preserves short and mixed text', async ({ context, page, seedConfig }) => {
        const recorder = await mockTranslateProviders(context);
        let microsoftRequests = 0;
        await context.route('**/edge.microsoft.com/**', route => { microsoftRequests++; return route.abort(); });
        await seedConfig({ fluento_config_noTranslateLanguages: ['en'] });
        await page.goto('/language-filter.html');
        for (const id of ['german', 'short', 'latin-mixed', 'script-mixed']) {
            await expect(page.locator(`#${id} .fluento-translation`)).toContainText(ZH);
        }
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        for (const id of ['english', 'english-copy', 'chinese']) await expect(page.locator(`#${id} .fluento-translation`)).toHaveCount(0);
        expect(recorder.texts.some(text => text.includes('This paragraph explains how the translation extension examines') && !text.includes('Bonjour'))).toBe(false);
        expect(recorder.texts.some(text => text.includes('明确的简体字形证据'))).toBe(false);
        expect(microsoftRequests).toBe(0);
        // Google mock reports source=en even for German. Its reply must NOT
        // override the request-time local decision and discard that translation.
        await expect(page.locator('#german .fluento-translation')).toContainText('Dieser Absatz');
    });

    test('a selected non-Microsoft provider never triggers a companion Microsoft detect', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context);
        let microsoftRequests = 0;
        await context.route('**/edge.microsoft.com/**', route => { microsoftRequests++; return route.abort(); });
        await seedConfig({ fluento_config_translateService: 'yandex', fluento_config_noTranslateLanguages: ['en'] });
        await page.goto('/language-filter.html');
        await expect(page.locator('#german .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#short .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#latin-mixed .fluento-translation')).toContainText(ZH);
        expect(microsoftRequests).toBe(0);
    });

    test('removing an excluded language rechecks only previously skipped blocks', async ({ context, page, seedConfig, serviceWorker }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig({ fluento_config_noTranslateLanguages: ['en'] });
        await page.goto('/language-filter.html');
        await expect(page.locator('#german .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        await expect(page.locator('#english .fluento-translation')).toHaveCount(0);
        recorder.reset();
        await changeExcluded(serviceWorker, []);
        await expect(page.locator('#english .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        expect(recorder.texts.some(text => text.includes('Dieser Absatz'))).toBe(false);
    });

    test('source edits re-evaluate a previously excluded paragraph for both text and node replacements', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context); await seedConfig({ fluento_config_noTranslateLanguages: ['en'] });
        await page.goto('/language-filter.html');
        await expect(page.locator('#german .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        const german = await page.locator('#german').evaluate(element => element.firstChild!.textContent!);
        await page.locator('#english').evaluate((element, text) => { element.firstChild!.textContent = text; }, german);
        await page.locator('#english-copy').evaluate((element, text) => { element.textContent = text; }, german);
        await expect(page.locator('#english .fluento-translation')).toContainText('Dieser Absatz');
        await expect(page.locator('#english-copy .fluento-translation')).toContainText('Dieser Absatz');
    });

    for (const change of ['source', 'settings', 'stop'] as const) {
        test(`handles ${change} changes while local browser detection is pending`, async ({ context, page, seedConfig, serviceWorker, extensionId }) => {
            const recorder = await mockTranslateProviders(context);
            await seedConfig({ fluento_config_noTranslateLanguages: ['en'] });
            await page.goto('/language-filter.html');
            await expect(page.locator('#german .fluento-translation')).toContainText(ZH);
            await expect(page.locator('fluento-loading')).toHaveCount(0);
            const german = await page.locator('#german').evaluate(element => element.firstChild!.textContent!);
            const english = (await page.locator('#english').textContent())! + ' and this newly inserted source has never been inspected before';
            recorder.reset();
            const cdp = await context.newCDPSession(page);
            const worlds: Array<{ id: number; origin: string; name: string }> = [];
            cdp.on('Runtime.executionContextCreated', event => worlds.push(event.context));
            await cdp.send('Runtime.enable');
            const world = worlds.find(value => value.origin.startsWith(`chrome-extension://${extensionId}`) || value.name === extensionId);
            if (!world) throw Error(`Extension isolated world missing: ${JSON.stringify(worlds)}`);
            const run = (expression: string) => cdp.send('Runtime.evaluate', { contextId: world.id, expression, returnByValue: true });
            try {
                // Hold a native LOCAL call, not a provider request. Both Promise
                // and callback forms are supported for browser polyfill wrappers.
                await run(`(() => {
                    const native = chrome.i18n.detectLanguage.bind(chrome.i18n);
                    const probe = globalThis.__fluentoLocalProbe = { calls: 0, release: null };
                    chrome.i18n.detectLanguage = (text, callback) => {
                        const promise = probe.calls++ === 0 ? new Promise(resolve => {
                            probe.release = () => resolve({ isReliable: true, languages: [{ language: 'en', percentage: 99 }] });
                        }) : native(text);
                        if (typeof callback === 'function') { promise.then(callback); return; }
                        return promise;
                    };
                })()`);
                await page.evaluate(text => {
                    const p = document.createElement('p'); p.id = 'during-local'; p.textContent = text; document.body.appendChild(p);
                }, english);
                await expect.poll(async () => (await run('Boolean(globalThis.__fluentoLocalProbe.release)')).result.value).toBe(true);
                if (change === 'source') await page.locator('#during-local').evaluate((element, text) => { element.textContent = text; }, german);
                else if (change === 'settings') await changeExcluded(serviceWorker, []);
                else {
                    await serviceWorker.evaluate(async () => {
                        const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('localhost:5566'));
                        await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { globalSwitch: false } });
                    });
                }
                await run('globalThis.__fluentoLocalProbe.release()');
                if (change === 'stop') {
                    await page.waitForTimeout(150);
                    expect(recorder.texts).toHaveLength(0);
                    await expect(page.locator('#during-local .fluento-translation')).toHaveCount(0);
                } else {
                    await expect(page.locator('#during-local .fluento-translation')).toContainText(change === 'source' ? 'Dieser Absatz' : 'newly inserted source');
                    if (change === 'source') expect(recorder.texts.some(text => text.includes('newly inserted source'))).toBe(false);
                }
            } finally { await cdp.detach(); }
        });
    }

    test('AUTO does not hide later foreign paragraphs behind a large excluded-language prefix', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context);
        await seedConfig({ fluento_config_defaultStrategy: 'auto', fluento_config_noTranslateLanguages: ['en'] });
        const english = 'This paragraph explains how the translation extension examines source text before making a request and preserves uncertain material so that foreign content remains available for translation';
        const german = 'Dieser Absatz erklärt wie die Übersetzungserweiterung funktioniert und welche Inhalte vor dem Senden einer Anfrage überprüft werden damit bekannte Sprachen nicht unnötig übersetzt werden und unsichere Inhalte weiterhin verfügbar bleiben';
        await context.route('**/language-filter.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
            '<!doctype html><html lang="en"><body>' + Array.from({ length: 30 }, () => `<p>${english}</p>`).join('')
            + `<p id="foreign-after-prefix">${german}</p></body></html>`,
        }));
        await page.goto('/language-filter.html');
        await page.locator('#foreign-after-prefix').scrollIntoViewIfNeeded();
        await expect(page.locator('#foreign-after-prefix .fluento-translation')).toContainText(ZH);
    });

    for (const target of ['zh-CN', 'zh-TW']) {
        test(`candidate review respects all skip languages and Chinese conversion for ${target}`, async ({ context, page, seedConfig }) => {
            const recorder = await mockTranslateProviders(context);
            await seedConfig({ fluento_config_noTranslateLanguages: ['en', 'ja'], fluento_config_targetLanguage: target });
            const chinese = '这是一个用于测试网页翻译功能的中文段落其中包含明确的简体字形证据';
            const japanese = 'これは日本語の文章であり翻訳機能の動作を確認するための説明です';
            const english = 'This paragraph explains how the translation extension examines source text before making a request and preserves uncertain material so that foreign content remains available for translation';
            await context.route('**/language-filter.html', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
                `<!doctype html><p id="mixed">${chinese}。${japanese}</p><p id="url">${english}. "https://example.com/a?lang=fr"</p>`
                + '<p id="control">Dieser Absatz erklärt wie die Übersetzungserweiterung funktioniert und welche Inhalte vor dem Senden einer Anfrage überprüft werden damit bekannte Sprachen nicht unnötig übersetzt werden und unsichere Inhalte weiterhin verfügbar bleiben</p>',
            }));
            await page.goto('/language-filter.html');
            await expect(page.locator('#control .fluento-translation')).toContainText(ZH);
            await expect(page.locator('fluento-loading')).toHaveCount(0);
            if (target === 'zh-CN') {
                await expect(page.locator('#mixed .fluento-translation')).toHaveCount(0);
                expect(recorder.texts.some(text => text.includes('明确的简体字形证据'))).toBe(false);
            } else await expect(page.locator('#mixed .fluento-translation')).toContainText(ZH);
            await expect(page.locator('#url .fluento-translation')).toHaveCount(0);
            expect(recorder.texts.some(text => text.includes('example.com'))).toBe(false);
        });
    }

    test('sends foreign prose immediately after a URL for translation', async ({ context, page, seedConfig }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig({ fluento_config_noTranslateLanguages: ['en'] });
        const english = 'This paragraph explains how the translation extension examines source text before making a request and preserves uncertain material so that foreign content remains available for translation';
        const foreign = '請立即點擊這裡以查看完整說明';
        await context.route('**/language-filter.html', route => route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><p id="url-adjacent">${english} https://example.com/docs。${foreign}</p>`,
        }));
        await page.goto('/language-filter.html');
        await expect(page.locator('#url-adjacent .fluento-translation')).toContainText(foreign);
        expect(recorder.texts.some(text => text.includes(foreign))).toBe(true);
    });

    test('AUTO page decisions never use a remote language-detection fallback', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context);
        let microsoftRequests = 0;
        await context.route('**/edge.microsoft.com/**', route => { microsoftRequests++; return route.abort(); });
        await seedConfig({ fluento_config_defaultStrategy: 'auto', fluento_config_noTranslateLanguages: ['en'] });
        await page.goto('/language-filter.html');
        await expect(page.locator('#short .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#german .fluento-translation')).toContainText(ZH);
        expect(microsoftRequests).toBe(0);
    });
});
