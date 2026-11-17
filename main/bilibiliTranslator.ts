// BACKGROUND ONLY. The public Index-Translate service is OpenAI-compatible,
// remote (not the browser's on-device AI), and does not use account cookies.
import { AI_TASK, CONFIG_KEY, LANGUAGES_MAP } from '@/main/constants';
import { AiProvider } from '@/main/aiProvider';
import { buildPrompt, openAiChatStream } from '@/main/aiService';
import { configRepo } from '@/main/storage/configStore';
import { BILIBILI_ENDPOINT, BILIBILI_MODELS, DEFAULT_BILIBILI_MODEL } from '@/main/publicTranslationConfig';
import { checkPublicAbort, ensurePublicHeaders, PublicRequestLimiter, PublicTranslationError } from '@/main/publicTranslationRuntime';
import { translatePublicMapped, type PublicTranslation } from '@/main/publicTranslationText';

const limiter = new PublicRequestLimiter(3, 1000, 2);
export async function getBilibiliModel(): Promise<string> {
    const saved = await configRepo.get(CONFIG_KEY.BILIBILI_TRANSLATE_MODEL);
    const model = saved === undefined || saved === null || saved === '' ? DEFAULT_BILIBILI_MODEL : saved;
    if (typeof model !== 'string' || !(BILIBILI_MODELS as readonly string[]).includes(model)) {
        throw new Error('Unsupported Bilibili translation model. Select a model in Options → Services.');
    }
    return model;
}

export class BilibiliTranslator {
    constructor(private readonly modelOverride?: string) { }
    async translate(
        texts: string[], targetLang: string, signal?: AbortSignal | null, sourceLang?: string,
    ): Promise<PublicTranslation[]> {
        if (!texts.length) return [];
        if (!LANGUAGES_MAP.has(targetLang)) throw new Error(`Bilibili: unsupported target language ${targetLang}`);
        const model = this.modelOverride ?? await getBilibiliModel();
        if (!(BILIBILI_MODELS as readonly string[]).includes(model)) throw new Error(`Unsupported Bilibili model: ${model}`);
        checkPublicAbort(signal);
        const controller = new AbortController();
        const cancel = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            await ensurePublicHeaders('bilibili');
            const provider = new AiProvider('builtin-index-translate', 'custom', 'Bilibili', BILIBILI_ENDPOINT, 'not-required', model);
            return await translatePublicMapped(texts, async (queries) => Promise.all(queries.map((text) => limiter.run(async () => {
                const messages = buildPrompt({ task: AI_TASK.PAGE_TRANSLATE, payload: { text, targetLang } });
                if (sourceLang) messages[0].content += ` The source language is ${LANGUAGES_MAP.get(sourceLang)?.name || sourceLang}.`;
                let translated = '';
                try {
                    for await (const delta of openAiChatStream(provider, messages, {
                        temperature: 0, credentials: 'omit', signal: controller.signal,
                        params: { chat_template_kwargs: { enable_thinking: false } },
                    })) translated += delta;
                } catch (error) {
                    if (error instanceof Error && /HTTP 412\b/.test(error.message)) {
                        throw new PublicTranslationError('bilibili', 'waf-blocked', 'Bilibili Index-Translate blocked this request (HTTP 412). Retry later or choose another service.', 412);
                    }
                    throw error;
                }
                if (!translated.trim()) throw new Error('Bilibili Index-Translate returned no translation');
                return { text: translated.trim(), sourceLang: sourceLang || '' };
            }, controller.signal))), controller.signal);
        } finally {
            signal?.removeEventListener('abort', cancel);
            controller.abort(); // Also cancel queued siblings after a batch failure.
        }
    }
}
