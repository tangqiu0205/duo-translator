import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, ChevronDown, ChevronRight, EyeOff, Globe, HelpCircle, Languages, Monitor, Moon, PenLine, ScanText, Settings as SettingsIcon, SlidersHorizontal, Sparkles, Sun } from 'lucide-react';

import {
  ACTION,
  APP_NAME,
  APP_NAME_PASCAL_CASE,
  CONFIG_KEY,
  browserTargetLanguage,
  DB_ACTION,
  DEFAULT_STRATEGY,
  DEFAULT_STRATEGY_OPTIONS,
  DEFAULT_VALUE,
  DOMAIN_STRATEGY,
  LANGUAGES,
  STORAGE_ACTION,
  TAB_ACTION,
  TRANSLATE_ACTION,
  TRANSLATE_SERVICES,
  TRANSLATE_STATUS_KEY,
  TranslateServiceMeta,
  VIEW_STRATEGY,
} from '@/main/constants';
import type { AiProvider } from '@/main/aiProvider';
import { sendMessageToAllTabs, sendMessageToBackground, sendMessageToTab } from '@/utils/message';
import { cn } from '@/lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ServiceMark } from '@/components/ui/service-mark';
import { Switch } from '@/components/ui/switch';
import { Browser, browser } from 'wxt/browser';
import { buildServiceOptions, getAiTranslateService, getTranslateService, resolveActiveService, type ServiceOption } from '@/utils/service';
import { THEME_OPTIONS, useResolvedTheme, useThemeSetting, type ThemeSetting } from '@/utils/theme';
import { loadPopupPrefs, usePopupPrefs, type PopupPrefs } from '@/utils/popupPrefs';
import { cachedPopupHeight, rememberPopupHeight } from './popupHeight';
import { ManualTranslator } from './ManualTranslator';

const getConfig = (name: string) =>
  sendMessageToBackground({ action: DB_ACTION.CONFIG_GET, data: { name } });

const setConfig = (name: string, value: unknown) =>
  sendMessageToBackground({ action: DB_ACTION.CONFIG_SET, data: { name, value } });

const iconBtnCls =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors duration-150 hover:bg-hover hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

// Sentinel for "follow the page translation" in the selection-service picker.
// Stored as "" (that is what the selection popup reads), but Radix Select
// refuses an item whose value is the empty string, hence the placeholder.
const FOLLOW_PAGE = '__follow__';

type AppProps = {
  /**
   * Rendered inside another page (the Options preview) rather than as the
   * toolbar popup itself. Only measurement cares: an embedded copy sits in a
   * page whose height it does not control, so recording it would hand the real
   * popup a height it never had.
   */
  embedded?: boolean;
  /**
   * Which sections to show, supplied from outside instead of read from config.
   *
   * The Options preview passes the settings AS CONFIGURED, ignoring the card's
   * master switch — that switch decides whether the real popup obeys them, and
   * a preview that jumped back to the full popup the moment it was turned off
   * would hide exactly what the user is adjusting.
   */
  uiPrefs?: PopupPrefs;
};

export default function App({ embedded = false, uiPrefs }: AppProps = {}) {
  const { t } = useTranslation();
  /**
   * Which pieces of this popup the user chose to surface — Options ›
   * Customization › Extension popup. Everything is shown by default, and the
   * switches only hide controls: none of them changes the setting behind one.
   *
   * Two forms, and they must not be collapsed into one. `livePopupPrefs` (the
   * hook) answers with the defaults until storage hydrates, which the popup
   * cannot paint with: its window is sized to its content, so drawing every
   * section once and then dropping the hidden ones snaps the window from full
   * height down to the trimmed height in front of the user. `ui` is therefore
   * the AWAITED answer, resolved as part of the hydration below and gating the
   * first paint; the hook only feeds later edits back in.
   */
  const livePopupPrefs = usePopupPrefs();
  const [resolvedUi, setResolvedUi] = useState<PopupPrefs | null>(null);
  // A caller-supplied set wins outright — it is not a default to fall back to.
  const ui = uiPrefs ?? resolvedUi;
  const uiResolvedRef = useRef(false);
  // Gated on an awaited read having landed — this effect also runs on mount,
  // when the hook is still on the defaults, and taking those would put the
  // flash straight back.
  useEffect(() => {
    if (uiResolvedRef.current) setResolvedUi(livePopupPrefs);
  }, [livePopupPrefs]);

  /**
   * How tall the placeholder above is, and where the next open gets its answer.
   *
   * Read once per open, before rendering: `cachedPopupHeight` is a synchronous
   * localStorage read precisely because nothing async can inform a first paint.
   * See popupHeight.ts for why the placeholder needs a height at all.
   */
  const [placeholderHeight] = useState(cachedPopupHeight);
  const rootRef = useRef<HTMLDivElement>(null);
  const heightRecorded = useRef(false);
  // Layout effect, not a plain one: it reads a laid-out box, and doing that
  // after paint would mean recording a height the user has already seen change.
  useLayoutEffect(() => {
    if (embedded || heightRecorded.current) return;
    const el = rootRef.current;
    if (!el) return;
    heightRecorded.current = true;
    rememberPopupHeight(el.offsetHeight);
  });

  const [globalOn, setGlobalOn] = useState(true);
  const [mode, setMode] = useState<VIEW_STRATEGY>(VIEW_STRATEGY.DOUBLE);
  const [targetLanguage, setTargetLanguage] = useState(browserTargetLanguage());
  const [service, setService] = useState<string>();
  const [translateActive, setTranslateActive] = useState(false);
  const [defaultStrategy, setDefaultStrategy] = useState<DEFAULT_STRATEGY>(DEFAULT_STRATEGY.AUTO);
  const [siteRule, setSiteRule] = useState<DOMAIN_STRATEGY>(DOMAIN_STRATEGY.AUTO);
  // Per-domain "translate all elements": drops the user's own exclusions (the
  // no-translate areas and the website rules) for this site.
  const [translateAllElements, setTranslateAllElements] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const [domain, setDomain] = useState('');
  const [ready, setReady] = useState(false);
  // Enabled AI providers (filtered by the per-card Use-for-page toggle).
  // Appended below the built-in translation services in the dropdown.
  const [aiProviders, setAiProviders] = useState<AiProvider[]>([]);
  const [translateServices, setTranslateServices] = useState<TranslateServiceMeta[]>([]);
  // Every enabled AI provider, NOT gated on AI_USE_FOR_TRANSLATE_PAGE: that
  // toggle only governs page translation, while the three services below
  // (selection / AI writing / video subtitles) may always route through AI.
  const [otherAiProviders, setOtherAiProviders] = useState<AiProvider[]>([]);
  // "Other translation services" — the three non-page surfaces. Selection
  // stores "" for "follow the page translation"; the other two always hold a
  // concrete service key.
  const [selectionService, setSelectionService] = useState<string>('');
  const [aiWritingService, setAiWritingService] = useState<string>(DEFAULT_VALUE.AI_TRANSLATE_SERVICE);
  const [videoService, setVideoService] = useState<string>(DEFAULT_VALUE.VIDEO_SUBTITLE_TRANSLATE_SERVICE);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const collapsePageSettings = useCallback(() => setPageSettingsOpen(false), []);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  // Reactive theme views — the setting drives the menu check mark, the
  // resolved value picks the sun/moon button icon (system follows the OS).
  const themeSetting = useThemeSetting();
  const resolvedTheme = useResolvedTheme();
  let tabId: number | undefined

  // Close the "More" menu when clicking outside of it.
  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [moreOpen]);

  // Close the theme menu when clicking outside of it.
  useEffect(() => {
    if (!themeMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [themeMenuOpen]);

  const onThemeChange = (v: ThemeSetting) => {
    setThemeMenuOpen(false);
    // The storage change event feeds back through the reactive store and the
    // page-level watcher (initExtensionPageTheme), which restyles this popup
    // and every other open surface — no manual DOM work here.
    void setConfig(CONFIG_KEY.THEME, v);
  };

  // Hydrate from background storage on mount
  useEffect(() => {
    console.debug("popup loaded")
    let cancelled = false;
    const listener = (message: any, sender: Browser.runtime.MessageSender, sendResponse: (response?: any) => void) => {
      if (message.action === TRANSLATE_ACTION.TRANSLATE_STATUS_CHANGED) {
        console.debug("receive message:", message, tabId)
        if (tabId !== undefined && message.data.tabId === tabId && typeof message.data.status === 'boolean') {
          setTranslateActive(message.data.status)
        }
      }
    }
    browser.runtime.onMessage.addListener(listener);

    (async () => {
      const [gs, vs, tl, ts, ds, bh, d, id, selSvc, aiSvc, vidSvc, popupPrefs]: [
        boolean, VIEW_STRATEGY, string | undefined, string | undefined, DEFAULT_STRATEGY, boolean,
        string | undefined, number | undefined, string | undefined, string | undefined, string | undefined,
        PopupPrefs
      ] = await Promise.all([
        getConfig(CONFIG_KEY.GLOBAL_SWITCH),
        getConfig(CONFIG_KEY.VIEW_STRATEGY),
        getConfig(CONFIG_KEY.TARGET_LANGUAGE),
        getConfig(CONFIG_KEY.TRANSLATE_SERVICE),
        getConfig(CONFIG_KEY.DEFAULT_STRATEGY),
        getConfig(CONFIG_KEY.BILINGUAL_HIGHLIGHTING_SWITCH),
        sendMessageToBackground({ action: TAB_ACTION.TAB_DOMAIN_GET }),
        sendMessageToBackground({ action: TAB_ACTION.ID_GET }),
        getConfig(CONFIG_KEY.SELECTION_TRANSLATE_SERVICE),
        getConfig(CONFIG_KEY.AI_TRANSLATE_SERVICE),
        getConfig(CONFIG_KEY.VIDEO_SUBTITLE_TRANSLATE_SERVICE),
        loadPopupPrefs(),
      ]);
      tabId = id
      let { activeService, enabledTranslateServices, enabledAiProviders, aiUsedForTranslatePage } = await getTranslateService(ts);
      // Same translators, but every enabled AI provider — the three "other"
      // surfaces are not gated on AI_USE_FOR_TRANSLATE_PAGE.
      const aiCtx = await getAiTranslateService(aiSvc);

      if (cancelled) return;

      // Before `ready`: the layout has to be final on the first painted frame.
      uiResolvedRef.current = true;
      setResolvedUi(popupPrefs);

      setOtherAiProviders(aiCtx.enabledAiProviders);
      // Selection keeps "" (follow the page); the other two are resolved so a
      // deleted provider / disabled translator falls back instead of showing
      // an empty picker.
      setSelectionService(
        selSvc ? resolveActiveService(selSvc, aiCtx.enabledTranslateServices, aiCtx.enabledAiProviders) : '',
      );
      setAiWritingService(aiCtx.activeService);
      setVideoService(resolveActiveService(vidSvc, aiCtx.enabledTranslateServices, aiCtx.enabledAiProviders));

      console.debug("domain: ", d)

      // Surface AI providers in the service dropdown only when:
      //  (a) the global "Also used for translating pages" toggle is on (default true)
      //  (b) the provider itself is enabled (legacy records without `enabled`
      //      are treated as enabled).
      if (aiUsedForTranslatePage) {
        setAiProviders(enabledAiProviders);
      }
      setTranslateServices(enabledTranslateServices);

      setGlobalOn(gs);
      setMode(vs);
      setTargetLanguage(tl || browserTargetLanguage());

      setService(activeService)
      console.debug("service: ", service)
      setDefaultStrategy(ds);
      setHighlight(bh);
      if (typeof d === 'string') setDomain(d);

      if (typeof d === 'string' && d.length > 0) {
        const dom = await sendMessageToBackground({
          action: DB_ACTION.DOMAIN_GET,
          data: { domain: d },
        });
        if (
          !cancelled &&
          (dom?.strategy === DOMAIN_STRATEGY.NEVER || dom?.strategy === DOMAIN_STRATEGY.ALWAYS)
        ) {
          setSiteRule(dom.strategy);
        }
        if (!cancelled) setTranslateAllElements(!!dom?.translateAllElements);
      }

      if (typeof id === 'number') {
        const status = await sendMessageToBackground({
          action: STORAGE_ACTION.SESSION_GET,
          data: { key: TRANSLATE_STATUS_KEY + id },
        });
        if (!cancelled && typeof status === 'boolean') setTranslateActive(status);
      }

      if (!cancelled) setReady(true);
    })();
    return () => {
      browser.runtime.onMessage.removeListener(listener);
      cancelled = true;
    };
  }, []);

  const openHelpPage = () => {
    browser.tabs.create({ url: `${import.meta.env.VITE_WEBSITE}/docs` });
  };

  const aiWritingClick = () => {
    openAiWorkbench()
  }

  const onGlobalSwitchToggle = (v: boolean) => {
    setGlobalOn(v);
    void setConfig(CONFIG_KEY.GLOBAL_SWITCH, v);
    let message = { action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.GLOBAL_SWITCH]: v } };
    void sendMessageToAllTabs(message, false)
    void sendMessageToBackground(message);
  };

  const onViewStrategyChange = (v: VIEW_STRATEGY) => {
    setMode(v);
    void setConfig(CONFIG_KEY.VIEW_STRATEGY, v);
    void sendMessageToAllTabs({ action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.VIEW_STRATEGY]: v } });
  };

  const onTargetLanguageChange = (v: string) => {
    setTargetLanguage(v);
    void setConfig(CONFIG_KEY.TARGET_LANGUAGE, v);
    void sendMessageToAllTabs({ action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.TARGET_LANGUAGE]: v } });
  };

  const onServiceChange = (v: string) => {
    setService(v);
    void setConfig(CONFIG_KEY.TRANSLATE_SERVICE, v);
    void sendMessageToAllTabs({ action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.TRANSLATE_SERVICE]: v } });
  };

  // The three "other" services. They are plain config writes: every consumer
  // reads them reactively (useConfig / storage.watch), so no tab broadcast.
  const onSelectionServiceChange = (v: string) => {
    const value = v === FOLLOW_PAGE ? '' : v;
    setSelectionService(value);
    void setConfig(CONFIG_KEY.SELECTION_TRANSLATE_SERVICE, value);
  };

  const onAiWritingServiceChange = (v: string) => {
    setAiWritingService(v);
    void setConfig(CONFIG_KEY.AI_TRANSLATE_SERVICE, v);
  };

  const onVideoServiceChange = (v: string) => {
    setVideoService(v);
    void setConfig(CONFIG_KEY.VIDEO_SUBTITLE_TRANSLATE_SERVICE, v);
  };

  const onTranslateToggle = (active: boolean) => {
    setTranslateActive(active);
    void sendMessageToTab({ action: active ? TRANSLATE_ACTION.TRANSLATE : TRANSLATE_ACTION.SHOW_ORIGINAL }).then(() => {
      window.close()
    });
  };

  const onDefaultStrategyChange = (v: DEFAULT_STRATEGY) => {
    setDefaultStrategy(v);
    void setConfig(CONFIG_KEY.DEFAULT_STRATEGY, v);
    void sendMessageToAllTabs({ action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.DEFAULT_STRATEGY]: v } });
  };

  const onDomainStrategyChange = (v: DOMAIN_STRATEGY) => {
    setSiteRule(v);
    if (!domain) return;
    void sendMessageToBackground({
      action: DB_ACTION.DOMAIN_UPSERT,
      data: { domain, strategy: v },
    });
    void sendMessageToTab({ action: ACTION.DOMAIN_STRATEGY_CHANGED, data: v });
  };

  const onHighlightToggle = (v: boolean) => {
    setHighlight(v);
    void setConfig(CONFIG_KEY.BILINGUAL_HIGHLIGHTING_SWITCH, v);
    void sendMessageToAllTabs({ action: ACTION.CONFIG_CHANGED, data: { [CONFIG_KEY.BILINGUAL_HIGHLIGHTING_SWITCH]: v } }, true);
    void sendMessageToTab({ action: ACTION.STYLE_CHANGED });
  };

  const openOptions = () => {
    browser.tabs.create({ url: "options.html" });
  };

  const openAiWorkbench = async () => {
    await sendMessageToTab({ action: ACTION.AI_OPEN_WORKBENCH });
    window.close();
  };

  const onTranslateAllElementsToggle = () => {
    const next = !translateAllElements;
    setTranslateAllElements(next);
    // The menu stays open on purpose: this item is a checkbox, and the check
    // mark appearing is the only feedback the action gives.
    if (!domain) return;
    // Field-aware write: turning it off clears only this field, so the site's
    // Always/Never strategy (and every other per-domain flag) survives.
    void sendMessageToBackground(
      next
        ? { action: DB_ACTION.DOMAIN_UPSERT, data: { domain, translateAllElements: true } }
        : { action: DB_ACTION.DOMAIN_DELETE, data: { domain, field: 'translateAllElements' } },
    ).then(() => {
      // After the write, so a frame that re-reads the doc cannot race it.
      void sendMessageToTab({ action: ACTION.TRANSLATE_ALL_ELEMENTS_CHANGED, data: next });
    });
  };

  const enterSelectionMode = () => {
    setMoreOpen(false);
    // Fire-and-forget: the content handler now awaits a confirmation dialog, so
    // awaiting here would keep the popup open until the user confirms. Close it
    // immediately so the dialog shows on the (unobstructed) page.
    void sendMessageToTab({ action: ACTION.ENTER_SELECTION_MODE });
    window.close();
  };

  const openShortcutsPage = () => {
    browser.tabs.create({ url: "options.html#shortcuts" });
  }

  const openFeedbackPage = () => {
    browser.tabs.create({ url: `${import.meta.env.VITE_GITHUB_URL}/issues` });
  }

  // Flat (ungrouped) list of translators + AI providers — shared shape used by
  // every service picker (popup / options / AI writing). AI provider entries
  // use the `ai:<id>` value scheme AiTranslateService resolves.
  const serviceList = buildServiceOptions(translateServices, aiProviders);

  // Picker list for the three "other" surfaces — same translators, but AI
  // providers regardless of the page-translate toggle.
  const otherServiceList = buildServiceOptions(translateServices, otherAiProviders);
  const optionOf = (value: string) => otherServiceList.find((o) => o.value === value);
  const labelOf = (opt: ServiceOption | undefined, fallback: string) =>
    opt ? (opt.i18nKey ? t(opt.i18nKey, opt.label) : opt.label) : fallback;

  /**
   * One service row (icon + name) for both the dropdown items and — via
   * SelectValue, which re-renders the selected item's children — the trigger.
   *
   * `min-w-0` on the flex box and `truncate` on the text are what make a name
   * too long for its trigger end in an ellipsis instead of being cut mid-glyph:
   * the ellipsis is drawn by the element that actually holds the text, and the
   * `truncate` SelectTrigger/SelectItem put on their outer span cannot reach
   * into this nested flex.
   */
  const serviceLabel = (opt: ServiceOption, size: number, gap: string) => (
    <span className={cn('flex min-w-0 items-center', gap)}>
      <ServiceMark id={opt.iconId} size={size} />
      <span className="truncate">{opt.i18nKey ? t(opt.i18nKey, opt.label) : opt.label}</span>
    </span>
  );
  const pageServiceLabel = labelOf(serviceList.find((o) => o.value === service), service ?? '');

  const selectionExtraOption =
    selectionService && !serviceList.some((o) => o.value === selectionService)
      ? optionOf(selectionService)
      : undefined;

  const otherServiceRows: {
    key: string;
    label: string;
    value: string;
    options: ServiceOption[];
    onChange: (v: string) => void;
    follow?: boolean;
  }[] = [
      {
        key: 'selection',
        label: t('selectionTranslate', 'Selection translation'),
        value: selectionService || FOLLOW_PAGE,
        // The selection popup's own picker is the page-translation list, so
        // this one must be too — offering an AI provider it cannot show would
        // leave the two pickers disagreeing about the same setting. A value
        // already stored but missing from that list (its provider is gated out
        // of page translation) is still listed, so the picker shows the real
        // state and the user can move off it.
        options: selectionExtraOption ? [selectionExtraOption, ...serviceList] : serviceList,
        onChange: onSelectionServiceChange,
        follow: true,
      },
      {
        key: 'aiWriting',
        label: t('aiWritingInputTranslate', 'Translate input box (AI Writing)'),
        value: aiWritingService,
        options: otherServiceList,
        onChange: onAiWritingServiceChange,
      },
      {
        key: 'videoSubtitle',
        label: t('videoSubtitle', 'Video subtitles'),
        value: videoService,
        options: otherServiceList,
        onChange: onVideoServiceChange,
      },
    ];

  const version =
    browser.runtime?.getManifest?.()?.version || '';

  // `ui` is part of the same gate as `ready`, not an extra one: both are set by
  // the single hydration below, and the placeholder holds the window steady
  // until the real layout — the whole real layout — can be drawn at once.
  if (!ready || !ui) {
    return <div className="w-[400px] bg-bg" style={{ minHeight: placeholderHeight }} />;
  }

  return (
    <div ref={rootRef} className="popup-shell relative flex h-[600px] max-h-[600px] w-[400px] flex-col overflow-hidden text-ink">
      {/* Header */}
      {/* Keep the theme menu above the scrolling body. */}
      <div className="popup-header relative z-20 flex h-11 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2 text-left">
          <img className="h-5 w-5" src={`${APP_NAME_PASCAL_CASE || 'DuoTranslator'}.svg`} alt="" />
          <span className="text-[13px] font-semibold">{APP_NAME || 'Duo Translator'}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Theme switcher — sun/moon reflects the resolved theme; the menu
              picks the setting (System / Light / Dark). */}
          {ui.theme && (
            <div ref={themeMenuRef} className="relative">
              <button
                type="button"
                className={iconBtnCls}
                onClick={() => setThemeMenuOpen((v) => !v)}
                title={t('theme', 'Theme')}
              >
                {resolvedTheme === 'light' ? (
                  <Sun className="h-4 w-4" strokeWidth={1.6} />
                ) : (
                  <Moon className="h-4 w-4" strokeWidth={1.6} />
                )}
              </button>
              {themeMenuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1.5 min-w-[150px] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
                  {THEME_OPTIONS.map((opt) => {
                    const Icon = opt.value === 'system' ? Monitor : opt.value === 'light' ? Sun : Moon;
                    const active = themeSetting === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-hover',
                          active ? 'text-accent' : 'text-ink-soft hover:text-ink',
                        )}
                        onClick={() => onThemeChange(opt.value)}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                        <span className="flex-1">{t(opt.i18nKey, opt.fallback)}</span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {ui.help && (
            <button type="button" className={iconBtnCls} onClick={openHelpPage} title={t('helpDocument', 'Help')}>
              <HelpCircle className="h-4 w-4" strokeWidth={1.6} />
            </button>
          )}
          <button
            type="button"
            className={iconBtnCls}
            title={t('settings', 'settings')}
            onClick={openOptions}
          >
            <SettingsIcon className="h-4 w-4" strokeWidth={1.6} />
          </button>
          {/* The rule exists to separate the icon buttons from the switch, so
              it goes with it — on its own it would be a line ending nothing. */}
          {ui.globalSwitch && (
            <>
              <span className="mx-0.5 h-4 w-px bg-line-strong" />
              <Switch title={t('globalSwitch', 'global switch')} checked={globalOn} onCheckedChange={onGlobalSwitchToggle} size="sm" />
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div
        className={cn(
          'popup-body relative z-10 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3 transition-opacity duration-200',
          !globalOn && 'pointer-events-none opacity-40',
        )}
      >
        <ManualTranslator
          services={otherServiceList}
          defaultService={service ?? aiWritingService}
          pageTargetLanguage={targetLanguage}
          pageService={service}
          embedded={embedded}
          onSuccess={collapsePageSettings}
        />

        <section className="popup-surface flex flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2.5" aria-label={t('popupPageSettings', 'Webpage translation')}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex shrink-0 items-center gap-2 text-[14px] font-semibold"><Globe className="h-[18px] w-[18px] text-accent" strokeWidth={1.8} />{t('popupPageSettings', 'Webpage translation')}</h2>
            <span className="text-right text-[10px] text-ink-mute">{t('popupWebScope', 'Page content · global rules')}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] text-ink-mute">{t('pageTranslationService', 'Webpage translation service')}</span>
              <Select value={service} onValueChange={onServiceChange}>
                <SelectTrigger className="popup-field" aria-label={t('pageTranslationService', 'Webpage translation service')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {serviceList.map((option) => <SelectItem key={option.value} value={option.value}>{serviceLabel(option, 15, 'gap-1.5')}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] text-ink-mute">{t('targetLanguage', 'Target language')}</span>
              <Select value={targetLanguage} onValueChange={onTargetLanguageChange}>
                <SelectTrigger className="popup-field" aria-label={t('popupWebTarget', 'Webpage target language')}><SelectValue /></SelectTrigger>
                <SelectContent align="end">
                  {LANGUAGES.map((language) => <SelectItem key={language.value} value={language.value}>{t(language.title, language.name)}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="flex items-end gap-3">
            <button type="button" disabled={!domain} aria-pressed={translateActive} onClick={() => onTranslateToggle(!translateActive)}
              className="popup-primary flex h-11 w-[138px] shrink-0 items-center justify-center gap-2 rounded-lg text-[13px] font-semibold text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50">
              <Globe className="h-4 w-4" strokeWidth={1.8} />
              {translateActive ? t('popupRestoreWebpage', 'Restore original') : t('popupTranslateWebpage', 'Translate this page')}
            </button>
            <fieldset className="min-w-0 flex-1 border-l border-line pl-3">
              <legend className="sr-only">{t('displayMode', 'Display mode')}</legend>
              <div className="mb-1 text-[10px] text-ink-mute">{t('displayMode', 'Display mode')}</div>
              <div className="flex gap-1.5">
                {[VIEW_STRATEGY.DOUBLE, VIEW_STRATEGY.SINGLE].map((value) => (
                  <label key={value} className={cn('flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-[10px] leading-4', mode === value ? 'border-accent/50 bg-accent/5' : 'border-line')}>
                    <input type="radio" className="h-3 w-3 shrink-0 accent-accent" name="popup-page-mode" value={value} checked={mode === value} onChange={() => onViewStrategyChange(value)} />
                    <span>{value === VIEW_STRATEGY.DOUBLE ? t('popupModeBilingual', 'Bilingual') : t('translationOnly', 'Translation only')}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="border-t border-line pt-2.5">
            <button type="button" aria-expanded={pageSettingsOpen} aria-controls="popup-page-settings" onClick={() => setPageSettingsOpen((value) => !value)}
              className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <SlidersHorizontal className="h-[18px] w-[18px] shrink-0 self-start text-ink-soft" strokeWidth={1.8} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium leading-4">{t('popupAdvancedSettings', 'Advanced settings')}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-ink-mute">{t('popupAdvancedHint', 'Default policy, site rules, bilingual highlighting')}</span>
              </span>
              <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-ink-soft transition-transform', pageSettingsOpen && 'rotate-180')} />
            </button>
            <div id="popup-page-settings" hidden={!pageSettingsOpen}>
              <section className="mt-2 border-t border-line px-3 py-2" aria-label={t('otherTranslationServices', 'Other translation services')}>
                <h3 className="mb-2 flex items-center gap-2 text-[12px] font-medium">
                  <Languages className="h-4 w-4 shrink-0 text-ink-soft" strokeWidth={1.7} aria-hidden="true" />
                  {t('otherTranslationServices', 'Other translation services')}
                </h3>
                <div className="flex flex-col gap-2">
                  {otherServiceRows.map((row) => (
                    <label key={row.key} className="grid grid-cols-[minmax(0,1fr)_170px] items-center gap-2">
                      <span className="min-w-0 text-[12px] leading-4 text-ink">{row.label}</span>
                      <Select value={row.value} onValueChange={row.onChange}>
                        <SelectTrigger className="popup-field" aria-label={row.label}>
                          <SelectValue />
                        </SelectTrigger>
                        {/* End-align long provider names within the popup viewport. */}
                        <SelectContent align="end">
                          {row.follow && (
                            <SelectItem value={FOLLOW_PAGE}>
                              {t('selectionFollowWeb', 'Follow page ({{name}})').replace('{{name}}', pageServiceLabel)}
                            </SelectItem>
                          )}
                          {row.options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {serviceLabel(option, 16, 'gap-2')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  ))}
                </div>
              </section>
            <div>
              <div className="overflow-hidden">
                {ui.defaultStrategy && (
                  <fieldset className="px-3 py-3">
                    <legend className="sr-only">{t('defaultTranslateStrategy', 'Default translate strategy')}</legend>
                    <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
                      <SlidersHorizontal className="h-4 w-4 text-ink-soft" strokeWidth={1.7} />
                      <span>{t('defaultTranslateStrategy', 'Default translate strategy')}</span>
                    </div>
                    <div className="flex items-start justify-between gap-2 pl-1">
                      {DEFAULT_STRATEGY_OPTIONS.map((option) => (
                        <label key={option.value} className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] leading-4 text-ink">
                          <input type="radio" className="popup-policy-radio h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent" name="popup-default-strategy" value={option.value} checked={defaultStrategy === option.value} onChange={() => onDefaultStrategyChange(option.value)} />
                          <span>{option.value === DEFAULT_STRATEGY.AUTO ? t('popupStrategyAuto', 'Automatic') : t(option.title, option.fallback)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                {(ui.alwaysTranslateSite || ui.neverTranslateSite) && (
                  <div className={cn('grid grid-cols-2 py-3', ui.defaultStrategy && 'border-t border-line')}>
                    {ui.alwaysTranslateSite && (
                      <div className="flex min-w-0 items-center gap-1.5 px-3" title={domain}>
                        <Globe className="h-4 w-4 shrink-0 text-ink-soft" strokeWidth={1.7} />
                        <span className="min-w-0 flex-1 text-[11px] leading-4">{t('alwaysTranslateThisWebsite', 'Always translate this website')}</span>
                        <Switch disabled={!domain} aria-label={t('alwaysTranslateThisWebsite', 'Always translate this website')} checked={siteRule === DOMAIN_STRATEGY.ALWAYS} onCheckedChange={(value) => onDomainStrategyChange(value ? DOMAIN_STRATEGY.ALWAYS : DOMAIN_STRATEGY.AUTO)} size="sm" />
                      </div>
                    )}
                    {ui.neverTranslateSite && (
                      <div className={cn('flex min-w-0 items-center gap-1.5 px-3', ui.alwaysTranslateSite && 'border-l border-line')} title={domain}>
                        <EyeOff className="h-4 w-4 shrink-0 text-ink-soft" strokeWidth={1.7} />
                        <span className="min-w-0 flex-1 text-[11px] leading-4">{t('neverTranslateThisWebsite', 'Never translate this website')}</span>
                        <Switch disabled={!domain} aria-label={t('neverTranslateThisWebsite', 'Never translate this website')} checked={siteRule === DOMAIN_STRATEGY.NEVER} onCheckedChange={(value) => onDomainStrategyChange(value ? DOMAIN_STRATEGY.NEVER : DOMAIN_STRATEGY.AUTO)} size="sm" />
                      </div>
                    )}
                  </div>
                )}

                {ui.bilingualHighlight && (
                  <div className={cn('flex items-center gap-2 px-3 py-3', (ui.defaultStrategy || ui.alwaysTranslateSite || ui.neverTranslateSite) && 'border-t border-line')}>
                    <Sparkles className="h-4 w-4 shrink-0 self-start text-ink-soft" strokeWidth={1.7} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] leading-4">{t('bilingualHighlighting', 'Bilingual sentence-by-sentence highlighting')}</div>
                      <p className="mt-1 text-[11px] leading-4 text-ink-soft">{t('bilingualHighlightingHint', 'Highlight original and translation sentence by sentence')}</p>
                    </div>
                    <Switch aria-label={t('bilingualHighlighting', 'Bilingual sentence-by-sentence highlighting')} checked={highlight} onCheckedChange={onHighlightToggle} size="sm" />
                  </div>
                )}
              </div>
            </div>
            </div>
          </div>
        </section>

        {ui.aiWriting && (
          <button onClick={aiWritingClick} type="button" className="popup-ai-entry flex min-h-[52px] w-full shrink-0 items-center gap-3 rounded-[10px] border border-line-strong px-3 py-2 text-left transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <span className="popup-ai-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-strong text-accent">
              <PenLine className="h-4 w-4" strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1 border-l border-line-strong pl-3">
              <span className="block text-[13px] font-semibold leading-5">{t('aiWriting', 'AI Writing')}</span>
              <span className="block text-[11px] leading-4 text-ink-soft">{t('popupAiWritingHint', 'Rewrite, polish & translate')}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-ink-soft" />
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="popup-footer relative z-10 flex h-9 shrink-0 items-center justify-between border-t border-line px-3.5 text-[10px] text-ink-soft">
        <div className=' flex gap-2'>
          <span className="font-mono tracking-[0.04em]">v{version}</span>
          <span className="opacity-50">·</span>
          <button type="button" className="cursor-pointer text-ink-soft hover:text-accent" onClick={openShortcutsPage}>
            {t('shortcuts', 'Shortcuts')}
          </button>
          <span className="opacity-50">·</span>
          <button type="button" className="cursor-pointer text-ink-soft hover:text-accent" onClick={openFeedbackPage}>
            {t('feedback', 'Feedback')}
          </button>
        </div>
        <div ref={moreRef} className="relative">
          <button type="button" aria-expanded={moreOpen}
            className="flex cursor-pointer items-center gap-1 text-ink-soft hover:text-accent"
            onClick={() => setMoreOpen((v) => !v)}
          >
            {t('more', 'More')}
            <ChevronDown className="h-3 w-3" />
          </button>
          {moreOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-1.5 min-w-[210px] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[12px] tracking-normal transition-colors hover:bg-hover',
                  translateAllElements ? 'text-accent' : 'text-ink-soft hover:text-accent',
                )}
                onClick={onTranslateAllElementsToggle}
                title={t(
                  'translateAllElementsHint',
                  'Ignore the website rules and no-translate areas on this site',
                )}
              >
                <ScanText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                <span className="flex-1">{t('translateAllElements', 'Translate all elements')}</span>
                {translateAllElements && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[12px] tracking-normal text-ink-soft transition-colors hover:bg-hover hover:text-accent"
                onClick={enterSelectionMode}
              >
                <Ban className="h-3.5 w-3.5 shrink-0" strokeWidth={1.6} />
                <span className="flex-1">{t('setNoTranslateArea', 'Set no-translate area')}</span>
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
