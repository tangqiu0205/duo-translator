import { test, expect } from '../fixtures/extension';
import { sendAction } from '../common/utils';
import type { Worker } from '@playwright/test';

// No live provider traffic: the worker receives a synthetic, controllable SSE
// response. Unlike route.fulfill, ReadableStream lets the test leave it open.
async function installDoubaoStream(worker: Worker) {
    await worker.evaluate(() => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const url = String(input);
            if (url.startsWith('https://www.doubao.com/alice/user/launch')) {
                return Response.json({ code: 0, data: { config: { web_id: '1234567890' }, country: 'CN' } });
            }
            if (!url.startsWith('https://www.doubao.com/samantha/plugin/stream_article_translate')) return originalFetch(input, init);
            const texts = JSON.parse(String(init?.body)).raw_text as string[];
            const items = texts.map((text, index) => ({ index, res: `「译」${text}`, detect_lang: 'en' }));
            const held = items.filter(item => item.res.includes('Paragraph 1 '));
            const immediate = items.filter(item => !held.includes(item));
            const encoder = new TextEncoder();
            const event = (values: typeof items) => encoder.encode(`event: json\ndata: ${JSON.stringify({ code: 0, data: { items: values } })}\n\n`);
            let cancelled = false;
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(event(immediate));
                    if (!held.length) { controller.close(); return; }
                    (globalThis as any).__fluentoTestRelease = (fail = false) => {
                        if (cancelled) return;
                        if (fail) controller.error(new Error('Synthetic later paragraph failure'));
                        else { controller.enqueue(event(held)); controller.close(); }
                    };
                },
                cancel() { cancelled = true; },
            }), { headers: { 'Content-Type': 'text/event-stream' } });
        };
    });
}

test.describe('progressive webpage translation (mocked providers)', () => {
    test('small native batches finish independently while an earlier batch is held', async ({ context, page, seedConfig }) => {
        await seedConfig();
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const sizes: number[] = [];
        await context.route('**/translate-pa.googleapis.com/**', async route => {
            const texts = route.request().postDataJSON()[0][0] as string[];
            sizes.push(texts.length);
            if (texts.some(text => text.includes('Paragraph 1 '))) await hold;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                texts.map(text => text.replace(/(<a i=\d+>)([^<>]+)/g, '$1「译」$2')), texts.map(() => 'en'),
            ]) });
        });
        try {
            await page.goto('/progressive.html');
            await expect(page.locator('#p5 .fluento-translation')).toContainText('「译」');
            await expect(page.locator('#p1 .fluento-translation')).toHaveCount(0);
            expect(sizes.every(size => size <= 4)).toBe(true);
            release();
            await expect(page.locator('#p1 .fluento-translation')).toContainText('「译」');
        } finally { release(); }
    });

    test('complete SSE paragraphs display before the same batch ends; restore cancels late writes', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({ fluento_config_translateService: 'doubao' });
        await installDoubaoStream(serviceWorker);
        await page.goto('/progressive.html');
        await expect(page.locator('#p2 .fluento-translation')).toContainText('「译」');
        await expect(page.locator('#p3 .fluento-translation strong')).toContainText('important formatted content');
        await expect(page.locator('#p1 .fluento-translation')).toHaveCount(0);
        await sendAction(serviceWorker, 'showOriginal');
        await expect(page.locator('.fluento-translation')).toHaveCount(0);
        await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease());
        await page.waitForTimeout(200);
        await expect(page.locator('.fluento-translation')).toHaveCount(0);
        await expect(page.locator('#p2')).toHaveText('Paragraph 2 should appear before the first finishes.');
    });

    test('a completed paragraph follows source edits while an unrelated paragraph in the batch is pending', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({ fluento_config_translateService: 'doubao' });
        await installDoubaoStream(serviceWorker);
        await page.goto('/progressive.html');
        await expect(page.locator('#p2 .fluento-translation')).toContainText('Paragraph 2');
        await page.locator('#p2').evaluate(element => {
            element.firstChild!.textContent = 'Updated source text after this paragraph was committed.';
        });
        // The repair must happen BEFORE the slow sibling is released.
        await expect(page.locator('#p2 .fluento-translation')).toContainText('Updated source text');
        await expect(page.locator('#p1 .fluento-translation')).toHaveCount(0);
        await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease());
        await expect(page.locator('#p1 .fluento-translation')).toContainText('Paragraph 1');
        await expect(page.locator('#p2 .fluento-translation')).toHaveCount(1);
    });

    for (const view of ['double', 'single']) {
        test(`${view}: shared-container guards retain source edits until the final unit settles`, async ({ context, page, seedConfig, serviceWorker }) => {
            await seedConfig({ fluento_config_translateService: 'doubao', fluento_config_viewStrategy: view });
            await installDoubaoStream(serviceWorker);
            await context.route('**/progressive.html', route => route.fulfill({ contentType: 'text/html', body:
                '<!doctype html><html lang="en"><head><title>Mixed fixture</title></head><body><h1>Shared container translation fixture</h1><div id="mixed">Paragraph 1 is deliberately slow.<ul><li>A separating block item.</li></ul>Paragraph 2 has already completed.</div></body></html>',
            }));
            await page.goto('/progressive.html');
            const output = view === 'double' ? page.locator('#mixed > .fluento-translation') : page.locator('#mixed');
            await expect(output.filter({ hasText: 'Paragraph 2' })).toContainText('「译」');
            await page.locator('#mixed').evaluate(element => {
                const source = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('Paragraph 2'));
                if (!source) throw Error('Completed source text node not found');
                source.textContent = 'Updated shared container source text.';
            });
            await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease());
            await expect(output.filter({ hasText: 'Updated shared container source text.' })).toContainText('「译」Updated shared container source text.');
        });
    }

    test('disabling cancels active and unsent batches; re-enabling starts a new session', async ({ context, page, seedConfig, serviceWorker }) => {
        await seedConfig();
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        let requests = 0, disabledRequests = 0, disabled = false;
        await context.route('**/translate-pa.googleapis.com/**', async route => {
            const texts = route.request().postDataJSON()[0][0] as string[];
            requests++;
            if (disabled) disabledRequests++;
            if (requests <= 2) await hold;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
                texts.map(text => text.replace(/(<a i=\d+>)([^<>]+)/g, '$1「译」$2')), texts.map(() => 'en'),
            ]) });
        });
        try {
            await page.goto('/progressive.html');
            await expect.poll(() => requests).toBe(2);
            disabled = true;
            await serviceWorker.evaluate(async () => {
                await chrome.storage.local.set({ fluento_config_globalSwitch: false });
                const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('localhost:5566'));
                await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { globalSwitch: false } });
            });
            await expect(page.locator('fluento-loading')).toHaveCount(0);
            release();
            await page.waitForTimeout(300);
            expect(disabledRequests).toBe(0);
            expect(requests).toBe(2);
            await expect(page.locator('.fluento-translation')).toHaveCount(0);
            disabled = false;
            await serviceWorker.evaluate(async () => {
                await chrome.storage.local.set({ fluento_config_globalSwitch: true });
                const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('localhost:5566'));
                await chrome.tabs.sendMessage(tab!.id!, { action: 'configChanged', data: { globalSwitch: true } });
            });
            await expect(page.locator('#p10 .fluento-translation')).toContainText('「译」');
        } finally { release(); }
    });

    test('an edited source is not overwritten by a stale stream result and is translated again', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({ fluento_config_translateService: 'doubao' });
        await installDoubaoStream(serviceWorker);
        await page.goto('/progressive.html');
        await expect(page.locator('#p2 .fluento-translation')).toContainText('「译」');
        await page.locator('#p1').evaluate(element => { element.textContent = 'The page replaced this source while translation was pending.'; });
        await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease());
        await expect(page.locator('#p1 .fluento-translation')).toContainText('The page replaced this source');
        await expect(page.locator('#p1 .fluento-translation')).not.toContainText('Paragraph 1');
        await expect(page.locator('#p1 .fluento-translation')).toHaveCount(1);
    });

    test('single view commits complete paragraphs early and restores their original text', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({ fluento_config_translateService: 'doubao', fluento_config_viewStrategy: 'single' });
        await installDoubaoStream(serviceWorker);
        await page.goto('/progressive.html');
        await expect(page.locator('#p2')).toContainText('「译」');
        await expect(page.locator('#p1')).not.toContainText('「译」');
        await sendAction(serviceWorker, 'showOriginal');
        await expect(page.locator('#p2')).toHaveText('Paragraph 2 should appear before the first finishes.');
        await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease());
        await page.waitForTimeout(200);
        await expect(page.locator('#p1')).toHaveText('Paragraph 1 is deliberately slow to translate.');
    });

    test('a later stream failure leaves completed paragraphs translated, without failed markers', async ({ page, seedConfig, serviceWorker }) => {
        await seedConfig({ fluento_config_translateService: 'doubao' });
        await installDoubaoStream(serviceWorker);
        await page.goto('/progressive.html');
        await expect(page.locator('#p2 .fluento-translation')).toContainText('「译」');
        await serviceWorker.evaluate(() => (globalThis as any).__fluentoTestRelease(true));
        await expect(page.locator('#p1 .fluento-loading-retry')).toHaveCount(1);
        await expect(page.locator('#p2 .fluento-loading-retry')).toHaveCount(0);
        await expect(page.locator('#p2 .fluento-translation')).toHaveCount(1);
        await expect(page.locator('#p1 .fluento-translation')).toHaveCount(0);
    });
});
