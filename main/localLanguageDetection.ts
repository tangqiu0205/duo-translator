// Local-only language evidence shared by page decisions and paragraph filters.
// Native i18n detection runs on the browser, not a translation provider. The
// statistical fallback intentionally prefers false negatives over lost text.
import { browser } from 'wxt/browser';
import { francAll } from 'franc';
import { iso6393To1Map, normalizeLanguageTag } from '@/main/constants';
import { toSimplified, toTraditional } from '@/utils/language';
import { PageTranslationQueue } from '@/main/pageTranslationQueue';
import { isNoTranslateLanguage } from '@/main/noTranslateLanguage';

const UNKNOWN = 'und';
const MAX_TEXT_LENGTH = 4096;
const MAX_SEGMENTS = 12;
const CACHE_LIMIT = 512;
const cache = new Map<string, string>();
const detectorQueue = new PageTranslationQueue(2);
let warnedNativeFailure = false;
interface NativeResult { isReliable: boolean; languages: Array<{ language: string; percentage: number }> }

export function resetLocalLanguageCache(): void { cache.clear(); }

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function nativeDetection(text: string, deadline: number, signal?: AbortSignal): Promise<NativeResult | undefined> {
    checkAbort(signal);
    const detect = browser.i18n?.detectLanguage;
    const remaining = deadline - performance.now();
    if (typeof detect !== 'function' || remaining <= 0) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Start BEFORE entering the queue: queued and active work share the deadline.
    const timer = setTimeout(abort, remaining);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
        return await detectorQueue.run(() => {
            if (performance.now() >= deadline) return Promise.resolve(undefined);
            return new Promise<NativeResult | undefined>((resolve, reject) => {
                let settled = false;
                const finish = (result?: NativeResult, error?: unknown) => {
                    if (settled) return;
                    settled = true;
                    controller.signal.removeEventListener('abort', cancelled);
                    if (error) reject(error); else resolve(result);
                };
                const cancelled = () => finish(undefined, new DOMException('Aborted', 'AbortError'));
                controller.signal.addEventListener('abort', cancelled, { once: true });
                if (controller.signal.aborted) { cancelled(); return; }
                Promise.resolve().then(() => {
                    checkAbort(controller.signal);
                    return browser.i18n.detectLanguage(text);
                }).then(result => finish(result), error => {
                    if (!warnedNativeFailure && !controller.signal.aborted) {
                        warnedNativeFailure = true;
                        console.warn('Fluento: local browser language detection unavailable; using conservative statistical fallback', error);
                    }
                    finish(undefined, error);
                });
            });
        }, () => 0, controller.signal);
    } catch (error) {
        checkAbort(signal);
        if (controller.signal.aborted) return undefined; // Our deadline, not user cancellation.
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

/** Reject mixed scripts before a dominant-language guess can hide foreign text. */
function scriptEvidence(text: string): { language?: string; ambiguous: boolean } {
    const scripts = new Set<string>();
    let han = 0, kana = 0, hangul = 0;
    for (const character of text) {
        if (!/\p{L}/u.test(character)) continue;
        if (/\p{Script=Han}/u.test(character)) { scripts.add('Han'); han++; }
        else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) { scripts.add('Kana'); kana++; }
        else if (/\p{Script=Hangul}/u.test(character)) { scripts.add('Hangul'); hangul++; }
        else if (/\p{Script=Latin}/u.test(character)) scripts.add('Latin');
        else if (/\p{Script=Cyrillic}/u.test(character)) scripts.add('Cyrillic');
        else if (/\p{Script=Arabic}/u.test(character)) scripts.add('Arabic');
        else if (/\p{Script=Devanagari}/u.test(character)) scripts.add('Devanagari');
        else if (/\p{Script=Greek}/u.test(character)) scripts.add('Greek');
        else if (/\p{Script=Hebrew}/u.test(character)) scripts.add('Hebrew');
        else if (/\p{Script=Thai}/u.test(character)) scripts.add('Thai');
        else scripts.add('Other');
    }
    if (kana) return { language: kana >= 4 && han + kana >= 12 && [...scripts].every(script => script === 'Han' || script === 'Kana') ? 'ja' : undefined, ambiguous: true };
    if (hangul) return { language: hangul >= 12 && scripts.size === 1 ? 'ko' : undefined, ambiguous: true };
    if (han) {
        if (scripts.size !== 1 || han < 12) return { ambiguous: true };
        const traditional = toSimplified(text) !== text;
        const simplified = toTraditional(text) !== text;
        // Shared Han characters are not proof of Chinese rather than Japanese;
        // mixed simplified/traditional spelling is uncertain as well.
        return { language: traditional !== simplified ? traditional ? 'zh-TW' : 'zh-CN' : undefined, ambiguous: true };
    }
    return { ambiguous: scripts.size !== 1 || scripts.has('Other') };
}

// Undefined means transient API failure without usable fallback evidence.
async function identifySegmentUncached(text: string, paragraph: boolean, deadline: number, signal?: AbortSignal): Promise<string | undefined> {
    checkAbort(signal);
    if (performance.now() >= deadline) return UNKNOWN;
    const scripts = scriptEvidence(text);
    if (scripts.language) return scripts.language;
    if (scripts.ambiguous) return UNKNOWN;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const words = text.match(/\p{L}[\p{L}\p{M}'’-]*/gu)?.length ?? 0;
    const wordSeparated = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Hebrew}]/u.test(text);
    if (letters < (paragraph ? 80 : 32) || wordSeparated && words < (paragraph ? 12 : 6)) return UNKNOWN;
    let native: NativeResult | undefined;
    let nativeFailed = false;
    try { native = await nativeDetection(text, deadline, signal); }
    catch {
        checkAbort(signal);
        nativeFailed = true; // The native boundary already logs failure once.
    }
    checkAbort(signal);
    if (performance.now() >= deadline) return UNKNOWN;
    if (native) {
        const ranked = [...native.languages].sort((a, b) => b.percentage - a.percentage);
        const first = ranked[0];
        const language = normalizeLanguageTag(first?.language ?? '');
        return native.isReliable && first && first.percentage >= 85
            && first.percentage - (ranked[1]?.percentage ?? 0) >= 60
            && language && language !== UNKNOWN && language !== 'auto' ? language : UNKNOWN;
    }
    // franc only inspects its first 2048 code units. Never accept a guess that
    // could conceal a different-language tail outside that library budget.
    if (text.length > 2048) return nativeFailed ? undefined : UNKNOWN;
    const ranked = francAll(text, { minLength: 10 });
    const first = ranked[0];
    // Scores are relative distances, NOT probabilities. A narrow lead or an
    // unsupported language is deliberately insufficient evidence for exclusion.
    const language = first && first[0] !== UNKNOWN && first[1] - (ranked[1]?.[1] ?? 0) >= 0.1
        ? iso6393To1Map.get(first[0]) || UNKNOWN : UNKNOWN;
    return nativeFailed && language === UNKNOWN ? undefined : language;
}

function readEvidence(key: string): string | undefined {
    const value = cache.get(key);
    if (value !== undefined) {
        cache.delete(key);
        cache.set(key, value); // Refresh LRU position, including stable uncertainty.
    }
    return value;
}

async function identifySegment(text: string, paragraph: boolean, deadline: number, signal?: AbortSignal): Promise<string> {
    checkAbort(signal);
    if (performance.now() >= deadline) return UNKNOWN;
    const key = `${paragraph ? 'paragraph' : 'fragment'}:${text}`;
    const cached = readEvidence(key);
    if (cached !== undefined) return cached;
    if (!paragraph) {
        // Stronger whole-text evidence can serve a fragment, never the reverse.
        const whole = readEvidence(`paragraph:${text}`);
        if (whole !== undefined && whole !== UNKNOWN) return whole;
    }
    const language = await identifySegmentUncached(text, paragraph, deadline, signal);
    checkAbort(signal);
    // Timeouts are transient. Do not cache them or late browser replies.
    if (performance.now() >= deadline) return UNKNOWN;
    if (language !== undefined) {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(key, language);
    }
    return language ?? UNKNOWN;
}

function normalizeDetectionText(value: string): string {
    return value.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/[^\S\n]+/gu, ' ').trim();
}

function removeExplicitUrls(text: string): string {
    // Keep prose punctuation outside the token even when there is no space.
    // URL parsing alone is not proof: it accepts raw Unicode in a URL path,
    // so keep ambiguous Unicode tokens for language detection.
    return text.replace(/\bhttps?:\/\/[^\s<>"“”‘’「」『』。．｡！？、，；：]+/giu, token => {
        if (/[^\x21-\x7E]/.test(token)) return token;
        try { return new URL(token).hostname ? ' ' : token; }
        catch { return token; }
    }).trim();
}

function meaningfulSegments(text: string): string[] {
    // Paired single quotes are boundaries; apostrophes within words are not.
    const quoted = text.replace(/(^|[\s([{])'([^'\n]+)'(?=$|[\s.,!?;:)\]}])/gu, '$1\n$2\n');
    return quoted.split(/[\n.!?。！？;；“”"「」『』]+/u)
        .map(part => part.trim()).filter(part => /\p{L}/u.test(part));
}

async function inspectLocalText(value: string, signal?: AbortSignal, skipLanguages?: Set<string>): Promise<string> {
    checkAbort(signal);
    const deadline = performance.now() + 1500;
    if (value.length > MAX_TEXT_LENGTH * 4) return UNKNOWN;
    const normalized = normalizeDetectionText(value);
    if (!normalized || normalized.length > MAX_TEXT_LENGTH) return UNKNOWN;
    const text = removeExplicitUrls(normalized);
    const segments = meaningfulSegments(text);
    if (!segments.length || segments.length > MAX_SEGMENTS) return UNKNOWN;
    const language = await identifySegment(text, true, deadline, signal);
    if (language === UNKNOWN) return UNKNOWN;
    if (skipLanguages && !isNoTranslateLanguage(language, skipLanguages)) return UNKNOWN;
    if (segments.length > 1) {
        for (const segment of segments) {
            const detected = await identifySegment(segment, false, deadline, signal);
            // Request-time filtering admits different languages only when ALL
            // are skippable. Page identification still requires one language.
            if (skipLanguages ? !isNoTranslateLanguage(detected, skipLanguages) : detected !== language) return UNKNOWN;
        }
    }
    checkAbort(signal);
    return performance.now() < deadline ? language : UNKNOWN;
}

export function detectLocalTextLanguage(value: string, signal?: AbortSignal): Promise<string> {
    return inspectLocalText(value, signal);
}

export async function shouldSkipLocalText(value: string, languages: Set<string>, signal?: AbortSignal): Promise<boolean> {
    checkAbort(signal);
    if (languages.size === 0) return false;
    return isNoTranslateLanguage(await inspectLocalText(value, signal, languages), languages);
}
