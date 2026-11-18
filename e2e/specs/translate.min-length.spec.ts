import { test, expect } from '../fixtures/extension';
import { mockTranslateProviders, ZH } from '../mocks/translateRoutes';
import type { Worker } from '@playwright/test';

const plain = (text: string) => text.replace(/<[^>]*>/g, '');
async function changeMinimum(worker: Worker, value: number) {
    await worker.evaluate(async minimum => {
        await chrome.storage.local.set({ fluento_config_minTranslationTextLength: minimum });
        const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('localhost:5566'));
        await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { minTranslationTextLength: minimum } });
    }, value);
}

test.describe('minimum webpage translation length (mocked providers)', () => {
    test('defaults to two code points and skips single-character fragments without requests or indicators', async ({ context, page, seedConfig }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig();
        await page.goto('/min-length.html');
        for (const id of ['word', 'five', 'two', 'format', 'shorten']) {
            await expect(page.locator(`#${id} .fluento-translation`)).toContainText(ZH);
        }
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        for (const id of ['single', 'han', 'emoji', 'grow-text', 'grow-child']) {
            await expect(page.locator(`#${id} .fluento-translation`)).toHaveCount(0);
            await expect(page.locator(`#${id} fluento-loading`)).toHaveCount(0);
        }
        for (const text of ['A', '字', '😀', 'x', 'y', 'a']) expect(recorder.texts.map(plain)).not.toContain(text);
        expect(recorder.texts.map(plain)).toContain('ab');
        // The short run does not borrow its list/sibling's length.
        await expect(page.locator('#mixed > .fluento-translation')).toHaveCount(1);
        await expect(page.locator('#mixed > .fluento-translation')).toContainText('long trailing');
    });

    test('counts plain text rather than HTML and includes text exactly at the threshold', async ({ context, page, seedConfig }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig({ fluento_config_minTranslationTextLength: 5 });
        await page.goto('/min-length.html');
        await expect(page.locator('#five .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#shorten .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        for (const id of ['word', 'format', 'two']) await expect(page.locator(`#${id} .fluento-translation`)).toHaveCount(0);
        expect(recorder.texts.map(plain)).not.toContain('book');
        expect(recorder.texts.map(plain)).not.toContain('ab');
        expect(recorder.texts.map(plain)).toContain('hello');
    });

    test('lowering the threshold picks up skipped blocks without re-sending existing translations', async ({ context, page, seedConfig, serviceWorker }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig({ fluento_config_minTranslationTextLength: 5 });
        await page.goto('/min-length.html');
        await expect(page.locator('#shorten .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        await expect(page.locator('#word .fluento-translation')).toHaveCount(0);
        recorder.reset();
        await changeMinimum(serviceWorker, 2);
        await expect(page.locator('#word .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#format .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        expect(recorder.texts.map(plain)).not.toContain('hello');
        await changeMinimum(serviceWorker, 1);
        await expect(page.locator('#single .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#emoji .fluento-translation')).toContainText(ZH);
    });

    test('raising the threshold preserves existing output and filters newly inserted short blocks', async ({ context, page, seedConfig, serviceWorker }) => {
        const recorder = await mockTranslateProviders(context);
        await seedConfig();
        await page.goto('/min-length.html');
        await expect(page.locator('#word .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        const previous = await page.locator('#word .fluento-translation').textContent();
        await changeMinimum(serviceWorker, 20);
        recorder.reset();
        await page.evaluate(() => {
            const p = document.createElement('p'); p.id = 'new-short'; p.textContent = 'tiny'; document.body.appendChild(p);
            const long = document.createElement('p'); long.id = 'new-long'; long.textContent = 'A newly inserted paragraph that is long enough.'; document.body.appendChild(long);
        });
        await expect(page.locator('#new-long .fluento-translation')).toContainText(ZH);
        await expect(page.locator('#new-short .fluento-translation')).toHaveCount(0);
        await expect(page.locator('#word .fluento-translation')).toHaveText(previous!);
        expect(recorder.texts.map(plain)).not.toContain('tiny');
    });

    test('rechecks skipped blocks for both characterData and childList source growth', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context); await seedConfig({ fluento_config_minTranslationTextLength: 5 });
        await page.goto('/min-length.html');
        await expect(page.locator('#shorten .fluento-translation')).toContainText(ZH);
        await expect(page.locator('fluento-loading')).toHaveCount(0);
        await page.locator('#grow-text').evaluate(element => { element.firstChild!.textContent = 'grown character data'; });
        await page.locator('#grow-child').evaluate(element => { element.textContent = 'grown replacement node'; });
        await expect(page.locator('#grow-text .fluento-translation')).toContainText('grown character data');
        await expect(page.locator('#grow-child .fluento-translation')).toContainText('grown replacement node');
    });

    for (const view of ['double', 'single']) {
        test(`${view}: an existing translation still follows a source shortened below the minimum`, async ({ context, page, seedConfig }) => {
            const recorder = await mockTranslateProviders(context);
            await seedConfig({ fluento_config_minTranslationTextLength: 5, fluento_config_viewStrategy: view });
            await page.goto('/min-length.html');
            const output = view === 'double' ? page.locator('#shorten .fluento-translation') : page.locator('#shorten');
            await expect(output).toContainText(ZH);
            await expect(page.locator('fluento-loading')).toHaveCount(0);
            recorder.reset();
            await page.locator('#shorten').evaluate(element => {
                const source = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
                source!.textContent = 'z';
            });
            await expect.poll(() => recorder.texts.some(text => plain(text) === 'z')).toBe(true);
            await expect(output).toContainText('z');
        });
    }

    for (const action of ['grow', 'lower'] as const) {
        test(`rechecks a skipped run when ${action} happens while its shared container is in flight`, async ({ context, page, seedConfig, serviceWorker }) => {
            await mockTranslateProviders(context);
            await seedConfig({ fluento_config_minTranslationTextLength: 5 });
            let release!: () => void;
            const hold = new Promise<void>(resolve => { release = resolve; });
            await context.route('**/translate-pa.googleapis.com/**', async route => {
                const texts = route.request().postDataJSON()[0][0] as string[];
                if (texts.some(text => text.includes('long trailing text block'))) await hold;
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
                    texts.map(text => text.replace(/(<a i=\d+>)([^<>]+)/g, '$1「译」$2')), texts.map(() => 'en'),
                ]) });
            });
            try {
                await page.goto('/min-length.html');
                await expect(page.locator('#shorten .fluento-translation')).toContainText(ZH);
                await expect(page.locator('#mixed > fluento-loading')).toHaveCount(1);
                if (action === 'grow') {
                    await page.locator('#mixed').evaluate(element => { element.firstChild!.textContent = 'Growing source text in a shared container'; });
                } else {
                    await changeMinimum(serviceWorker, 1);
                }
                release();
                await expect(page.locator('#mixed > .fluento-translation')).toHaveCount(2);
                await expect(page.locator('#mixed > .fluento-translation').first()).toContainText(action === 'grow' ? 'Growing source text' : '「译」a');
            } finally { release(); }
        });
    }

    test('queued batches recheck the latest threshold before sending requests', async ({ context, page, seedConfig, serviceWorker }) => {
        await seedConfig();
        await context.route('**/min-length.html', route => route.fulfill({ contentType: 'text/html', body:
            '<!doctype html><html lang="en"><body><h1>A long header for queue length filtering</h1>'
            + Array.from({ length: 12 }, (_, index) => `<p id="q${index}">short${index}</p>`).join('') + '</body></html>',
        }));
        let release!: () => void, requests = 0;
        const hold = new Promise<void>(resolve => { release = resolve; });
        await context.route('**/translate-pa.googleapis.com/**', async route => {
            const texts = route.request().postDataJSON()[0][0] as string[];
            if (++requests <= 2) await hold;
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
                texts.map(text => text.replace(/(<a i=\d+>)([^<>]+)/g, '$1「译」$2')), texts.map(() => 'en'),
            ]) });
        });
        try {
            await page.goto('/min-length.html');
            await expect.poll(() => requests).toBe(2);
            await changeMinimum(serviceWorker, 20);
            release();
            await expect(page.locator('#q0 .fluento-translation')).toContainText(ZH);
            await expect(page.locator('fluento-loading')).toHaveCount(0);
            expect(requests).toBe(2);
            await expect(page.locator('#q11 .fluento-translation')).toHaveCount(0);
            await changeMinimum(serviceWorker, 2);
            await expect(page.locator('#q11 .fluento-translation')).toContainText(ZH);
        } finally { release(); }
    });

    test('manual paragraph gestures bypass automatic length filtering', async ({ context, page, seedConfig }) => {
        await mockTranslateProviders(context);
        await seedConfig({ fluento_config_defaultStrategy: 'never', fluento_config_minTranslationTextLength: 20,
            fluento_config_doubleTapModifier: 'ctrl', fluento_config_doubleTapToggleParagraph: true,
            fluento_config_doubleTapTranslateSelection: false, fluento_config_doubleTapTranslateInput: false });
        await page.goto('/min-length.html');
        const box = await page.locator('#word').boundingBox();
        await page.mouse.move(box!.x + 3, box!.y + box!.height / 2);
        await page.keyboard.press('Control'); await page.keyboard.press('Control');
        await expect(page.locator('#word .fluento-translation')).toContainText(ZH);
    });

    test('settings expose default 2, bounds 1–20, persistence and reset', async ({ context, page, seedConfig, extensionId, serviceWorker }) => {
        await mockTranslateProviders(context);
        await seedConfig({ fluento_config_interfaceLanguage: 'en' });
        await page.goto(`chrome-extension://${extensionId}/options.html#translation`);
        const row = page.getByText('Minimum translation text length', { exact: true }).locator('xpath=../..');
        const input = row.locator('input[type="number"]');
        await expect(input).toHaveValue('2');
        await expect(input).toHaveAttribute('min', '1'); await expect(input).toHaveAttribute('max', '20');
        await input.fill('99'); await input.press('Tab'); await expect(input).toHaveValue('20');
        await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get('fluento_config_minTranslationTextLength')).fluento_config_minTranslationTextLength)).toBe(20);
        await input.fill('0'); await input.press('Tab'); await expect(input).toHaveValue('1');
        await row.getByRole('button', { name: 'Reset (2)', exact: true }).click();
        await expect(input).toHaveValue('2');
        await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.local.get('fluento_config_minTranslationTextLength')).fluento_config_minTranslationTextLength)).toBe(2);
    });
});
