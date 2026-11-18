// Fetch only explicitly listed public encyclopedia pages. No accounts/providers.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = JSON.parse(await readFile(resolve(root, 'benchmarks/language-filter/sources.json'), 'utf8'));
const destination = resolve(root, '.output/language-filter-web-corpus.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const documents = [];
let cursor = 0;
async function worker() {
    while (cursor < sources.length) {
        const index = cursor++, source = sources[index];
        if (!/^https:\/\/[a-z]+\.wikipedia\.org\//.test(source.url)) throw Error(`Unapproved source: ${source.url}`);
        let dom;
        try {
            const response = await fetch(source.url, {
                headers: { 'User-Agent': 'FluentoLocalBenchmark/1.0 (public encyclopedia sampling)' },
                signal: AbortSignal.timeout(25_000),
            });
            if (!response.ok) throw Error(`HTTP ${response.status}`);
            const html = await response.text();
            if (Buffer.byteLength(html) > 8_000_000) throw Error('HTML exceeds 8MB sample budget');
            // No scripts or external resources run. Removing styles also avoids
            // irrelevant jsdom CSS parser work while extracting source text.
            dom = new JSDOM(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''), { url: response.url });
            const doc = dom.window.document;
            const article = doc.querySelector('#mw-content-text .mw-parser-output')
                ?? doc.querySelector('.mw-parser-output') ?? doc.querySelector('body');
            if (!article) throw Error('Article body missing');
            const paragraphs = [];
            for (const [position, element] of [...article.querySelectorAll('p')].entries()) {
                if (element.closest('table, nav, aside, footer, .reflist, .references, .navbox, .metadata, .hatnote')) continue;
                const copy = element.cloneNode(true);
                copy.querySelectorAll('sup.reference, .mw-editsection, .mwe-math-element, math, svg').forEach(node => node.remove());
                const text = copy.textContent.normalize('NFC').replace(/\s+/gu, ' ').trim();
                if (text.length < 2 || text.length > 16_384) continue;
                paragraphs.push({ id: hash(text), position, text });
            }
            if (!paragraphs.length) throw Error('No article paragraphs extracted');
            const permalink = [...doc.querySelectorAll('a[href*="oldid="]')].map(a => a.href)[0] ?? null;
            documents.push({ ...source, sourceIndex: index, finalUrl: response.url, fetchedAt: new Date().toISOString(),
                title: doc.title, declaredLanguage: doc.documentElement.lang,
                htmlSha256: hash(html), permalink,
                license: 'CC BY-SA (see source page revision/license footer)',
                licenseUrl: 'https://en.wikipedia.org/wiki/Wikipedia:Copyrights', paragraphs });
            console.log(`${source.language}: ${paragraphs.length} paragraphs ${source.url}`);
        } catch (error) {
            documents.push({ ...source, sourceIndex: index, error: error.message });
            console.error(`FAILED ${source.url}: ${error.message}`);
        } finally { dom?.window.close(); }
    }
}
await Promise.all([worker(), worker()]);
documents.sort((a, b) => a.sourceIndex - b.sourceIndex);
const seen = new Set();
for (const doc of documents) if (doc.paragraphs) {
    doc.paragraphs = doc.paragraphs.filter(paragraph => {
        if (seen.has(paragraph.id)) return false;
        seen.add(paragraph.id); return true;
    });
}
const report = { generatedAt: new Date().toISOString(),
    labelPolicy: 'Document language is ONLY a weak source-language proxy, NOT paragraph gold truth. No detector was used to label text. Mixed-language/quoted passages require independent review.',
    extraction: 'Published p elements, excluding tables/navigation/references; citation superscripts and math removed; NFC and whitespace normalization; exact normalized-text SHA256 deduplication across all sources.',
    documents, uniqueParagraphs: seen.size };
await mkdir(resolve(root, '.output'), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ destination, uniqueParagraphs: seen.size,
    successfulSources: documents.filter(doc => !doc.error).length, failedSources: documents.filter(doc => doc.error).length }));
if (documents.some(doc => doc.error) || seen.size < 2000) process.exitCode = 1;
