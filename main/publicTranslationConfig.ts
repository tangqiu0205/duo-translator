// Public protocol metadata shared by settings, background and text callers.
import { isWebTranslationService } from '@/main/webTranslationConfig';
export const BILIBILI_ENDPOINT = 'https://index-translate.bilibili.com/v1/chat/completions';
export const BILIBILI_MODELS = ['Index-Translate-35B-A3B', 'index-mt-9b', 'index-mt-2b'] as const;
export const DEFAULT_BILIBILI_MODEL = BILIBILI_MODELS[0];
export const DOUBAO_ORIGIN = 'https://www.doubao.com';
export const DOUBAO_ARTICLE_ENDPOINT = `${DOUBAO_ORIGIN}/samantha/plugin/stream_article_translate`;
export const DOUBAO_SUBTITLE_ENDPOINT = `${DOUBAO_ORIGIN}/samantha/plugin/translate`;
export const DOUBAO_LAUNCH_ENDPOINT = `${DOUBAO_ORIGIN}/alice/user/launch`;
export const DOUBAO_ENGINES: Record<string, string> = {
    doubao: '1', doubaoVolc: '0', doubaoMicrosoft: '3',
};
export function isDoubaoService(service: string): boolean {
    return Object.hasOwn(DOUBAO_ENGINES, service);
}
export function isPublicTranslationService(service: string): boolean {
    return service === 'bilibili' || isDoubaoService(service) || isWebTranslationService(service);
}
