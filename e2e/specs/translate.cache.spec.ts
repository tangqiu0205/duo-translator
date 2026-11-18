import { test, expect } from '../fixtures/extension';

test('automatic cache keeps the first successful result, with its original provider, in IndexedDB', async ({ context, page, seedConfig, extensionId, serviceWorker }) => {
    await seedConfig({
        fluento_config_translationCacheSwitch: true,
        fluento_config_freeTranslation: { mode: 'ordered', services: ['google'] },
    });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const requests: string[][] = [];
    await context.route('**/translate-pa.googleapis.com/**', async route => {
        const texts = route.request().postDataJSON()[0][0] as string[];
        requests.push(texts);
        const index = requests.length;
        if (index === 1) await hold;
        await route.fulfill({ json: [texts.map(() => index === 1 ? 'later' : 'first'), texts.map(() => 'en')] });
    });
    await context.route('https://edge.microsoft.com/**', route => route.abort());
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const translate = (service: string) => page.evaluate(async service => chrome.runtime.sendMessage({
        action: 'translateTexts', data: { service, texts: ['Concurrent sample'], targetLang: 'zh-CN' },
    }), service);
    const records = () => serviceWorker.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open('fluento-translation-cache');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        try {
            return await new Promise<{ t: string; actualService?: string }[]>((resolve, reject) => {
                const req = db.transaction('entries').objectStore('entries').getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } finally { db.close(); }
    });
    const slower = translate('freeAuto');
    try {
        await expect.poll(() => requests.length).toBe(1);
        const faster = await translate('freeAuto');
        expect(faster.data[0]).toMatchObject({ translatedMappedHtmlText: 'first', actualService: 'google' });
        await expect.poll(records).toEqual([expect.objectContaining({ t: 'first', actualService: 'google' })]);
        release();
        await slower;
        // A manual request needs to fetch separately and doesn't affect the pool.
        await translate('google');
        expect(requests.length).toBe(3);
        await serviceWorker.evaluate(() => chrome.storage.local.set({
            fluento_config_freeTranslation: { mode: 'ordered', services: ['microsoft'] },
        }));
        const hit = await translate('freeAuto');
        expect(hit.data[0]).toMatchObject({ translatedMappedHtmlText: 'first', actualService: 'google' });
        expect(requests.length).toBe(3);
    } finally { release(); await slower.catch(() => {}); }
});
