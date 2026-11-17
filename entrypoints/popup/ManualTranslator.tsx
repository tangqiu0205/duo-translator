import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Check, ChevronDown, ChevronRight, Copy, FileText, Loader2, Maximize2, Minimize2, Send, Square, Volume2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AI_PREFIX, LANGUAGES } from '@/main/constants';
import { isDoubaoService } from '@/main/publicTranslationConfig';
import { translateTexts } from '@/main/translateClient';
import { useTts } from '@/main/aiWriting/useTts';
import type { ServiceOption } from '@/utils/service';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServiceMark } from '@/components/ui/service-mark';
import { cn } from '@/lib/cn';
import { emptyManualDraft, MANUAL_DRAFT_KEY, MANUAL_TEXT_LIMIT, prepareManualText, readManualDraft, readManualText, type ManualDraft } from './manualTranslation';

interface Props {
  services: ServiceOption[];
  defaultService: string;
  embedded?: boolean;
  onSuccess: () => void;
  pageTargetLanguage?: string;
  pageService?: string;
}

const toolClass = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-hover hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40 disabled:cursor-not-allowed';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const automaticSource = (service: string) => service.startsWith(AI_PREFIX) || isDoubaoService(service);

export function ManualTranslator({ services, defaultService, embedded = false, onSuccess, pageTargetLanguage, pageService }: Props) {
  const { t } = useTranslation();
  const [initial] = useState(() => {
    const fallback = emptyManualDraft(defaultService);
    try {
      let saved = embedded ? fallback : readManualDraft(localStorage, fallback);
      if (saved.followPage) {
        const target = pageTargetLanguage || saved.target;
        const service = pageService || saved.service;
        saved = { ...saved, service, target };
      }
      if (!services.some((option) => option.value === saved.service)) {
        saved = { ...saved, service: defaultService };
      }
      if (automaticSource(saved.service)) saved = { ...saved, source: 'auto' };
      const validLanguage = (value: string) => LANGUAGES.some((lang) => lang.value === value);
      if (!validLanguage(saved.target) || (saved.source !== 'auto' && !validLanguage(saved.source))) {
        throw new Error('Saved language is no longer supported');
      }
      return { draft: saved, error: '' };
    } catch (error) {
      return { draft: fallback, error: errorText(error) };
    }
  });
  const [draft, setDraft] = useState<ManualDraft>(initial.draft);
  const [storageError, setStorageError] = useState(initial.error);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tts = useTts();
  const isAi = draft.service.startsWith(AI_PREFIX);
  const autoSourceOnly = automaticSource(draft.service);
  const hasService = services.some((option) => option.value === draft.service);
  const canTranslate = !!draft.text.trim() && hasService && !loading;

  useEffect(() => {
    if (embedded || initial.error && draft === initial.draft) return;
    try {
      const { source, target, service, followPage } = draft;
      localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify({ source, target, service, followPage }));
      setStorageError('');
    } catch (error) {
      setStorageError(errorText(error));
    }
  }, [draft, embedded, initial]);

  const hasResult = !!draft.result;
  useEffect(() => {
    if (hasResult) onSuccess();
  }, [hasResult, onSuccess]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(144, Math.max(76, element.scrollHeight))}px`;
  }, [draft.text]);

  useEffect(() => () => {
    runRef.current++;
    abortRef.current?.abort();
    clearTimeout(copyTimer.current);
  }, []);

  const update = useCallback((patch: Partial<ManualDraft>) => {
    runRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    tts.stop();
    setLoading(false);
    setError('');
    setCopied(null);
    setExpanded(false);
    setDraft((current) => {
      const next = { ...current, ...patch, result: null };
      if (automaticSource(next.service)) next.source = 'auto';
      return next;
    });
  }, [tts.stop]);

  useEffect(() => {
    if (!draft.followPage) return;
    const target = pageTargetLanguage || draft.target;
    const service = pageService || draft.service;
    if (target === draft.target && service === draft.service) return;
    update({ target, service });
  }, [draft.followPage, pageTargetLanguage, pageService, draft.target, draft.service, update]);

  const translate = async () => {
    if (!canTranslate || abortRef.current) return;
    const run = ++runRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    tts.stop();
    try {
      const results = await translateTexts(
        draft.service, [prepareManualText(draft.service, draft.text)], draft.target,
        controller.signal, draft.source === 'auto' ? undefined : draft.source,
      );
      if (run !== runRef.current) return;
      const answer = results?.[0];
      if (!answer || typeof answer.translatedMappedHtmlText !== 'string' || !answer.translatedMappedHtmlText.trim()) {
        throw new Error(t('popupEmptyResult', 'The translation service returned no text.'));
      }
      const sourceLang = draft.source === 'auto' ? answer.sourceLang : draft.source;
      setDraft((current) => ({ ...current, result: {
        text: readManualText(draft.service, answer.translatedMappedHtmlText),
        original: draft.text, sourceLang: sourceLang || '', targetLang: draft.target, service: draft.service,
      } }));
      // Unknown source languages leave original speech disabled; never send
      // the user's text to a second provider just to enable that button.
    } catch (error) {
      if (run === runRef.current) setError(errorText(error));
    } finally {
      if (run === runRef.current) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1600);
    } catch (error) {
      setError(`${t('popupCopyFailed', 'Could not copy')}: ${errorText(error)}`);
    }
  };

  const swapSource = draft.source === 'auto' ? draft.result?.sourceLang : draft.source;
  const canSwap = !draft.followPage && !autoSourceOnly && LANGUAGES.some((language) => language.value === swapSource)
    && (!draft.result || draft.result.text.length <= MANUAL_TEXT_LIMIT);

  const languagePicker = (value: string, source: boolean) => (
    <Select value={value} disabled={source ? autoSourceOnly : draft.followPage} onValueChange={(value) => update(source ? { source: value } : { target: value })}>
      <SelectTrigger className="popup-field" aria-label={t(source ? 'popupSourceLanguage' : 'targetLanguage', source ? 'Source language' : 'Target language')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align={source ? 'start' : 'end'}>
        {source && <SelectItem value="auto">{t('popupAutoDetect', 'Auto detect')}</SelectItem>}
        {LANGUAGES.map((language) => <SelectItem key={language.value} value={language.value}>{t(language.title, language.name)}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  const actions = (key: string, text: string, lang: string) => (
    <div className="flex items-center gap-0.5">
      <button type="button" className={toolClass} title={t('copy', 'Copy')} aria-label={t(key === 'result' ? 'popupCopyTranslation' : 'popupCopyOriginal', key === 'result' ? 'Copy translation' : 'Copy original')} onClick={() => void copy(key, text)}>
        {copied === key ? <Check className="h-3.5 w-3.5 text-accent" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button type="button" className={toolClass} disabled={!lang} title={!lang ? t('popupUnknownLanguage', 'Source language could not be detected') : t('popupReadAloud', 'Read aloud')} aria-label={t(key === 'result' ? 'popupReadTranslation' : 'popupReadOriginal', key === 'result' ? 'Read translation' : 'Read original')} aria-pressed={tts.playingKey === key} onClick={() => tts.toggle(key, text, lang)}>
        {tts.playingKey === key ? <Square className="h-3 w-3 fill-current" /> : <Volume2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  );

  return (
    <section className="popup-surface flex flex-col gap-2 rounded-xl border border-line bg-surface p-3" aria-label={t('popupManualTranslation', 'Text translation')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex shrink-0 items-center gap-2 text-[14px] font-semibold"><FileText className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />{t('popupManualTranslation', 'Text translation')}</h2>
        <span className="text-right text-[10px] text-ink-mute">{t('popupTextIndependent', 'Independent of webpage settings')}</span>
      </div>

      <div className="popup-input relative overflow-hidden rounded-lg border border-line-strong focus-within:border-accent">
        <textarea ref={textareaRef} aria-label={t('popupInputPlaceholder', 'Enter text to translate…')} placeholder={t('popupInputPlaceholder', 'Enter text to translate…')} value={draft.text} maxLength={MANUAL_TEXT_LIMIT} onChange={(event) => update({ text: event.target.value })} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          void translate();
        }} rows={3} className="block min-h-[76px] max-h-36 w-full resize-y overflow-y-auto bg-transparent px-2.5 py-2 pr-8 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-mute" />
        <button type="button" disabled={!draft.text} className={cn(toolClass, 'absolute right-1 top-1')} aria-label={t('popupClearInput', 'Clear input')} onClick={() => { update({ text: '' }); textareaRef.current?.focus(); }}><X className="h-3.5 w-3.5" /></button>
      </div>

      <div className="grid grid-cols-[1fr_24px_1fr_auto] items-center gap-1.5">
        <div className="min-w-0">{languagePicker(draft.source, true)}</div>
        <button type="button" className={cn(toolClass, 'w-6')} disabled={!canSwap} title={t('popupSwapLanguages', 'Swap languages (requires a detected or selected source)')} aria-label={t('popupSwapLanguages', 'Swap languages (requires a detected or selected source)')} onClick={() => {
          if (canSwap && swapSource) update({ source: draft.target, target: swapSource, text: draft.result?.text ?? draft.text });
        }}><ArrowLeftRight className="h-4 w-4" /></button>
        <div className="min-w-0">{languagePicker(draft.target, false)}</div>
        <button type="button" disabled={!canTranslate} onClick={() => void translate()} title={t('popupTranslateShortcut', 'Translate (Ctrl/Cmd + Enter)')} className="popup-primary inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold text-accent-ink transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-80">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5 fill-current" />}
          {loading ? t('popupTranslating', 'Translating…') : t('translate', 'Translate')}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="w-[112px] shrink-0">
          <Select value={draft.service} disabled={draft.followPage} onValueChange={(service) => update({ service })}>
            <SelectTrigger className="popup-engine-field" aria-label={t('popupEngine', 'Engine')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {services.map((service) => <SelectItem key={service.value} value={service.value}><span className="flex min-w-0 items-center gap-1.5"><ServiceMark id={service.iconId} size={14} /><span className="truncate">{service.i18nKey ? t(service.i18nKey, service.label) : service.label}</span></span></SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px]" title={t('popupFollowPageHint', 'Use the webpage engine and target language without changing webpage settings')}>
          <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-accent" checked={draft.followPage} onChange={(event) => {
            const followPage = event.target.checked;
            const service = pageService || draft.service;
            update({ followPage, ...(followPage ? { service, target: pageTargetLanguage || draft.target } : {}) });
          }} />
          <span>{t('popupFollowPage', 'Follow webpage settings')}</span>
        </label>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-mute">{draft.text.length.toLocaleString()} / {MANUAL_TEXT_LIMIT.toLocaleString()}</span>
      </div>
      {isAi && <p className="text-[10px] text-ink-mute">{t('popupAiAutoDetect', 'AI engines detect the source language automatically.')}</p>}
      {isDoubaoService(draft.service) && <p className="text-[10px] text-ink-mute">{t('publicAutoSourceHint', 'This engine detects the source language automatically.')}</p>}
      {storageError && <p role="alert" className="break-words text-[11px] text-red-600">{t('popupDraftError', 'Could not load or save translation settings')}: {storageError}</p>}
      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-[12px] text-red-600"><p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{error}</p><button type="button" disabled={!canTranslate} className="mt-1 font-medium underline disabled:opacity-40" onClick={() => void translate()}>{t('popupRetry', 'Retry translation')}</button></div>}
      {draft.result && (
        <div className="rounded-[10px] border border-line bg-surface px-3 py-2" aria-label={t('popupTranslationResult', 'Translation result')}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-accent">{t('popupTranslationResult', 'Translation result')}</span>
            <div className="flex items-center">
              {actions('result', draft.result.text, draft.result.targetLang)}
              <button type="button" className={toolClass} aria-expanded={expanded} aria-label={t(expanded ? 'popupCollapseResult' : 'popupExpandResult', expanded ? 'Collapse translation' : 'Expand translation')} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
            </div>
          </div>
          <div role="status" aria-live="polite" tabIndex={0} className={cn('overflow-y-auto whitespace-pre-wrap break-words text-[14px] leading-[1.6] outline-accent', expanded ? 'max-h-64' : 'max-h-36')}>{draft.result.text}</div>
          <div className="mt-2 border-t border-line pt-1.5">
            <div className="flex items-center justify-between">
              <button type="button" className="flex h-7 items-center gap-1 text-[11px] text-ink-soft hover:text-accent" aria-expanded={originalOpen} onClick={() => setOriginalOpen((value) => !value)}>{originalOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}{t('original', 'Original')}</button>
              {actions('original', draft.result.original, draft.result.sourceLang)}
            </div>
            {originalOpen && <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-ink-soft">{draft.result.original}</p>}
          </div>
          {copied && <p role="status" className="mt-1 text-[10px] text-accent">{t('copied', 'Copied')}</p>}
        </div>
      )}
    </section>
  );
}
