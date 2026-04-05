import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAiCompletions } from "../providers/openai.js";

function streamFromStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function createModel(overrides?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		api: "openai-completions",
		provider: "zai",
		id: "glm-5.1",
		baseUrl: "https://example.com/api/",
		reasoning: false,
		compat: {},
		...overrides,
	} as Model<"openai-completions">;
}

function createContext(): Context {
	return {
		systemPrompt: null,
		messages: [{ role: "user", content: "hi" }],
		tools: [],
	} as unknown as Context;
}

describe("streamOpenAiCompletions", () => {
	it("streams text deltas and completes", async () => {
		const response = new Response(
			streamFromStrings([
				`data: ${JSON.stringify({
					id: "resp_1",
					choices: [{ delta: { content: "Hello" } }],
				})}\n\n`,
				"data: [DONE]\n\n",
			]),
			{ status: 200 },
		);
		vi.stubGlobal("fetch", vi.fn(async () => response) as unknown as typeof fetch);

		const stream = streamOpenAiCompletions(createModel(), createContext());
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("text_end");
		expect(events).toContain("done");
	});

	it("formats JSON error messages for easier diagnosis", async () => {
		const response = new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
			status: 401,
			statusText: "Unauthorized",
		});
		vi.stubGlobal("fetch", vi.fn(async () => response) as unknown as typeof fetch);

		const result = await streamOpenAiCompletions(createModel(), createContext()).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("401 Unauthorized");
		expect(result.errorMessage).toContain("Invalid API key");
	});
});

