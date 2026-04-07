import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "../session-manager.js";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@pickle-pee/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../agent-session.js";

const streamCalls: Array<{ systemPrompt: string; messages: readonly unknown[] }> = [];

vi.mock("../provider-registry.js", () => {
	return {
		streamWithKernelProvider: (model: Model<any>, context: { systemPrompt: string }) => {
			streamCalls.push({
				systemPrompt: context.systemPrompt,
				messages: [...("messages" in context && Array.isArray(context.messages) ? context.messages : [])],
			});
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
	it("restores prior messages from sessionFile into the agent context", async () => {
		streamCalls.length = 0;
		const model: Model<any> = {
			id: "glm-5.1",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			maxTokens: 8192,
		};
		const dir = await mkdtemp(join(tmpdir(), "genesis-agent-session-restore-"));
		const sessionFile = join(dir, "session.jsonl");
		await writeFile(
			sessionFile,
			`${[
				JSON.stringify({ cwd: dir, sessionId: "restored-session" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "之前问过你什么问题" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "你之前问过我什么是桌游。" } }),
			].join("\n")}\n`,
			"utf8",
		);

		const { session } = await createAgentSession({
			cwd: dir,
			model,
			modelRegistry: {
				list: () => [model],
				find: () => model,
				getRequestAuth: () => ({ ok: true, apiKey: "test-key", headers: undefined }),
			} as never,
			authStorage: {} as never,
			sessionManager: {
				getSessionId: () => "restored-session",
				getSessionFile: () => sessionFile,
			} as never,
		});

		await session.prompt("继续");
		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0]?.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "之前问过你什么问题" }] },
			{ role: "assistant", content: [{ type: "text", text: "你之前问过我什么是桌游。" }] },
			{ role: "user", content: [{ type: "text", text: "继续" }] },
		]);
	});

	it("supports manual compact and emits compaction events", async () => {
		streamCalls.length = 0;
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

	it("persists new sessions to sessionFile and restores later prompts from that file", async () => {
		streamCalls.length = 0;
		const model: Model<any> = {
			id: "glm-5.1",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			maxTokens: 8192,
		};
		const dir = await mkdtemp(join(tmpdir(), "genesis-agent-session-persist-"));
		const shared = {
			modelRegistry: {
				list: () => [model],
				find: () => model,
				getRequestAuth: () => ({ ok: true, apiKey: "test-key", headers: undefined }),
			} as never,
			authStorage: {} as never,
		};

		const first = await createAgentSession({
			cwd: dir,
			model,
			...shared,
		});
		await first.session.prompt("你好 什么是 vscode");
		const snapshot = await first.session.getSnapshot();
		expect(snapshot.sessionFile).toBeTruthy();
		const persisted = await readFile(snapshot.sessionFile!, "utf8");
		expect(persisted).toContain('"role":"user"');
		expect(persisted).toContain("你好 什么是 vscode");

		streamCalls.length = 0;
		const second = await createAgentSession({
			cwd: dir,
			model,
			...shared,
			sessionManager: SessionManager.open(snapshot.sessionFile!),
		});
		await second.session.prompt("我之前问过你什么问题");

		expect(streamCalls[0]?.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "你好 什么是 vscode" }] },
			{ role: "assistant" },
			{ role: "user", content: [{ type: "text", text: "我之前问过你什么问题" }] },
		]);
	});
});
