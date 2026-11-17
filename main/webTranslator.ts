// BACKGROUND ONLY. Independent adapters for the vendors' keyless website protocols.
// Protocol reference: FluentRead's free-web.ts / free-official-web.ts; no proxy,
// account cookies, user API keys or additional language-detection requests.
import { LANGUAGES_MAP } from '@/main/constants';
import { baiduMd5 } from '@/main/baiduMd5';
import { checkPublicAbort, PublicRequestLimiter, PublicTranslationError } from '@/main/publicTranslationRuntime';
import { translatePublicMapped, type PublicTranslation, type PublicTranslationProgress } from '@/main/publicTranslationText';
import { WEB_TRANSLATION_ENDPOINTS, WEB_TRANSLATION_SERVICES, type WebTranslationService } from '@/main/webTranslationConfig';

const limiters = new Map(WEB_TRANSLATION_SERVICES.map((id) => [id, new PublicRequestLimiter(3, 1000, 2)]));
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MARKER = /^<\/?b\d+>$/;
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CHUNK_POINTS = 1000;

/** Keep Unicode graphemes and inline mapping markers whole; prefer a word boundary. */
export function* splitWebTranslationText(text: string, limit = MAX_CHUNK_POINTS): Generator<string> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid translation chunk limit');
    const atoms = text.split(/(<\/?b\d+>)/g).flatMap((part) => MARKER.test(part)
        ? [part] : Array.from(segmenter.segment(part), (item) => item.segment));
    const lengths = atoms.map((atom) => Array.from(atom).length);
    if (lengths.some((length) => length > limit)) throw new Error('A translation marker or grapheme exceeds the chunk limit');
    let start = 0;
    while (start < atoms.length) {
        let end = start, points = 0, boundary = 0;
        while (end < atoms.length && points + lengths[end] <= limit) {
            points += lengths[end];
            if (points >= limit / 2 && /[\s.!?。！？；;，,]$/u.test(atoms[end])) boundary = end + 1;
            end++;
        }
        if (end < atoms.length && boundary) end = boundary;
        yield atoms.slice(start, end).join('');
        start = end;
    }
}

function language(service: WebTranslationService, value: string | undefined, target: boolean): string {
    if (!target && !value) return service === 'transmart' || service === 'volcengine' ? 'auto' : '';
    if (!value || !LANGUAGES_MAP.has(value)) throw new PublicTranslationError(service, 'language', `Unsupported translation language: ${value}`, 400);
    if (value === 'zh-CN') return service === 'transmart' || service === 'volcengine' ? 'zh' : 'zh-CN';
    if (value === 'zh-TW') {
        if (!target && (service === 'transmart' || service === 'volcengine')) return 'zh';
        return service === 'transmart' ? 'zh-tw' : service === 'volcengine' ? 'zh-Hant' : 'zh-TW';
    }
    return value;
}

function requestPayload(service: WebTranslationService, text: string, source: string, target: string): { headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    let body: unknown;
    switch (service) {
        case 'transmart':
            body = {
                header: { fn: 'auto_translation', client_key: `browser-chrome-110.0.0-Mac OS-${crypto.randomUUID()}-${Date.now()}` },
                type: 'plain', model_category: 'normal', source: { text_list: [text], lang: source }, target: { lang: target },
            };
            break;
        case 'volcengine':
            body = { source_language: source, target_language: target, text };
            break;
        case 'lara':
            headers['X-Lara-Client'] = 'Webapp';
            body = { q: text, source, target, source_hint: '', style: 'faithful', content_type: 'text/plain', adapt_to: [], glossaries: [], instructions: [] };
            break;
        case 'modernMt': {
            const ts = Date.now();
            // Public website request checksum, not a user credential.
            const verify = baiduMd5(`webkey_E3sTuMjpP8Jez49GcYpDVH7r#${ts}#${text}`);
            headers['X-HTTP-Method-Override'] = 'GET';
            body = { q: text, source, target, ts, verify, hints: '', multiline: 'true' };
            break;
        }
    }
    return { headers, body: JSON.stringify(body) };
}

function serviceError(service: WebTranslationService, status: unknown): PublicTranslationError {
    const code = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
    return new PublicTranslationError(service, code === 429 ? 'rate-limit' : [401, 403].includes(code) ? 'auth' : 'http', `${service} translation failed (HTTP ${code})`, code);
}
function translation(service: WebTranslationService, json: any): string {
    let value: unknown;
    if (service === 'transmart') {
        if (json?.header?.ret_code !== 'succ') throw serviceError(service, json?.header?.ret_code === 'Auth-Failed' ? 403 : undefined);
        const items = json.auto_translation;
        if (Array.isArray(items) && items.length && items.every((item) => typeof item === 'string' && item.trim())) value = items.join('');
    } else if (service === 'volcengine') {
        if (json?.base_resp?.status_code !== 0) throw serviceError(service, json?.base_resp?.status_code);
        value = json.translation;
    } else {
        if (json?.status !== 200) throw serviceError(service, json?.status);
        if (service === 'modernMt') value = json.data?.translation;
        else {
            const items = json.content?.translations;
            if (Array.isArray(items) && items.length && items.every((item) => typeof item?.translation === 'string' && item.translation.trim())) {
                value = items.map((item) => item.translation).join('');
            }
        }
    }
    if (typeof value !== 'string' || !value.trim()) throw new PublicTranslationError(service, 'invalid-response', `${service} returned no valid translation`);
    return value.trim();
}

async function readJson(response: Response, service: WebTranslationService): Promise<unknown> {
    if (!response.body) throw new Error(`${service} returned an empty response`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, text = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error(`${service} response exceeds the size limit`);
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        try { return JSON.parse(text); }
        catch { throw new Error(`${service} did not return valid JSON`); }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export class WebTranslator {
    constructor(private readonly service: WebTranslationService) { }
    private request(text: string, source: string, target: string, signal?: AbortSignal | null): Promise<string> {
        const service = this.service;
        return limiters.get(service)!.run(async () => {
            const controller = new AbortController();
            const cancel = () => controller.abort(signal?.reason);
            signal?.addEventListener('abort', cancel, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException('Translation request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
            try {
                checkPublicAbort(signal);
                const payload = requestPayload(service, text, source, target);
                const response = await fetch(WEB_TRANSLATION_ENDPOINTS[service], {
                    method: 'POST', ...payload, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
                });
                if (!response.ok) {
                    void response.body?.cancel().catch(() => {});
                    throw serviceError(service, response.status);
                }
                return translation(service, await readJson(response, service));
            } catch (error) {
                checkPublicAbort(signal);
                if (controller.signal.aborted) throw new PublicTranslationError(service, 'timeout', `${service} request timed out`, 408);
                throw error;
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                controller.abort();
            }
        }, signal);
    }
    async translate(texts: string[], target: string, signal?: AbortSignal | null, source?: string, onResult?: PublicTranslationProgress): Promise<PublicTranslation[]> {
        checkPublicAbort(signal);
        if (!texts.length) return [];
        const from = language(this.service, source, false);
        const to = language(this.service, target, true);
        return translatePublicMapped(texts, async (queries, progress) => {
            const output: PublicTranslation[] = [];
            for (const query of queries) {
                let translated = '';
                // Preserve line endings locally instead of relying on provider segmentation.
                for (const line of query.split(/(\r\n|\r|\n)/g)) {
                    for (const chunk of splitWebTranslationText(line)) {
                        checkPublicAbort(signal);
                        const content = chunk.trim();
                        if (!content) { translated += chunk; continue; }
                        const before = chunk.slice(0, chunk.indexOf(content));
                        const after = chunk.slice(before.length + content.length);
                        translated += before + await this.request(content, from, to, signal) + after;
                    }
                }
                const item = { text: translated, sourceLang: source || '' };
                checkPublicAbort(signal);
                progress?.(output.length, item);
                output.push(item);
            }
            return output;
        }, signal, onResult);
    }
}
