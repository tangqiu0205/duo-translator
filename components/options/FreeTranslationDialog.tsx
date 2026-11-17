import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CONFIG_KEY, TRANSLATE_SERVICES } from '@/main/constants';
import { FREE_TRANSLATION_PROVIDERS, defaultFreeTranslationSettings, readFreeTranslationSettings, type FreeTranslationSettings } from '@/main/freeTranslationConfig';
import { getConfig, setConfigOrThrow } from '@/utils/db';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { ServiceMark } from '@/components/ui/service-mark';

export function FreeTranslationDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
    const { t } = useTranslation();
    const [config, setConfig] = useState<FreeTranslationSettings>(defaultFreeTranslationSettings);
    const [disabled, setDisabled] = useState<string[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoaded(false);
        setError('');
        void (async () => {
            try {
                const [value, unavailable] = await Promise.all([getConfig(CONFIG_KEY.FREE_TRANSLATION), getConfig(CONFIG_KEY.DISABLED_TRANSLATE_SERVICES)]);
                if (cancelled) return;
                setDisabled(Array.isArray(unavailable) ? unavailable : []);
                setConfig(readFreeTranslationSettings(value));
                setLoaded(true);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => { cancelled = true; };
    }, [open]);
    const eligible = config.services.some((id) => !disabled.includes(id));
    const save = async () => {
        if (!loaded || saving || !eligible) return;
        setSaving(true);
        setError('');
        try {
            await setConfigOrThrow(CONFIG_KEY.FREE_TRANSLATION, config);
            onSaved();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally { setSaving(false); }
    };
    const ordered = [...config.services, ...FREE_TRANSLATION_PROVIDERS.filter((id) => !config.services.includes(id))];
    const move = (index: number, delta: number) => setConfig((current) => {
        const services = [...current.services];
        [services[index], services[index + delta]] = [services[index + delta], services[index]];
        return { ...current, services };
    });
    return (
        <Dialog open={open} onClose={() => { if (!saving) onClose(); }} title={t('freeTranslationTitle', 'Free translation · Auto')} widthClass="w-[560px]" dismissOnBackdrop={false} error={error} footer={
            <Button onClick={() => void save()} disabled={!loaded || saving || !eligible}>{saving && <Loader2 className="h-3 w-3 animate-spin" />}{t('aiSave', 'Save')}</Button>
        }>
            {!loaded ? <Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading', 'Loading')} /> : <div className="flex flex-col gap-4">
                <div className="flex gap-2" role="group" aria-label={t('freeTranslationMode', 'Routing mode')}>
                    <Button variant={config.mode === 'balanced' ? 'default' : 'outline'} aria-pressed={config.mode === 'balanced'} disabled={saving} onClick={() => setConfig((current) => ({ ...current, mode: 'balanced' }))}>{t('freeTranslationBalanced', 'Automatic routing')}</Button>
                    <Button variant={config.mode === 'ordered' ? 'default' : 'outline'} aria-pressed={config.mode === 'ordered'} disabled={saving} onClick={() => setConfig((current) => ({ ...current, mode: 'ordered' }))}>{t('freeTranslationOrdered', 'Priority order')}</Button>
                </div>
                <p className="text-[12px] leading-5 text-ink-soft">{t('freeTranslationRoutingHint', 'Automatic routing favors responsive, available services. Priority order tries services from top to bottom. Each batch uses one service, switching only on failure; rate-limited services cool down temporarily.')}</p>
                <div className="flex flex-col gap-2" aria-label={t('freeTranslationParticipants', 'Participating services')}>
                    {ordered.map((id) => {
                        const meta = TRANSLATE_SERVICES.get(id)!;
                        const selected = config.services.includes(id);
                        const index = config.services.indexOf(id);
                        const unavailable = disabled.includes(id);
                        const name = t(meta.title, meta.name);
                        return <div key={id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                            <ServiceMark id={meta.icon} size={20} />
                            <span className="flex-1 text-[12px]">{name}{unavailable && <span className="ml-2 text-ink-mute">{t('freeTranslationGloballyDisabled', 'Disabled in service settings')}</span>}</span>
                            {config.mode === 'ordered' && selected && <>
                                <Button variant="ghost" size="sm" aria-label={`${t('freeTranslationMoveUp', 'Move up')}: ${name}`} disabled={saving || index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-3 w-3" /></Button>
                                <Button variant="ghost" size="sm" aria-label={`${t('freeTranslationMoveDown', 'Move down')}: ${name}`} disabled={saving || index === config.services.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-3 w-3" /></Button>
                            </>}
                            <Switch aria-label={name} checked={selected} disabled={saving || unavailable && !selected} onCheckedChange={(checked) => setConfig((current) => ({ ...current, services: checked ? [...current.services, id] : current.services.filter((value) => value !== id) }))} size="sm" />
                        </div>;
                    })}
                </div>
                {!eligible && <p role="alert" className="text-[12px] text-red-600">{t('freeTranslationEmpty', 'Select at least one enabled service.')}</p>}
                <p className="text-[12px] leading-5 text-ink-soft">{t('freeTranslationPrivacy', 'Text may be sent to any participating service, including a fallback. Doubao routes use your browser login and are opt-in. Local AI and services requiring API keys never participate. Connection tests send real sample text.')}</p>
            </div>}
        </Dialog>
    );
}
