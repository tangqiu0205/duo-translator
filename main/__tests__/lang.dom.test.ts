// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ local: vi.fn(), visible: vi.fn(), network: vi.fn() }));
vi.mock('@/main/localLanguageDetection', () => ({ detectLocalTextLanguage: mocks.local }));
vi.mock('@/utils/arrays', () => ({ shuffle: (items: unknown[]) => items }));
vi.mock('@/main/dom/visibility', () => ({ isVisibleForDetect: mocks.visible }));
vi.mock('@/utils/message', () => ({ sendMessageToBackgroundOrThrow: mocks.network, sendMessageToBackground: mocks.network }));
import { getElementTextContent, detectLanguage } from '@/main/lang';

function para(text: string): HTMLElement { const p = document.createElement('p'); p.textContent = text; return p; }
beforeEach(() => {
    vi.clearAllMocks(); mocks.local.mockReset().mockResolvedValue('und');
    mocks.visible.mockImplementation(() => true); document.body.innerHTML = '';
});

describe('page-language source extraction', () => {
    it('preserves spaces between inline words and skips script/style text', () => {
        document.body.innerHTML = '<p>Hello <b>world</b> again<script>hidden()</script><style>body{}</style></p>';
        expect(getElementTextContent(document.body.firstElementChild! as HTMLElement)).toBe('Hello world again');
    });
    it('trims the outer whitespace without inventing spacing between adjacent inline characters', () => {
        document.body.innerHTML = '<p>  <b>网</b><i>页</i>  </p>';
        expect(getElementTextContent(document.body.firstElementChild! as HTMLElement)).toBe('网页');
    });
});

describe('local-only page detection', () => {
    it('does not invoke detection for an empty page', async () => {
        expect(await detectLanguage([])).toBe('und'); expect(mocks.local).not.toHaveBeenCalled();
    });
    it('uses the shared local result and never asks a translation provider', async () => {
        mocks.local.mockResolvedValue('en');
        expect(await detectLanguage([para('English source paragraph')])).toBe('en');
        expect(mocks.local).toHaveBeenCalledWith('English source paragraph', undefined);
        expect(mocks.network).not.toHaveBeenCalled();
    });
    it('preserves paragraph boundaries for mixed-language detection instead of a majority vote', async () => {
        expect(await detectLanguage([para('English paragraph'), para('Texte français')])).toBe('und');
        expect(mocks.local).toHaveBeenCalledWith('English paragraph\nTexte français', undefined);
        expect(mocks.network).not.toHaveBeenCalled();
    });
    it('does not send uncertain short text to Microsoft or another provider', async () => {
        expect(await detectLanguage([para('bonjour')])).toBe('und');
        expect(mocks.network).not.toHaveBeenCalled();
    });
    it('uses visible text instead of hidden long-form content', async () => {
        const hidden = para('hidden '.repeat(1000));
        mocks.visible.mockImplementation(element => element !== hidden);
        await detectLanguage([hidden, para('visible source')]);
        expect(mocks.local).toHaveBeenCalledWith('visible source', undefined);
    });
    it('uses hidden text only if the visible sample is empty and complete', async () => {
        mocks.visible.mockReturnValue(false); mocks.local.mockResolvedValue('en');
        expect(await detectLanguage([para('hidden source')])).toBe('en');
        expect(mocks.local).toHaveBeenCalledWith('hidden source', undefined);
    });
    it('does not classify an entire page by a truncated hidden prefix', async () => {
        mocks.visible.mockReturnValue(false); mocks.local.mockResolvedValue('en');
        expect(await detectLanguage([para('a'.repeat(10_000))])).toBe('und');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('keeps oversized multibyte pages unknown rather than guessing from a prefix', async () => {
        expect(await detectLanguage([para('😀'.repeat(2000))])).toBe('und');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('does not continue an aborted page decision', async () => {
        const controller = new AbortController(); controller.abort();
        expect(await detectLanguage([para('source')], controller.signal)).toBe('und');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('forwards cancellation and returns unknown rather than enabling a stale decision', async () => {
        const controller = new AbortController();
        mocks.local.mockImplementation(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); });
        expect(await detectLanguage([para('source')], controller.signal)).toBe('und');
    });
});
