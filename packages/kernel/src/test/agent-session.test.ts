import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@pickle-pee/pi-ai";
import { createAgentSession } from "../agent-session.js";

vi.mock("../provider-registry.js", () => {
	return {
		streamWithKernelProvider: (model: Model<any>, context: { systemPrompt: string }) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const contentText = context.systemPrompt.includes("compacting a coding session")
					? "Summary: repository inspected, failing command isolated, next step is to patch compact."
					: "Initial assistant reply.";
				const message: AssistantMessage = {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: contentText }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	};
});

describe("createAgentSession", () => {
	it("supports manual compact and emits compaction events", async () => {
		const model: Model<any> = {
			id: "glm-5.1",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			maxTokens: 8192,
		};
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			model,
			modelRegistry: {
				list: () => [model],
				find: () => model,
				getRequestAuth: () => ({ ok: true, apiKey: "test-key", headers: undefined }),
			} as never,
			authStorage: {} as never,
		});

		const seen: string[] = [];
		session.subscribe((event) => {
			if (event && typeof event === "object" && "type" in event && typeof event.type === "string") {
				seen.push(event.type);
			}
		});

		await session.prompt("Please inspect the compact failure.");
		const snapshotBeforeCompact = await session.getSnapshot();
		expect(snapshotBeforeCompact.sessionId.length).toBeGreaterThan(0);
		await session.compact("Preserve the failure cause and next step.");

		expect(seen).toContain("compaction_start");
		expect(seen).toContain("compaction_end");
	});
});
