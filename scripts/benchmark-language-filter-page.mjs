// Replay saved public text through a disposable Fluento build. All provider
// responses are local mocks. The build-only probes never enter release code.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'wxt';
import { chromium } from '@playwright/test';

const corpus = JSON.parse(await readFile('.output/language-filter-web-corpus.json', 'utf8'));
const directory = await mkdtemp(resolve(tmpdir(), 'fluento-page-bench-'));
const origin = 'http://localhost:5566';
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function replaceProbe(code, from, to) {
    if (code.split(from).length !== 2) throw Error(`Benchmark probe no longer matches: ${from}`);
    return code.replace(from, to);
}
let context;
try {
    await build({ mode: 'development', outDir: directory, hooks: {
        'vite:build:extendConfig': (_entries, config) => {
            config.plugins.push({ name: 'local-benchmark-only', enforce: 'pre', transform(code, id) {
                const path = id.replaceAll('\\', '/');
                if (path.endsWith('/main/noTranslateLanguageFilter.ts')) {
                    return `import {detectLocalTextLanguage as detectA} from './__tests__/fixtures/localLanguageDetectionA';
import {isNoTranslateLanguage} from './noTranslateLanguage';\n` + replaceProbe(code,
                        'skip: await shouldSkipLocalText(text, excludedLanguages, signal)',
                        `skip: document.body.dataset.bench === 'off' ? false : document.body.dataset.bench === 'A'
                            ? isNoTranslateLanguage(await detectA(text, signal), excludedLanguages)
                            : await shouldSkipLocalText(text, excludedLanguages, signal)`);
                }
                const probe = `const countEvidence = hit => { const s = globalThis.__benchEvidence ??= {lookups: 0, hits: 0}; s.lookups++; if (hit) s.hits++; };\n`;
                if (path.endsWith('/main/localLanguageDetection.ts')) return probe + replaceProbe(code,
                    'const value = cache.get(key);', 'const value = cache.get(key); countEvidence(value !== undefined);');
                if (path.endsWith('/main/__tests__/fixtures/localLanguageDetectionA.ts')) return probe + replaceProbe(code,
                    'const cached = cache.get(text);', 'const cached = cache.get(text); countEvidence(cached !== undefined);');
            } });
        },
    } });
    const extension = resolve(directory, 'chrome-mv3-dev');
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), { channel: 'chromium', headless: true,
        viewport: { width: 1500, height: 5200 }, args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    let active;
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/benchmark.html') {
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><style>p{margin:4px;font:14px/1.15 sans-serif}</style><body data-bench="${active.mode}">${active.texts.map(t => `<p>${escape(t)}</p>`).join('')}` });
        }
        if (url.hostname === 'translate-pa.googleapis.com' && url.pathname === '/v1/translateHtml' && request.method() === 'POST') {
            const texts = request.postDataJSON()[0][0];
            active.requests++; active.units += texts.length;
            return route.fulfill({ contentType: 'application/json', json: [texts.map(t => t.replace(/(<a i=\d+>)/g, '$1译文：')), texts.map(() => 'en')] });
        }
        if (['http:', 'https:'].includes(url.protocol)) return route.abort();
        return route.continue();
    });
    await context.addInitScript(() => {
        const state = window.__bench = { start: null, first: null, last: null, rendered: 0, longTasks: [] };
        new MutationObserver(() => {
            const count = document.querySelectorAll('p .fluento-translation').length;
            if (count === state.rendered) return;
            state.rendered = count;
            if (count) {
                state.first ??= performance.now();
                state.last = performance.now();
            }
        }).observe(document, { childList: true, subtree: true });
        const observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(e => e.startTime)));
        observer.observe({ type: 'longtask' });
    });
    const docs = ['en', 'fr', 'de', 'es', 'pt', 'ja', 'ko', 'zh-CN', 'zh-TW'].flatMap(lang => {
        const source = corpus.documents.find(d => d.language === lang && d.paragraphs?.length >= 24);
        return source ? [source] : [];
    });
    const records = [];
    for (let repetition = 0; repetition < 2; repetition++) for (const doc of docs) {
        const foreign = docs.find(d => d.language === (doc.language === 'en' ? 'fr' : 'en'));
        // Keep a foreign control in the first viewport so first-render is observable.
        const texts = [foreign.paragraphs[0].text, ...doc.paragraphs.slice(0, 24).map(p => p.text)];
        for (const mode of repetition ? ['C', 'A', 'off'] : ['off', 'A', 'C']) {
            await sw.evaluate(async language => chrome.storage.local.set({ fluento_config_globalSwitch: true,
                fluento_config_defaultStrategy: 'manual', fluento_config_targetLanguage: 'ru', fluento_config_translateService: 'google',
                fluento_config_aiUseForTranslatePage: false, fluento_config_translationCacheSwitch: false,
                fluento_config_floatBallSwitch: false, fluento_config_noTranslateLanguages: [language] }), doc.language);
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            const worlds = [];
            cdp.on('Runtime.executionContextCreated', e => worlds.push(e.context));
            await cdp.send('Runtime.enable');
            await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
            const cpu = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value * 1000;
            try {
                active = { mode, texts, requests: 0, units: 0 };
                await page.goto(`${origin}/benchmark.html`, { waitUntil: 'load' });
                const world = () => worlds.find(w => w.origin.startsWith(`chrome-extension://${new URL(sw.url()).host}`));
                await page.waitForFunction(() => document.querySelectorAll('p').length === 25);
                const action = async action => sw.evaluate(async ({ url, action }) => {
                    const tab = (await chrome.tabs.query({})).find(t => t.url === url);
                    await chrome.tabs.sendMessage(tab.id, { action });
                }, { url: page.url(), action });
                const evidence = async () => {
                    const result = world() && await cdp.send('Runtime.evaluate', { contextId: world().id,
                        expression: 'globalThis.__benchEvidence ?? {lookups:0,hits:0}', returnByValue: true });
                    return result?.result.value ?? { lookups: 0, hits: 0 };
                };
                // document_idle injection must be listening before the measured action.
                for (let i = 0; ; i++) {
                    try { await action('showOriginal'); break; }
                    catch (e) { if (i >= 50) throw e; await page.waitForTimeout(50); }
                }
                for (const warm of [false, true]) {
                    if (warm) { await action('showOriginal'); await page.waitForFunction(() => !document.querySelector('.fluento-translation')); }
                    active.requests = active.units = 0;
                    const before = await evidence(), cpuBefore = await cpu();
                    await page.evaluate(() => { Object.assign(window.__bench, { start: performance.now(), first: null, last: null, rendered: 0 }); });
                    await action('translate');
                    await page.waitForFunction(() => window.__bench.first !== null && performance.now() - window.__bench.last > 200 && !document.querySelector('fluento-loading'), { }, { timeout: 8000 });
                    const state = await page.evaluate(() => window.__bench);
                    const cpuMs = await cpu() - cpuBefore, after = await evidence();
                    records.push({ repetition, source: doc.url, language: doc.language, mode, warm, firstRenderMs: state.first - state.start,
                        rendererTaskCpuMs: cpuMs, longTasks: state.longTasks.filter(t => t >= state.start).length,
                        requests: active.requests, units: active.units, rendered: state.rendered,
                        cacheLookups: after.lookups - before.lookups, cacheHits: after.hits - before.hits });
                    if (mode === 'off' && state.rendered !== texts.length) throw Error(`Not all baseline units rendered: ${doc.url} ${state.rendered}/${texts.length}`);
                }
            } finally { await page.close(); }
        }
    }
    const q = (rows, key, quantile) => rows.map(r => r[key]).sort((a,b) => a-b)[Math.ceil(rows.length * quantile) - 1];
    const summary = ['off', 'A', 'C'].flatMap(mode => [false, true].map(warm => {
        const rows = records.filter(r => r.mode === mode && r.warm === warm);
        const sum = key => rows.reduce((a, r) => a + r[key], 0);
        return { mode, warm, runs: rows.length, firstRenderP50Ms: q(rows,'firstRenderMs',.5), firstRenderP95Ms: q(rows,'firstRenderMs',.95),
            rendererTaskCpuP50Ms: q(rows,'rendererTaskCpuMs',.5), longTasks: sum('longTasks'), requests: sum('requests'), units: sum('units'),
            cacheHits: sum('cacheHits'), cacheLookups: sum('cacheLookups') };
    }));
    await writeFile('.output/language-filter-page-benchmark.json', JSON.stringify({ browser: context.browser().version(),
        scope: 'Public paragraph snapshots replayed in local HTML, mocked provider, cold and same-document restore/retranslate. CPU includes page pipeline and settling overhead. A hits are paragraph verdicts; C hits are evidence lookups.', summary, records }, null, 2));
    console.table(summary);
} finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
}
