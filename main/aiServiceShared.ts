/** Maximum source text per AI request, including independently translated paragraphs. */
export const AI_MAX_INPUT_CHARS = 20_000;

export function assertAiInputLength(text: string): void {
    if (text.length > AI_MAX_INPUT_CHARS) {
        throw new Error(
            `Text too long for one AI request (${text.length} chars, limit ${AI_MAX_INPUT_CHARS}). Split it into smaller pieces.`,
        );
    }
}

export function applyTemplate(url: string, vars: { model: string; key: string }): string {
    return url
        .replace(/\{model\}/g, encodeURIComponent(vars.model))
        .replace(/\{key\}/g, encodeURIComponent(vars.key));
}

export interface SseEvent { event: string; data: string }

/** Preserve event names for public translation protocols; handle CRLF and EOF. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = (frame: string): SseEvent | undefined => {
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split(/\r\n|\n|\r/)) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            if (field === 'data') data.push(value);
        }
        return data.length || event !== 'message' ? { event, data: data.join('\n') } : undefined;
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let boundary: RegExpMatchArray | null;
            while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
                const frame = buffer.slice(0, boundary.index!);
                buffer = buffer.slice(boundary.index! + boundary[0].length);
                const event = parse(frame);
                if (event) yield event;
            }
            if (done) {
                const event = parse(buffer);
                if (event) yield event;
                return;
            }
        }
    } finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}

export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    for await (const event of sseEvents(body)) {
        if (event.data) yield event.data;
    }
}

const NON_STREAM_MAX_CONCURRENCY = 5;
let nonStreamActive = 0;
const nonStreamWaiters: (() => void)[] = [];

function acquireNonStreamSlot(): Promise<void> {
    if (nonStreamActive < NON_STREAM_MAX_CONCURRENCY) {
        nonStreamActive++;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => nonStreamWaiters.push(resolve));
}

function releaseNonStreamSlot(): void {
    const next = nonStreamWaiters.shift();
    if (next) {
        // Hand the slot straight to the next waiter — active count stays put.
        next();
    } else {
        nonStreamActive--;
    }
}

/** Shares the upstream concurrency limit across all non-streaming AI providers. */
export async function withNonStreamSlot<T>(request: () => Promise<T>): Promise<T> {
    await acquireNonStreamSlot();
    try {
        return await request();
    } finally {
        releaseNonStreamSlot();
    }
}
