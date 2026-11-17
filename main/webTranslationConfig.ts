// Fixed, keyless website endpoints. These are not the vendors' paid cloud APIs.
export const WEB_TRANSLATION_SERVICES = ['transmart', 'volcengine', 'lara', 'modernMt'] as const;
export type WebTranslationService = typeof WEB_TRANSLATION_SERVICES[number];
export const WEB_TRANSLATION_ENDPOINTS: Record<WebTranslationService, string> = {
    transmart: 'https://transmart.qq.com/api/imt',
    volcengine: 'https://translate.volcengine.com/crx/translate/v1/',
    lara: 'https://webapi.laratranslate.com/translate/segmented',
    modernMt: 'https://webapi.modernmt.com/translate',
};
export function isWebTranslationService(value: string): value is WebTranslationService {
    return (WEB_TRANSLATION_SERVICES as readonly string[]).includes(value);
}
