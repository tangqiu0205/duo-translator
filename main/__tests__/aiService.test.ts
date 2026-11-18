import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configGet } = vi.hoisted(() => ({ configGet: vi.fn() }));
vi.mock("@/main/storage/configStore", () => ({ configRepo: { get: configGet } }));
import { AiProvider, normalizeProvider } from "@/main/aiProvider";
import { ACTION, AI_TASK, CONFIG_KEY, STATUS_FAIL, STATUS_SUCCESS } from "@/main/constants";
import { AI_MAX_INPUT_CHARS, OPENCODE_SESSION_HEADER, aiMessageHandlers, aiPageTranslate, aiPageTranslateWithProvider, buildPrompt, chatCompleteNonStream, chatStream } from "@/main/aiService";

const provider = new AiProvider("mt", "bailian", "Alibaba Cloud Model Studio", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "test-key", "qwen-mt-plus");
const fetchMock = vi.fn();
const options = { task: AI_TASK.TRANSLATE, targetLang: "zh-CN" };
const messages = buildPrompt({ task: AI_TASK.TRANSLATE, payload: { text: "Hello", targetLang: "zh-CN" } });
const completeResponse = (text: string) => Response.json({ choices: [{ message: { content: text } }] });

function streamResponse(chunks: string[]) {
    return new Response(chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n");
}

async function collect(stream: AsyncGenerator<string, void, void>) {
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
}

async function runAiAction(action: ACTION, data: unknown) {
    return new Promise<any>(resolve => aiMessageHandlers[action]({ data }, resolve));
}

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    configGet.mockImplementation(async (key) => key === CONFIG_KEY.AI_PROVIDERS ? [provider] : provider.id);
});
afterEach(() => vi.unstubAllGlobals());

describe("Qwen-MT compatibility", () => {
    it.each([
        { type: "custom", model: "qwen-mt-plus" },
        { type: "bailian", model: "qwen-plus" },
    ])("keeps the general protocol for $type / $model", async (overrides) => {
        const other = normalizeProvider({ ...provider, ...overrides });
        fetchMock.mockResolvedValueOnce(completeResponse("你好"));
        expect(await chatCompleteNonStream(other, messages, options)).toBe("你好");
        fetchMock.mockResolvedValueOnce(streamResponse(["你", "你好"]));
        expect(await collect(chatStream(other, messages, options))).toEqual(["你", "你好"]);
        for (const [, init] of fetchMock.mock.calls) {
            const body = JSON.parse(init.body);
            expect(body.messages).toEqual(messages);
            expect(body.translation_options).toBeUndefined();
        }
    });

    it.each([["zh-CN", "Chinese"], ["zh-TW", "Traditional Chinese"], ["ja", "Japanese"]])("sends only source text and the target language for %s", async (targetLang, target) => {
        fetchMock.mockResolvedValue(completeResponse("译文"));
        const signal = new AbortController().signal;
        expect(await chatCompleteNonStream(provider, messages, { ...options, targetLang, signal })).toBe("译文");
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(provider.url);
        expect(init.headers.Authorization).toBe("Bearer test-key");
        expect(init.signal).toBe(signal);
        expect(JSON.parse(init.body)).toEqual({
            model: "qwen-mt-plus", stream: false,
            messages: [{ role: "user", content: "Hello" }],
            translation_options: { source_lang: "auto", target_lang: target },
        });
        expect(messages[0].role).toBe("system");
    });

    it.each([
        ["qwen-mt-plus", ["你", "你好", "你好", "你好！"]],
        ["qwen-mt-turbo", ["你", "你好", "你好", "你好！"]],
        ["qwen-mt-flash", ["你", "好", "！"]],
        ["qwen-mt-lite", ["你", "好", "！"]],
    ] as const)("normalizes %s streaming output", async (model, chunks) => {
        fetchMock.mockResolvedValue(streamResponse([...chunks]));
        expect(await collect(chatStream(normalizeProvider({ ...provider, model }), messages, options))).toEqual(["你", "好", "！"]);
    });

    it("rejects writing tasks before sending a request", async () => {
        await expect(chatCompleteNonStream(provider, messages, { task: AI_TASK.POLISH })).rejects.toThrow("only supports translation");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("tests provider connectivity with a valid translation request", async () => {
        fetchMock.mockResolvedValue(completeResponse("你好"));
        expect(await runAiAction(ACTION.AI_PROVIDER_TEST, provider)).toEqual({
            status: STATUS_SUCCESS, data: { reply: "你好" },
        });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
            stream: false,
            messages: [{ role: "user", content: "Hello" }],
            translation_options: { source_lang: "auto", target_lang: "Chinese" },
        });
    });

    it("preserves upstream errors", async () => {
        fetchMock.mockResolvedValue(new Response("Invalid API key", { status: 401 }));
        await expect(chatCompleteNonStream(provider, messages, options)).rejects.toThrow("HTTP 401");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("merges Qwen-MT paragraphs without treating literal separators as boundaries", async () => {
        fetchMock.mockResolvedValue(completeResponse("你好<sep\\/>世界<sep/>再见"));
        expect(await aiPageTranslate("mt", ["Hello<sep/>world", "Goodbye"], "zh-CN")).toEqual(["你好<sep/>世界", "再见"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
            messages: [{ role: "user", content: "Hello<sep\\/>world<sep/>Goodbye" }],
            translation_options: { target_lang: "Chinese" },
        });
    });

    it.each(["合并后的译文", "一<sep/>二<sep/>三"])("rejects Qwen-MT boundary mismatches: %s", async (output) => {
        fetchMock.mockResolvedValue(completeResponse(output));
        await expect(aiPageTranslate("mt", ["Hello", "Goodbye"], "zh-CN")).rejects.toThrow("mismatched translation batch");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("preserves empty Qwen-MT paragraph positions", async () => {
        fetchMock.mockResolvedValue(completeResponse("<sep/>你好<sep/><sep/>再见<sep/>"));
        expect(await aiPageTranslate("mt", ["", "Hello", "  ", "Goodbye", ""], "zh-CN")).toEqual(["", "你好", "  ", "再见", ""]);
    });

    it("does not send blank Qwen-MT batches", async () => {
        expect(await aiPageTranslate("mt", ["", "  "], "zh-CN")).toEqual(["", "  "]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("splits Qwen-MT batches at the existing budget", async () => {
        const texts = Array.from({ length: 6 }, (_, index) => String(index).padEnd(100, "x"));
        fetchMock.mockImplementation(async (_url, init) => completeResponse(JSON.parse(init.body).messages[0].content));
        expect(await aiPageTranslate("mt", texts, "zh-CN")).toEqual(texts);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps general model paragraph batching", async () => {
        configGet.mockResolvedValue([{ ...provider, model: "qwen-plus" }]);
        fetchMock.mockResolvedValue(completeResponse("你好<sep/>再见"));
        expect(await aiPageTranslate("mt", ["Hello", "Goodbye"], "zh-CN")).toEqual(["你好", "再见"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.messages[0].role).toBe("system");
        expect(body.messages[1].content).toBe("Hello<sep/>Goodbye");
    });

    it("keeps an empty AI slot aligned and excludes its source fallback from cache", async () => {
        const general = normalizeProvider({ ...provider, model: "qwen-plus" });
        fetchMock.mockResolvedValueOnce(completeResponse("<sep/>Goodbye"));
        expect(await aiPageTranslateWithProvider(general, ["Hello", "Goodbye"], "zh-CN")).toEqual([
            { text: "Hello", cacheable: false }, { text: "Goodbye", cacheable: true },
        ]);
        fetchMock.mockResolvedValueOnce(completeResponse("one response for two paragraphs"));
        expect((await aiPageTranslateWithProvider(general, ["Hello", "Goodbye"], "zh-CN"))
            .every(item => !item.cacheable)).toBe(true);
    });

    it("preserves blank paragraphs and falls back on empty translations", async () => {
        fetchMock.mockResolvedValue(completeResponse(" "));
        expect(await aiPageTranslate("mt", ["", "  ", "Hello"], "zh-CN")).toEqual(["", "  ", "Hello"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["你好<b0>世界</b0>", "你好<b0>世界</b0>"],
        ["你好<b1>世界</b1>", "你好世界"],
    ])("validates paragraph placeholders in %s", async (output, expected) => {
        fetchMock.mockResolvedValue(completeResponse(output));
        expect(await aiPageTranslate("mt", ["Hello <b0>world</b0>"], "zh-CN")).toEqual([expected]);
    });

    it("rejects oversized Qwen-MT input before requesting", async () => {
        await expect(aiPageTranslate("mt", ["x".repeat(AI_MAX_INPUT_CHARS + 1)], "en")).rejects.toThrow("Text too long");
        expect(fetchMock).not.toHaveBeenCalled();
    });

});

describe("OpenAI Chat Completions parameters", () => {
    const official = new AiProvider("openai", "openai", "OpenAI", "https://api.openai.com/v1/chat/completions", "test-key", "reasoning-model");

    it("uses the same non-streaming parameters for the draft test and actual translation", async () => {
        const draft = normalizeProvider({ ...official, model: "unsaved-model" });
        fetchMock.mockResolvedValueOnce(completeResponse("  你好  ")).mockResolvedValueOnce(completeResponse("你好"));
        expect(await runAiAction(ACTION.AI_PROVIDER_TEST, draft)).toEqual({
            status: STATUS_SUCCESS, data: { reply: "你好" },
        });
        expect(configGet).not.toHaveBeenCalled();
        configGet.mockResolvedValue([official]);
        expect(await aiPageTranslate(official.id, ["Hello"], "zh-CN")).toEqual(["你好"]);

        const [testBody, pageBody] = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
        expect(testBody.model).toBe("unsaved-model");
        expect(pageBody.model).toBe(official.model);
        for (const body of [testBody, pageBody]) {
            expect(body).toMatchObject({ stream: false, messages: expect.arrayContaining([{ role: "user", content: "Hello" }]) });
            expect(body).not.toHaveProperty("max_tokens");
            expect(body).not.toHaveProperty("max_completion_tokens");
            expect(body).not.toHaveProperty("temperature");
        }
    });

    it.each([
        ["https://api.openai.com/v1/chat/completions", "max_completion_tokens"],
        ["https://api.openai.com.example.org/v1/chat/completions", "max_tokens"],
    ])("uses the right token field for %s in both request modes", async (url, tokenKey) => {
        const target = normalizeProvider({ ...official, url });
        const opts = { ...options, maxTokens: 512, temperature: 0 };
        fetchMock.mockResolvedValueOnce(completeResponse("你好")).mockResolvedValueOnce(streamResponse(["你好"]));
        expect(await chatCompleteNonStream(target, messages, opts)).toBe("你好");
        expect(await collect(chatStream(target, messages, opts))).toEqual(["你好"]);
        for (const [index, [, init]] of fetchMock.mock.calls.entries()) {
            expect(JSON.parse(init.body)).toEqual({
                model: official.model, messages, stream: index === 1, [tokenKey]: 512,
                ...(tokenKey === "max_tokens" ? { temperature: 0 } : {}),
            });
        }
    });

    it("leaves token limits and sampling unset in normal streaming writing requests", async () => {
        fetchMock.mockResolvedValueOnce(streamResponse(["Polished text"]));
        const writing = buildPrompt({ task: AI_TASK.POLISH, payload: { text: "An example." } });
        expect(await collect(chatStream(official, writing, { task: AI_TASK.POLISH }))).toEqual(["Polished text"]);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: official.model, messages: writing, stream: true });
    });

    it("does not report success for a reasoning-only response or retry provider errors", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, reasoning_content: "internal" } }] }));
        expect(await runAiAction(ACTION.AI_PROVIDER_TEST, official)).toMatchObject({
            status: STATUS_FAIL, data: { message: "The translation service returned no text." },
        });
        fetchMock.mockResolvedValueOnce(new Response("Unsupported parameter", { status: 400 }));
        expect(await runAiAction(ACTION.AI_PROVIDER_TEST, official)).toMatchObject({
            status: STATUS_FAIL, data: { message: expect.stringContaining("Unsupported parameter") },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("OpenCode Go", () => {
    const opencode = new AiProvider("oc", "opencode", "OpenCode Go", "https://opencode.ai/inference/go/openai/v1/chat/completions", "oc-key", "kimi-k3");

    it("sends a stable session header on both the streaming and one-shot paths", async () => {
        fetchMock.mockResolvedValueOnce(completeResponse("你好"));
        expect(await chatCompleteNonStream(opencode, messages, options)).toBe("你好");
        fetchMock.mockResolvedValueOnce(streamResponse(["你", "好"]));
        expect(await collect(chatStream(opencode, messages, options))).toEqual(["你", "好"]);

        const sessions = fetchMock.mock.calls.map(([, init]) => init.headers[OPENCODE_SESSION_HEADER]);
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(sessions[1]).toBe(sessions[0]);
        for (const [url, init] of fetchMock.mock.calls) {
            expect(url).toBe(opencode.url);
            expect(init.headers.Authorization).toBe("Bearer oc-key");
            expect(JSON.parse(init.body).model).toBe("kimi-k3");
        }
    });

    it("does not leak the session header to other OpenAI-compatible providers", async () => {
        fetchMock.mockResolvedValue(completeResponse("ok"));
        const other = normalizeProvider({ ...provider, type: "openai", model: "gpt-4o" });
        await chatCompleteNonStream(other, messages, options);
        expect(fetchMock.mock.calls[0][1].headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
    });
});
