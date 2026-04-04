import type { AssistantMessage, Model } from "@mariozechner/pi-ai";

export function createAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function resolveEndpoint(baseUrl: string, path: string): string {
	return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export async function* iterateSseData(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request aborted");
			}

			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary === -1) {
					break;
				}

				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const payload = rawEvent
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (payload.length > 0) {
					yield payload;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function safeParseJson(value: string): any {
	if (!value || value.trim().length === 0) {
		return {};
	}

	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
