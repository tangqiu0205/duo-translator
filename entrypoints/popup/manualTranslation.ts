import { TRANSLATE_SERVICE } from '@/main/constants';
import { decodeHtmlText } from '@/utils/dom';
import { isPublicTranslationService } from '@/main/publicTranslationConfig';

export const MANUAL_DRAFT_KEY = 'fluentoManualTranslationV1';
export const MANUAL_TEXT_LIMIT = 4000; // Below Microsoft's per-text truncation threshold.

export interface ManualResult {
  text: string;
  original: string;
  sourceLang: string;
  targetLang: string;
  service: string;
  actualService?: string;
}

export interface ManualDraft {
  text: string;
  source: string;
  target: string;
  service: string;
  followPage: boolean;
  result: ManualResult | null;
}

export function emptyManualDraft(service: string): ManualDraft {
  return { text: '', source: 'auto', target: 'zh-CN', service, followPage: false, result: null };
}

/**
 * Keep the legacy storage key to migrate existing settings, but never restore
 * input or results. Text translation content belongs to this popup session only.
 */
export function readManualDraft(storage: Storage, fallback: ManualDraft): ManualDraft {
  const raw = storage.getItem(MANUAL_DRAFT_KEY);
  if (!raw) return fallback;
  const value = JSON.parse(raw);
  if (!value || value.followPage !== undefined && typeof value.followPage !== 'boolean'
    || !['source', 'target', 'service'].every((key) => typeof value[key] === 'string' && value[key])) {
    throw new Error('Invalid saved translation settings');
  }
  return {
    text: '', result: null,
    source: value.source, target: value.target, service: value.service,
    followPage: value.followPage ?? false,
  };
}

// These adapters expect HTML, even though this surface accepts only plain text.
// Escape before translation and decode once after; never render provider HTML.
const HTML_SERVICES = new Set<string>([
  TRANSLATE_SERVICE.FREE_AUTO, TRANSLATE_SERVICE.GOOGLE, TRANSLATE_SERVICE.AZURE, TRANSLATE_SERVICE.GOOGLE_CLOUD,
  TRANSLATE_SERVICE.YANDEX, TRANSLATE_SERVICE.BAIDU,
]);

export function prepareManualText(service: string, text: string): string {
  if (!HTML_SERVICES.has(service) && !isPublicTranslationService(service)) return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function readManualText(service: string, text: string): string {
  return HTML_SERVICES.has(service) || isPublicTranslationService(service) ? decodeHtmlText(text) : text;
}
