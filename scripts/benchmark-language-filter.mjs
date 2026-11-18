// Offline A/C comparison using a disposable, network-disabled extension.
// No Fluento profile, translation provider, credentials or downloaded model.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';

// Vite is WXT's existing dependency, not an additional benchmark dependency.
const { build } = await import(pathToFileURL(createRequire(import.meta.resolve('wxt')).resolve('vite')).href);

const root = fileURLToPath(new URL('../', import.meta.url));
const web = process.argv.includes('--web');
const corpusPath = resolve(root, '.output/language-filter-web-corpus.json');
const webCorpus = web ? JSON.parse(await readFile(corpusPath, 'utf8')) : null;
const modulePath = path => JSON.stringify(resolve(root, path).replaceAll('\\', '/'));
const entry = `
import * as A from ${modulePath('main/__tests__/fixtures/localLanguageDetectionA.ts')};
import * as C from ${modulePath('main/localLanguageDetection.ts')};
import { browser } from 'wxt/browser';
import { isNoTranslateLanguage } from ${modulePath('main/noTranslateLanguage.ts')};
import { languageFilterCorpus as corpus } from ${modulePath('main/__tests__/fixtures/languageFilterCorpus.ts')};
const native = chrome.i18n.detectLanguage.bind(chrome.i18n);
globalThis.runLanguageFilterBenchmark = async (strategy, mode, warm, iterations, webItems) => {
    const implementation = strategy === 'A' ? A : C;
    const decide = async item => {
        const languages = new Set(item.languages);
        return strategy === 'A'
            ? isNoTranslateLanguage(await A.detectLocalTextLanguage(item.text), languages)
            : C.shouldSkipLocalText(item.text, languages);
    };
    browser.i18n.detectLanguage = mode === 'browser' ? async text => {
        globalThis.__languageBenchStats.nativeCalls++;
        return native(text);
    } : undefined;
    const records = [];
    // Warm shared OpenCC converters outside the measured corpus.
    globalThis.__languageBenchStats = { nativeCalls: 0, statisticalCalls: 0, statisticalCpuMs: 0 };
    await decide(corpus.find(item => item.id === 'Chinese-target'));
    if (webItems) {
        implementation.resetLocalLanguageCache();
        if (warm) for (const item of webItems) await decide(item);
    }
    for (let iteration = 0; iteration < iterations; iteration++) {
        for (const item of webItems ?? corpus) {
            if (!webItems) {
                implementation.resetLocalLanguageCache();
                if (warm) await decide(item);
            }
            globalThis.__languageBenchStats = { nativeCalls: 0, statisticalCalls: 0, statisticalCpuMs: 0 };
            const start = performance.now();
            const skip = await decide(item);
            records.push({ id: item.id, iteration, skip, mustTranslate: item.mustTranslate, scenario: item.scenario, sourceLanguage: item.sourceLanguage,
                elapsedMs: performance.now() - start, ...globalThis.__languageBenchStats });
        }
    }
    return records;
};
`;
const built = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': root } },
    plugins: [{
        name: 'offline-language-benchmark',
        enforce: 'pre',
        resolveId(id) {
            if (id.replaceAll('\\', '/').endsWith('/__language_bench__.js')) return '\0virtual:language-benchmark';
            if (id === 'wxt/browser' || id === 'franc') return `\0${id}`;
        },
        load(id) {
            if (id === '\0virtual:language-benchmark') return entry;
            if (id === '\0wxt/browser') return 'export const browser = { i18n: {} };';
            if (id === '\0franc') return `
                import { francAll as actual } from ${modulePath('node_modules/franc/index.js')};
                export function francAll(...args) {
                    const start = performance.now();
                    try { return actual(...args); }
                    finally {
                        globalThis.__languageBenchStats.statisticalCalls++;
                        globalThis.__languageBenchStats.statisticalCpuMs += performance.now() - start;
                    }
                }
            `;
        },
    }],
    build: { write: false, minify: false, lib: { entry: resolve(root, '__language_bench__.js'), name: 'LanguageBenchmark', formats: ['iife'] } },
});
const bundle = (Array.isArray(built) ? built : [built]).flatMap(result => result.output).find(output => output.type === 'chunk').code;
const directory = await mkdtemp(resolve(tmpdir(), 'fluento-language-benchmark-'));
let context;
try {
    const extension = resolve(directory, 'extension');
    await mkdir(extension);
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Fluento offline language benchmark', version: '0.0.0',
        background: { service_worker: 'background.js' },
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none'" },
    }));
    await writeFile(resolve(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    await writeFile(resolve(extension, 'bench.html'), '<!doctype html><title>Offline language benchmark</title>');
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
        channel: 'chromium', headless: true,
        args: ['--headless=new', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https?:\/\//, route => route.abort());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/bench.html`);
    await page.evaluate(bundle);
    const groups = [];
    const webItems = webCorpus?.documents.flatMap(doc => (doc.paragraphs ?? []).map(p => ({ ...p, sourceLanguage: doc.language })));
    if (web && !webItems?.length) throw Error('No web paragraphs; run the collector first');
    const scenarios = webItems ? ['same', 'other'] : ['synthetic'];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
    const taskSeconds = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
    const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
    for (const scenario of scenarios) for (const mode of ['browser', 'franc']) {
        const items = webItems?.map(p => ({ ...p, scenario, languages: [scenario === 'same' ? p.sourceLanguage : p.sourceLanguage === 'zh-CN' ? 'zh-TW' : 'zh-CN'] }));
        for (const warm of [false, true]) {
            for (const strategy of ['A', 'C']) {
                if (web && warm) continue; // Same-pass reuse; a 2308-item warm replay would mostly measure eviction.
                const before = await taskSeconds();
                const measured = await page.evaluate(async ({ strategy, mode, warm, items }) => {
                    const longTasks = [];
                    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
                    observer.observe({ type: 'longtask' });
                    try {
                        const records = await globalThis.runLanguageFilterBenchmark(strategy, mode, warm, items ? 1 : 5, items);
                        await new Promise(resolve => setTimeout(resolve, 0));
                        return { records, longTasks };
                    } finally { observer.disconnect(); }
                }, { strategy, mode, warm, items });
                const rendererTaskCpuMs = ((await taskSeconds()) - before) * 1000;
                const { records, longTasks } = measured;
                const n = records.length;
                groups.push({ strategy, mode, warm, scenario, samples: n, rendererTaskCpuMs, longTaskCount: longTasks.length,
                    averageNativeCalls: records.reduce((sum, row) => sum + row.nativeCalls, 0) / n,
                    p95NativeCalls: quantile(records.map(row => row.nativeCalls), .95),
                    statisticalCalls: records.reduce((sum, row) => sum + row.statisticalCalls, 0),
                    statisticalCpuMs: records.reduce((sum, row) => sum + row.statisticalCpuMs, 0),
                    paragraphP50Ms: quantile(records.map(row => row.elapsedMs), .5),
                    paragraphP95Ms: quantile(records.map(row => row.elapsedMs), .95),
                    skipFraction: records.filter(row => row.skip).length / n,
                    zeroDetectorCallFraction: records.filter(row => row.nativeCalls + row.statisticalCalls === 0).length / n,
                    falseSkipIds: [...new Set(records.filter(row => row.skip && row.mustTranslate).map(row => row.id))],
                    records,
                });
            }
        }
    }
    const regressions = groups.filter(group => group.strategy === 'C').flatMap(candidate => {
        const baseline = groups.find(group => group.strategy === 'A' && group.mode === candidate.mode && group.warm === candidate.warm && group.scenario === candidate.scenario);
        return candidate.falseSkipIds.filter(id => !baseline.falseSkipIds.includes(id)).map(id => ({ mode: candidate.mode, warm: candidate.warm, id }));
    });
    const report = { generatedAt: new Date().toISOString(), browser: context.browser().version(),
        scope: web ? `${webCorpus.uniqueParagraphs} distinct Wikipedia paragraphs, initially empty cache with normal reuse during each pass; two exclusion scenarios.` : '30 hand-labelled synthetic paragraphs, 5 iterations; browser.i18n and real francAll. Cold: reset before each paragraph; warm: immediate repeat. No translation requests.',
        limitations: web ? 'Wikipedia only. Document languages are weak labels, not ground truth. Skip fractions are not accuracy. CPU includes the benchmark harness; no end-to-end translation metrics in this run.' : 'Not representative real-web accuracy, end-to-end first translation latency, or total detector CPU. Statistical CPU is only time inside francAll. Zero detector calls is not a cache-hit-rate measurement. False-skip labels are hand-authored.',
        regressions, groups };
    await mkdir(resolve(root, '.output'), { recursive: true });
    const destination = resolve(root, web ? '.output/language-filter-web-benchmark.json' : '.output/language-filter-benchmark.json');
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, groups: groups.map(({ records, ...group }) => group), destination }, null, 2));
    if (regressions.length) process.exitCode = 1;
} finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
}
