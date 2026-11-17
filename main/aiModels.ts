// BACKGROUND ONLY: model discovery uses the unsaved provider draft.
import type { AiProvider } from "@/main/aiProvider";
import { applyTemplate } from "@/main/aiServiceShared";

function modelsUrl(provider: Pick<AiProvider, "type" | "url" | "apiKey" | "model">): URL {
    let url: URL;
    try {
        url = new URL(applyTemplate(provider.url.trim(), { model: provider.model || "_", key: provider.apiKey }));
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
    } catch {
        throw new Error("Invalid models API URL");
    }
    url.hash = "";
    let path = url.pathname.replace(/\/+$/, "");
    if (provider.type === "gemini") {
        path = path.replace(/\/models(?:\/[^/]+(?::(?:streamGenerateContent|generateContent))?)?$/, "");
        url.searchParams.delete("alt");
        if (provider.apiKey) url.searchParams.set("key", provider.apiKey);
    } else {
        path = path.replace(/\/(?:chat\/completions|messages|responses|models)$/, "");
    }
    url.pathname = `${path || (provider.type === "gemini" ? "/v1beta" : "/v1")}/models`;
    return url;
}

/** List models using the same protocol and origin as the configured provider. */
export async function fetchProviderModels(provider: Pick<AiProvider, "type" | "url" | "apiKey" | "model">): Promise<string[]> {
    if (provider.type === "opencode") throw new Error("Model discovery is not supported for this provider");
    const url = modelsUrl(provider);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider.type === "claude") {
        if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else if (provider.type !== "gemini" && provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const models = new Set<string>();
    const cursors = new Set<string>();
    try {
        for (let page = 0; page < 100; page++) {
            let response: Response;
            try {
                response = await fetch(url.toString(), { headers, signal: controller.signal });
            } catch {
                throw new Error(controller.signal.aborted ? "Model discovery timed out" : "Unable to connect to models API");
            }
            if (!response.ok) throw new Error(`Models API returned HTTP ${response.status}`);
            let data: any;
            try { data = await response.json(); } catch {
                throw new Error(controller.signal.aborted ? "Model discovery timed out" : "Models API did not return valid JSON");
            }
            const items = provider.type === "gemini" ? data?.models : data?.data;
            if (!Array.isArray(items)) throw new Error("Invalid models API response");
            for (const item of items) {
                if (provider.type === "gemini" && Array.isArray(item?.supportedGenerationMethods)
                    && !item.supportedGenerationMethods.includes("generateContent")) continue;
                const id = provider.type === "gemini"
                    ? (typeof item?.name === "string" ? item.name.replace(/^models\//, "") : undefined) : item?.id;
                if (typeof id === "string" && id.trim()) models.add(id.trim());
            }
            const cursor = provider.type === "gemini" ? data.nextPageToken
                : provider.type === "claude" && data.has_more ? data.last_id : undefined;
            if (!cursor) {
                if (provider.type === "claude" && data.has_more) throw new Error("Invalid models pagination response");
                if (!models.size) throw new Error("No available models returned; enter a model name manually");
                return [...models];
            }
            if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Invalid models pagination response");
            cursors.add(cursor);
            url.searchParams.set(provider.type === "gemini" ? "pageToken" : "after_id", cursor);
        }
        throw new Error("Too many models API pages");
    } finally {
        clearTimeout(timer);
    }
}
