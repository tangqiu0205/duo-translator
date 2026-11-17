// Shared metadata only: safe to import from content scripts and settings.
import { TRANSLATE_SERVICE } from '@/main/constants';
import { WEB_TRANSLATION_SERVICES } from '@/main/webTranslationConfig';
export const FREE_TRANSLATION_SERVICE = TRANSLATE_SERVICE.FREE_AUTO;
export const FREE_TRANSLATION_PROVIDERS = ['microsoft', 'google', 'yandex', 'bilibili', 'doubao', 'doubaoVolc', 'doubaoMicrosoft', ...WEB_TRANSLATION_SERVICES] as const;
export type FreeTranslationProvider = typeof FREE_TRANSLATION_PROVIDERS[number];
export interface FreeTranslationSettings {
    mode: 'balanced' | 'ordered';
    services: FreeTranslationProvider[];
}
export function defaultFreeTranslationSettings(): FreeTranslationSettings {
    return { mode: 'balanced', services: ['microsoft', 'google', 'yandex', 'bilibili'] };
}
export function readFreeTranslationSettings(value: unknown): FreeTranslationSettings {
    if (value === undefined || value === null) return defaultFreeTranslationSettings();
    const config = value as Partial<FreeTranslationSettings>;
    if (!config || !['balanced', 'ordered'].includes(config.mode || '') || !Array.isArray(config.services)
        || !config.services.length || config.services.some((id) => !(FREE_TRANSLATION_PROVIDERS as readonly unknown[]).includes(id))) {
        throw new Error('Invalid free translation settings. Configure participating services in Options → Services.');
    }
    return { mode: config.mode!, services: [...new Set(config.services)] };
}
