// BACKGROUND ONLY. Uses the browser's Doubao session; never reads or exports
// cookies. Protocol observations: Cometix Translate 1.32.7.113 / Doubao 1.38.0.
import { browser } from 'wxt/browser';
import { normalizeLanguageTag } from '@/main/constants';
import { sameLanguage } from '@/main/builtinAi/placeholders';
import { sseEvents } from '@/main/aiServiceShared';
import { DOUBAO_ENGINES, DOUBAO_ARTICLE_ENDPOINT, DOUBAO_SUBTITLE_ENDPOINT, DOUBAO_LAUNCH_ENDPOINT } from '@/main/publicTranslationConfig';
import { checkPublicAbort, ensurePublicHeaders, PublicRequestLimiter, PublicTranslationError } from '@/main/publicTranslationRuntime';
import { translatePublicMapped, type PublicTranslation, type PublicTranslationProgress } from '@/main/publicTranslationText';

const limiter = new PublicRequestLimiter(3, 1000, 2); // Shared by all three engines.
const DEVICE_KEY = '__fluento_doubao_translation_device'; // Device-local, not a config/sync key.
const MAX_RESPONSE_BYTES = 1_000_000;
const ARTICLE_LANGUAGES = new Set('en ja ko fr de es pt ru it ar th vi id ms tr nl pl'.split(' '));
// Numeric interop data for /samantha/plugin/translate. Unknown tags use the
// article endpoint only when it explicitly supports that language.
const SUBTITLE_LANGUAGES: Record<string, number> = {
    af: 4, ar: 8, az: 12, be: 14, bg: 15, bn: 17, bs: 22, ca: 23, cs: 28,
    cy: 31, da: 32, de: 33, el: 37, en: 38, es: 40, et: 41, eu: 42, fa: 43,
    fi: 45, fr: 48, ga: 50, gl: 53, gu: 55, he: 57, hi: 58, hr: 60, ht: 61,
    hu: 62, hy: 63, id: 66, is: 72, it: 73, ja: 75, ka: 77, kk: 80, km: 82,
    kn: 83, ko: 85, la: 92, lt: 98, lv: 100, mk: 104, ml: 105, mn: 106,
    mr: 108, ms: 109, mt: 110, my: 111, ne: 115, nl: 117, no: 119, pa: 128,
    pl: 130, pt: 132, ro: 136, ru: 137, si: 145, sk: 146, sl: 147, sq: 151,
    sr: 152, su: 154, sv: 156, sw: 157, ta: 158, te: 159, tg: 160, th: 161,
    fil: 164, tr: 167, uk: 173, ur: 174, uz: 175, vi: 177, 'zh-CN': 185, 'zh-TW': 1002,
};
export function supportsDoubaoTarget(target: string, scene?: 'subtitle'): boolean {
    return scene === 'subtitle' && SUBTITLE_LANGUAGES[target] !== undefined
        || target === 'zh-CN' || target === 'zh-TW' || ARTICLE_LANGUAGES.has(target);
}
let device: Promise<string> | undefined;
async function deviceId(): Promise<string> {
    device ??= (async () => {
        const saved = (await browser.storage.local.get(DEVICE_KEY))[DEVICE_KEY];
        if (typeof saved === 'string' && /^\d{18}$/.test(saved)) return saved;
        if (saved !== undefined) throw new Error('Doubao: invalid saved device identifier');
        const parts = crypto.getRandomValues(new Uint32Array(2));
        const id = Array.from(parts, (value) => String(100_000_000 + value % 900_000_000)).join('');
        await browser.storage.local.set({ [DEVICE_KEY]: id });
        return id;
    })();
    try { return await device; } catch (error) { device = undefined; throw error; }
}

function doubaoError(code: unknown): PublicTranslationError {
    const value = String(code ?? 'unknown');
    if (['710012000', '710012001', '710022013'].includes(value)) {
        return new PublicTranslationError('doubao', 'auth', `Doubao login is required (${value}). Open https://www.doubao.com/ and sign in in this browser.`);
    }
    if (['710012007', '676010003', '710022002', '710022004'].includes(value)) {
        return new PublicTranslationError('doubao', 'rate-limit', `Doubao is busy or rate limited (${value}). Retry later.`);
    }
    return new PublicTranslationError('doubao', 'invalid-response', `Doubao rejected the request (code ${value})`);
}
function assertCode(value: any): void {
    if (!value || ![0, '0'].includes(value.code)) throw doubaoError(value?.code);
}
function articleLanguage(target: string): string {
    if (target === 'zh-CN') return 'zh';
    if (target === 'zh-TW') return 'zh-Hant';
    if (!ARTICLE_LANGUAGES.has(target)) throw new Error(`Doubao article translation does not support target language ${target}`);
    return target;
}
interface Session { webId: string; country: string; ttWid: boolean; expires: number }

export class DoubaoTranslator {
    private session?: Session;
    private readonly tabId = crypto.randomUUID();
    constructor(private readonly service: string) {
        if (!Object.hasOwn(DOUBAO_ENGINES, service)) throw new Error('Unknown Doubao engine');
    }
    private async query(): Promise<string> {
        const id = await deviceId();
        return new URLSearchParams({
            language: 'zh', browser_language: globalThis.navigator?.language || 'en',
            device_platform: 'web', aid: '586864', real_aid: '586864', pkg_type: 'release_version',
            device_id: this.session?.ttWid ? this.session.webId : '0', tea_uuid: id, web_id: id,
            is_new_user: '0', region: this.session?.country || '', sys_region: this.session?.country || '',
            'use-olympus-account': '1', samantha_web: '1', version: '1.38.0', version_code: '20800',
            pc_version: '1.38.0', web_tab_id: this.tabId,
        }).toString();
    }
    private async request<T>(
        endpoint: string, body: unknown, accept: string, read: (response: Response) => Promise<T>, signal?: AbortSignal | null,
    ): Promise<T> {
        checkPublicAbort(signal);
        await ensurePublicHeaders('doubao');
        const url = `${endpoint}?${await this.query()}`;
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        if (encoded && new TextEncoder().encode(encoded).length > 96 * 1024) throw new Error('Doubao translation request exceeds the 96 KB limit');
        return limiter.run(async () => {
            const controller = new AbortController();
            const cancel = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException('Doubao request timed out', 'TimeoutError')), 30_000);
            try {
                checkPublicAbort(signal);
                const response = await fetch(url, {
                    method: 'POST', credentials: 'include', redirect: 'error', referrerPolicy: 'no-referrer',
                    headers: { 'Content-Type': 'application/json', Accept: accept, ...(endpoint !== DOUBAO_ARTICLE_ENDPOINT ? { 'Agw-Js-Conv': 'str' } : {}) },
                    body: encoded, signal: controller.signal,
                });
                let size = 0;
                const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, target) {
                        size += chunk.byteLength;
                        if (size > MAX_RESPONSE_BYTES) throw new Error('Doubao response exceeds the size limit');
                        target.enqueue(chunk);
                    },
                }));
                const bounded = new Response(stream ?? null, { status: response.status, headers: response.headers });
                if (!response.ok) {
                    await bounded.body?.cancel();
                    const code = response.status === 412 ? 'waf-blocked' : response.status === 429 ? 'rate-limit' : [401, 403].includes(response.status) ? 'auth' : 'http';
                    throw new PublicTranslationError('doubao', code, `Doubao HTTP ${response.status}. ${code === 'auth' ? 'Sign in at https://www.doubao.com/ and retry.' : 'Retry later or choose another service.'}`, response.status);
                }
                return await read(bounded);
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                controller.abort();
            }
        }, signal);
    }
    private async initialize(signal?: AbortSignal | null): Promise<void> {
        if (this.session && this.session.expires > Date.now()) return;
        // First-use requests may initialize independently. Each owns its abort
        // signal, so cancelling one tab never cancels another tab's login setup.
        this.session = await this.request(DOUBAO_LAUNCH_ENDPOINT, undefined, 'application/json', async (response) => {
            const json = await response.json();
            assertCode(json);
            if (!json.data || typeof json.data !== 'object') throw new Error('Doubao returned an invalid session response');
            const raw = json.data.config;
            const webId = typeof raw?.web_id === 'string' || typeof raw?.web_id === 'number' ? String(raw.web_id) : '0';
            if (webId.length > 64 || /[\r\n\0]/.test(webId)) throw new Error('Doubao returned an invalid session identifier');
            return { webId, country: typeof json.data.country === 'string' ? json.data.country.slice(0, 64) : '', ttWid: !!raw?.ttwid, expires: Date.now() + 10 * 60_000 };
        }, signal);
    }
    private async article(texts: string[], target: string, signal?: AbortSignal | null, onResult?: PublicTranslationProgress): Promise<PublicTranslation[]> {
        const output: Array<PublicTranslation | undefined> = texts.map(() => undefined);
        let missing = texts.map((_, index) => index);
        for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
            const indices = missing;
            await this.request(DOUBAO_ARTICLE_ENDPOINT, {
                raw_text: indices.map((index) => texts[index]), target_lang: articleLanguage(target), translate_service: DOUBAO_ENGINES[this.service],
            }, 'text/event-stream', async (response) => {
                if (!/^text\/event-stream\b/i.test(response.headers.get('content-type') || '') || !response.body) {
                    const json = await response.json();
                    assertCode(json);
                    throw new Error('Doubao did not return an event stream');
                }
                for await (const event of sseEvents(response.body)) {
                    if (event.event === 'done') break;
                    if (event.event !== 'json' && event.event !== 'err') continue;
                    const json = JSON.parse(event.data);
                    if (event.event === 'err') throw doubaoError(json?.code);
                    assertCode(json);
                    if (!Array.isArray(json.data?.items)) throw new Error('Doubao returned an invalid item list');
                    for (const item of json.data.items) {
                        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= indices.length || typeof item.res !== 'string') throw new Error('Doubao returned an invalid translation item');
                        const index = indices[item.index];
                        if (output[index]) continue;
                        const detected = typeof item.detect_lang === 'string' ? item.detect_lang : '';
                        const text = sameLanguage(detected, target) ? texts[index] : item.res;
                        if (!text.trim()) continue; // An empty answer is still a missing item.
                        output[index] = { text, sourceLang: normalizeLanguageTag(detected) };
                        checkPublicAbort(signal);
                        onResult?.(index, output[index]!);
                    }
                }
            }, signal);
            missing = missing.filter((index) => !output[index]);
        }
        if (missing.length) throw new Error(`Doubao omitted ${missing.length} translation item(s) after one retry`);
        return output as PublicTranslation[];
    }
    private async subtitles(texts: string[], target: string, signal?: AbortSignal | null): Promise<PublicTranslation[]> {
        const engine = DOUBAO_ENGINES[this.service];
        return this.request(DOUBAO_SUBTITLE_ENDPOINT, {
            raw_text: texts, target_lang: SUBTITLE_LANGUAGES[target], source_lang: 0,
            ...(engine === '0' ? {} : { translate_service: engine }),
        }, 'application/json', async (response) => {
            const json = await response.json();
            assertCode(json);
            if (!Array.isArray(json.data?.items) || json.data.items.length !== texts.length || json.data.items.some((item: any) => typeof item?.res !== 'string')) throw new Error('Doubao returned an incomplete subtitle batch');
            return json.data.items.map((item: { res: string }) => ({ text: item.res, sourceLang: '' }));
        }, signal);
    }
    async translate(texts: string[], target: string, signal?: AbortSignal | null, source?: string, scene?: 'subtitle', onResult?: PublicTranslationProgress): Promise<PublicTranslation[]> {
        if (!texts.length) return [];
        if (source) throw new Error('Doubao uses automatic source detection. Select Auto detect as the source language.');
        const subtitle = scene === 'subtitle' && SUBTITLE_LANGUAGES[target] !== undefined;
        if (!subtitle) articleLanguage(target); // Reject unsupported targets before using a login session.
        try {
            return await translatePublicMapped(texts, async (queries, progress) => {
                await this.initialize(signal);
                const output: PublicTranslation[] = [];
                let batch: string[] = [], chars = 0;
                const flush = async () => {
                    if (!batch.length) return;
                    const offset = output.length;
                    output.push(...await (subtitle ? this.subtitles(batch, target, signal)
                        : this.article(batch, target, signal, progress ? (index, item) => progress(offset + index, item) : undefined)));
                    batch = []; chars = 0;
                };
                for (const text of queries) {
                    if (batch.length && (chars + text.length > 6000 || batch.length >= 40)) await flush();
                    batch.push(text); chars += text.length;
                }
                await flush();
                return output;
            }, signal, onResult);
        } catch (error) {
            if (error instanceof PublicTranslationError && error.detail.code === 'auth') this.session = undefined;
            throw error;
        }
    }
}
