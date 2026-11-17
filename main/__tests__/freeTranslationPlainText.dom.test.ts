// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { ACTION, AI_REQUEST_TIMEOUT, TRANSLATE_SERVICE, VIEW_STRATEGY } from '@/main/constants';
import { getTranslateResult, preparePlainTranslationTexts, readPlainTranslationText, restore, translate, translateTexts } from '@/main/translateClient';
import { startTranslate } from '@/main/aiWriting/translateRunner';
import { buildSrt } from '@/main/videoSubtitle/download';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/utils/message', () => ({ sendMessageToBackground: send, sendMessageToBackgroundOrThrow: send }));
vi.mock('@/utils/db', () => ({ getConfig: vi.fn(async () => undefined) }));
vi.mock('@/main/aiClient', () => ({ startAiChatStream: vi.fn() }));
beforeEach(() => { send.mockReset(); document.body.innerHTML = ''; });

it.each(['freeAuto', 'transmart', 'volcengine', 'lara', 'modernMt'])('escapes and decodes %s markup exactly once for input boxes and captions', (service) => {
    const original = 'A & B <script>literal</script> &amp;';
    const escaped = 'A &amp; B &lt;script&gt;literal&lt;/script&gt; &amp;amp;';
    expect(preparePlainTranslationTexts(service, [original])).toEqual([escaped]);
    expect(readPlainTranslationText(service, escaped)).toBe(original);
    expect(buildSrt([{ text: 'original', translated: original, startMs: 0, endMs: 1000 }], 'translation', 'text')).toContain(original);
    expect(document.querySelector('script')).toBeNull();
});
it.each(['freeAuto', 'transmart', 'volcengine', 'lara', 'modernMt'])('supports the %s input translation stream without exposing HTML entities', async (service) => {
    send.mockResolvedValue([{ translatedMappedHtmlText: '甲 &amp; 乙 &lt;tag&gt;', sourceLang: 'en', score: 1 }]);
    const running = startTranslate('A & B <tag>', 'zh-CN', { kind: 'trans', service });
    const chunks = [];
    for await (const text of running.stream) chunks.push(text);
    expect(chunks).toEqual(['甲 & 乙 <tag>']);
    expect(send.mock.calls[0][0].data.texts).toEqual(['A &amp; B &lt;tag&gt;']);
});
it('uses mapped HTML write-back even when the actual selected route is Google', async () => {
    document.body.innerHTML = '<p>Hello <strong>world</strong> &amp; friends</p>';
    const paragraph = document.querySelector('p')!;
    const strong = paragraph.querySelector('strong');
    send.mockResolvedValue([{ translatedMappedHtmlText: '你好 <b0>世界</b0> &amp; 朋友', sourceLang: 'en', score: 1, actualService: 'google' }]);
    const result = await getTranslateResult(TRANSLATE_SERVICE.FREE_AUTO, [paragraph], 'zh-CN', VIEW_STRATEGY.SINGLE);
    expect(send.mock.calls[0][0].data.texts).toEqual(['Hello <b0>world</b0> &amp; friends']);
    expect(result[0].actualService).toBe('google');
    await translate(TRANSLATE_SERVICE.FREE_AUTO, result);
    expect(paragraph.textContent).toBe('你好 世界 & 朋友');
    expect(paragraph.querySelector('strong')).toBe(strong);
    await restore(result);
    expect(paragraph.textContent).toBe('Hello world & friends');
});
it('uses the long pool budget and forwards timeout cancellation to background', async () => {
    send.mockRejectedValueOnce(new Error(`${ACTION.TRANSLATE_TEXTS} request timeout`)).mockResolvedValueOnce(undefined);
    await expect(translateTexts(TRANSLATE_SERVICE.FREE_AUTO, ['hello'], 'zh-CN')).rejects.toThrow('request timeout');
    expect(send.mock.calls[0][1]).toBe(AI_REQUEST_TIMEOUT);
    expect(send.mock.calls[1][0]).toEqual({ action: ACTION.TRANSLATE_TEXTS_ABORT, data: { requestId: send.mock.calls[0][0].data.requestId } });
});
