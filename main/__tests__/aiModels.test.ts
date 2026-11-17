import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '@/main/aiProvider';
import { fetchProviderModels } from '@/main/aiModels';

const fetchMock = vi.fn();
const provider = (type = 'openai', url = 'https://gateway.test/prefix/v1/chat/completions') => ({
    type, url, apiKey: 'test-key', model: '',
} as AiProvider);
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('model discovery', () => {
    it.each(['openai', 'custom', 'deepseek', 'ollama'])('lists %s models without requiring a model first', async (type) => {
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'auto' }, { id: 'auto' }, { id: 'other' }] }));
        expect(await fetchProviderModels(provider(type))).toEqual(['auto', 'other']);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://gateway.test/prefix/v1/models');
        expect(init.headers.Authorization).toBe('Bearer test-key');
    });
    it.each([
        ['https://gateway.test', 'https://gateway.test/v1/models'],
        ['https://gateway.test/v1/', 'https://gateway.test/v1/models'],
        ['https://gateway.test/api/v4/chat/completions?tenant=abc', 'https://gateway.test/api/v4/models?tenant=abc'],
    ])('derives the list route from %s', async (input, output) => {
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'auto' }] }));
        await fetchProviderModels(provider('openai', input));
        expect(fetchMock.mock.calls[0][0]).toBe(output);
    });
    it('supports keyless local OpenAI-compatible services', async () => {
        fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'local' }] }));
        await fetchProviderModels({ ...provider('custom'), apiKey: '' });
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
    it('uses Anthropic authentication and follows cursor pagination', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-b' }], has_more: false }));
        expect(await fetchProviderModels(provider('claude', 'https://proxy.test/anthropic/v1/messages'))).toEqual(['claude-a', 'claude-b']);
        expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/anthropic/v1/models');
        expect(fetchMock.mock.calls[1][0]).toContain('after_id=claude-a');
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
    it('lists Gemini generation models, strips the resource prefix and follows pages', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ models: [
            { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
        ], nextPageToken: 'next' }))
            .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-b' }] }));
        const draft = provider('gemini', 'https://proxy.test/google/v1beta/models/{model}:streamGenerateContent?key={key}&alt=sse&tenant=abc');
        expect(await fetchProviderModels(draft)).toEqual(['gemini-a', 'gemini-b']);
        const first = new URL(fetchMock.mock.calls[0][0]);
        expect(first.pathname).toBe('/google/v1beta/models');
        expect(first.searchParams.get('key')).toBe('test-key');
        expect(first.searchParams.get('tenant')).toBe('abc');
        expect(first.searchParams.has('alt')).toBe(false);
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('pageToken')).toBe('next');
    });
    it.each([401, 404, 500])('reports HTTP %s without exposing the URL key or response body', async (status) => {
        fetchMock.mockResolvedValue(new Response('secret upstream content', { status }));
        await expect(fetchProviderModels(provider())).rejects.toThrow(`Models API returned HTTP ${status}`);
    });
    it.each([
        ['HTML', () => new Response('<!doctype html>'), 'valid JSON'],
        ['invalid shape', () => Response.json({ message: 'oops' }), 'Invalid models'],
        ['empty list', () => Response.json({ data: [] }), 'No available models'],
    ])('reports %s as a failure', async (_name, response, expected) => {
        fetchMock.mockResolvedValue(response());
        await expect(fetchProviderModels(provider())).rejects.toThrow(expected);
    });
    it('rejects repeated pagination cursors instead of looping', async () => {
        fetchMock.mockImplementation(async () => Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }));
        await expect(fetchProviderModels(provider('claude'))).rejects.toThrow('pagination');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('bounds a stalled request', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const result = expect(fetchProviderModels(provider())).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(20_000);
        await result;
    });
    it('rejects invalid URLs without echoing credentials', async () => {
        await expect(fetchProviderModels(provider('openai', 'not-a-url?key=secret'))).rejects.toThrow('Invalid models API URL');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
