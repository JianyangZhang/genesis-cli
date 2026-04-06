import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppRuntime } from "../create-app-runtime.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ModelDescriptor, SessionRecoveryData } from "../types/index.js";
import { StubKernelSessionAdapter } from "./stubs/stub-kernel-session-adapter.js";

const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

class SequencedRecoveryAdapter extends StubKernelSessionAdapter {
	private index = 0;

	constructor(private readonly snapshots: readonly SessionRecoveryData[]) {
		super();
	}

	override async getRecoveryData(): Promise<SessionRecoveryData> {
		const current = this.snapshots[Math.min(this.index, this.snapshots.length - 1)];
		this.index += 1;
		if (!current) {
			throw new Error("No recovery snapshot configured");
		}
		return current;
	}
}

describe("createAppRuntime", () => {
	it("creates a runtime with an event bus", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		expect(runtime.events).toBeDefined();
	});

	it("createSession returns an active SessionFacade", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const session = runtime.createSession();

		expect(session.state.status).toBe("active");
		expect(session.id.value).toBeTruthy();
		expect(session.context.mode).toBe("print");
		expect(session.context.workingDirectory).toBe("/tmp");
		expect(session.context.model).toEqual(stubModel);
	});

	it("createSession emits session_created on global bus", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "json",
			model: stubModel,
			adapter,
		});

		const events: RuntimeEvent[] = [];
		runtime.events.on("session_created", (e) => events.push(e));

		runtime.createSession();

		expect(events).toHaveLength(1);
		expect(events[0]!.category).toBe("session");
		if (events[0]!.type === "session_created") {
			expect(events[0]!.model).toEqual(stubModel);
		}
	});

	it("recoverSession restores state and emits session_resumed", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			adapter,
		});

		// Create, then serialize for recovery
		const session = runtime.createSession();
		const recoveryData = {
			sessionId: session.id,
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
		};

		// Create a fresh runtime for recovery
		const adapter2 = new StubKernelSessionAdapter();
		const runtime2 = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			adapter: adapter2,
		});

		const events: RuntimeEvent[] = [];
		runtime2.events.on("session_resumed", (e) => events.push(e));

		const recovered = runtime2.recoverSession(recoveryData);

		expect(recovered.state.status).toBe("active");
		expect(recovered.id).toEqual(session.id);
		expect(events).toHaveLength(1);
		if (events[0]!.type === "session_resumed") {
			expect(events[0]!.recoveryData.model).toEqual(stubModel);
		}
	});

	// --- Fix 1: adapter.resume() is called during recovery ---

	it("recoverSession calls adapter.resume with recovery data", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			adapter,
		});

		const recoveryData = {
			sessionId: { value: "test-recovery-id" },
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
		};

		runtime.recoverSession(recoveryData);

		expect(adapter.resumeCalled).toBe(true);
		expect(adapter.lastResumeData).toEqual(recoveryData);
	});

	it("records and lists recent sessions via the runtime contract", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-recent-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});

		const recoveryData = {
			sessionId: { value: "recent-session" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				summary: "resume this task",
				firstPrompt: "resume this task",
				messageCount: 2,
				fileSizeBytes: 128,
				recentMessages: [
					{ role: "user" as const, text: "resume this task" },
					{ role: "assistant" as const, text: "Sure." },
				],
			},
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
		};

		await runtime.recordRecentSession(recoveryData, { title: "recent" });
		const recent = await runtime.listRecentSessions();
		const last = JSON.parse(await readFile(join(historyDir, "last.json"), "utf8")) as {
			sessionId: { value: string };
			metadata?: {
				resumeSummary?: {
					title?: string;
					goal?: string;
					userIntent?: string;
					lastAssistantTurn?: string;
					source?: string;
				};
			};
		};
		const storedEntry = JSON.parse(
			await readFile(join(historyDir, "entries", "recent-session.json"), "utf8"),
		) as {
			sessionId: { value: string };
			metadata?: {
				resumeSummary?: {
					title?: string;
					source?: string;
				};
			};
		};

		expect(recent).toHaveLength(1);
		expect(recent[0]?.title).toBe("recent");
		expect(recent[0]?.recoveryData.sessionId.value).toBe("recent-session");
		expect(recent[0]?.recoveryData.metadata?.resumeSummary).toMatchObject({
			title: "resume this task",
			goal: "resume this task",
			userIntent: "resume this task",
			lastAssistantTurn: "Sure.",
			source: "rule",
		});
		expect(last.sessionId.value).toBe("recent-session");
		expect(last.metadata?.resumeSummary).toMatchObject({
			title: "resume this task",
			goal: "resume this task",
			userIntent: "resume this task",
			lastAssistantTurn: "Sure.",
			source: "rule",
		});
		expect(storedEntry.sessionId.value).toBe("recent-session");
		expect(storedEntry.metadata?.resumeSummary).toMatchObject({
			title: "resume this task",
			source: "rule",
		});
	});

	it("builds runtime-owned session history from user and assistant turns", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-history-turns-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const session = runtime.createSession();

		await runtime.recordRecentSessionInput(session, "你好 什么是桌游");
		await runtime.recordRecentSessionAssistantText(
			session,
			"桌游是在桌面上进行、强调面对面互动和策略思考的游戏。",
		);

		const recent = await runtime.listRecentSessions();
		const storedSessionId = recent[0]?.recoveryData.sessionId.value;
		const storedEntry = JSON.parse(
			await readFile(join(historyDir, "entries", `${storedSessionId}.json`), "utf8"),
		) as {
			metadata?: {
				firstPrompt?: string;
				recentMessages?: Array<{ role: string; text: string }>;
				resumeSummary?: { title?: string; lastAssistantTurn?: string };
			};
		};

		expect(recent[0]?.recoveryData.metadata).toMatchObject({
			firstPrompt: "你好 什么是桌游",
		});
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "你好 什么是桌游" },
			{ role: "assistant", text: "桌游是在桌面上进行、强调面对面互动和策略思考的游戏。" },
		]);
		expect(recent[0]?.recoveryData.metadata?.resumeSummary).toMatchObject({
			lastAssistantTurn: "桌游是在桌面上进行、强调面对面互动和策略思考的游戏。",
		});
		expect(storedEntry.metadata?.firstPrompt).toBe("你好 什么是桌游");
		expect(storedEntry.metadata?.recentMessages).toEqual([
			{ role: "user", text: "你好 什么是桌游" },
			{ role: "assistant", text: "桌游是在桌面上进行、强调面对面互动和策略思考的游戏。" },
		]);
	});

	it("keeps the first prompt across unknown-to-real session id transitions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-live-id-transition-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new SequencedRecoveryAdapter([
				{
					sessionId: { value: "unknown-session" },
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					metadata: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
				{
					sessionId: { value: "real-session-id" },
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					metadata: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
				{
					sessionId: { value: "real-session-id" },
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					metadata: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
			]),
		});
		const session = runtime.createSession();

		await runtime.recordRecentSessionInput(session, "你好 什么是桌游");
		await runtime.recordRecentSessionAssistantText(session, "桌游适合多人面对面互动。");
		await runtime.recordRecentSessionInput(session, "哈哈");

		const recent = await runtime.listRecentSessions();
		const entryFiles = await readdir(join(historyDir, "entries"));
		const canonicalSessionId = session.id.value;

		expect(recent).toHaveLength(1);
		expect(recent[0]?.recoveryData.sessionId.value).toBe(canonicalSessionId);
		expect(recent[0]?.recoveryData.metadata?.firstPrompt).toBe("你好 什么是桌游");
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "你好 什么是桌游" },
			{ role: "assistant", text: "桌游适合多人面对面互动。" },
			{ role: "user", text: "哈哈" },
		]);
		expect(entryFiles).toEqual([`${canonicalSessionId}.json`]);
	});

	it("preserves the earliest firstPrompt and deduplicates overlapping recent messages", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-history-overlap-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const sessionId = { value: "overlap-session" };

		await runtime.recordRecentSession({
			sessionId,
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				firstPrompt: "什么是桌游",
				summary: "第一轮回答",
				messageCount: 3,
				fileSizeBytes: 0,
				recentMessages: [
					{ role: "user", text: "什么是桌游" },
					{ role: "assistant", text: "第一轮长回答" },
					{ role: "user", text: "哈哈" },
				],
				resumeSummary: null,
			},
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		});

		await runtime.recordRecentSession({
			sessionId,
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				firstPrompt: "哈哈",
				summary: "第二轮回答",
				messageCount: 4,
				fileSizeBytes: 0,
				recentMessages: [
					{ role: "assistant", text: "第一轮长回答" },
					{ role: "user", text: "哈哈" },
					{ role: "assistant", text: "第二轮短回答" },
				],
				resumeSummary: null,
			},
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		});

		const recent = await runtime.listRecentSessions();
		expect(recent).toHaveLength(1);
		expect(recent[0]?.recoveryData.metadata?.firstPrompt).toBe("什么是桌游");
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "什么是桌游" },
			{ role: "assistant", text: "第一轮长回答" },
			{ role: "user", text: "哈哈" },
			{ role: "assistant", text: "第二轮短回答" },
		]);
	});

	it("searches recent sessions by relevance and persists a fallback title", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-search-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});

		await runtime.recordRecentSession({
			sessionId: { value: "session-a" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				summary: "整理发布流程",
				firstPrompt: "发布前检查 README",
				messageCount: 2,
				fileSizeBytes: 128,
				recentMessages: [
					{ role: "user" as const, text: "发布前检查 README" },
					{ role: "assistant" as const, text: "我先检查变更。" },
				],
			},
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
		});
		await runtime.recordRecentSession({
			sessionId: { value: "session-b" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				summary: "README 发布说明",
				firstPrompt: "README 发布说明补充",
				messageCount: 2,
				fileSizeBytes: 128,
				recentMessages: [
					{ role: "user" as const, text: "README 发布说明补充" },
					{ role: "assistant" as const, text: "收到。" },
				],
			},
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
		});

		const results = await runtime.searchRecentSessions("README 发布");
		expect(results).toHaveLength(2);
		expect(results[0]?.entry.recoveryData.sessionId.value).toBe("session-b");
		expect(results[0]?.headline).toBe("README 发布说明补充");
		expect(results[0]?.matchSource).toBe("title");
		expect(results[0]?.snippet).toContain("README 发布说明补充");
		expect(results[1]?.entry.recoveryData.sessionId.value).toBe("session-a");
		expect(results[1]?.matchSource).toBe("title");

		const browserResults = await runtime.searchRecentSessions("");
		expect(browserResults[0]?.entry.recoveryData.sessionId.value).toBe("session-b");
		expect(browserResults[0]?.matchSource).toBe("recent");
		expect(browserResults[0]?.snippet).toContain("README 发布说明");
	});

	it("preserves model-generated resume summaries when recording recent sessions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-resume-summary-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});

		await runtime.recordRecentSession({
			sessionId: { value: "session-model-summary" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				summary: "规则摘要",
				firstPrompt: "最初提示",
				messageCount: 3,
				fileSizeBytes: 128,
				recentMessages: [
					{ role: "user" as const, text: "最初提示" },
					{ role: "assistant" as const, text: "最新回复" },
				],
				resumeSummary: {
					title: "模型标题",
					goal: "模型目标",
					userIntent: "模型意图",
					assistantState: "模型状态",
					lastUserTurn: "模型用户最新输入",
					lastAssistantTurn: "模型助手最新回复",
					generatedAt: 123,
					source: "model",
					version: 1,
				},
			},
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
		});

		const recent = await runtime.listRecentSessions();
		expect(recent[0]?.recoveryData.metadata?.resumeSummary).toMatchObject({
			title: "模型标题",
			goal: "模型目标",
			source: "model",
		});
	});

	it("loads metadata from sessionFile before persisting session history", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-session-file-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const sessionFile = join(agentDir, "session.jsonl");
		await writeFile(
			sessionFile,
			[
				JSON.stringify({ type: "session_info", name: "桌游之夜" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "帮我整理桌游清单" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "我先列候选项。" } }),
			].join("\n") + "\n",
			"utf8",
		);

		await runtime.recordRecentSession({
			sessionId: { value: "session-from-file" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
			sessionFile,
		});

		const recent = await runtime.listRecentSessions();
		const storedEntry = JSON.parse(
			await readFile(join(historyDir, "entries", "session-from-file.json"), "utf8"),
		) as {
			metadata?: {
				summary?: string;
				firstPrompt?: string;
				recentMessages?: Array<{ role: string; text: string }>;
				resumeSummary?: { title?: string };
			};
		};

		expect(recent[0]?.recoveryData.metadata).toMatchObject({
			summary: "桌游之夜",
			firstPrompt: "帮我整理桌游清单",
		});
		expect(recent[0]?.recoveryData.metadata?.resumeSummary).toMatchObject({
			title: "桌游之夜",
		});
		expect(storedEntry.metadata).toMatchObject({
			summary: "桌游之夜",
			firstPrompt: "帮我整理桌游清单",
		});
		expect(storedEntry.metadata?.recentMessages).toEqual([
			{ role: "user", text: "帮我整理桌游清单" },
			{ role: "assistant", text: "我先列候选项。" },
		]);
	});

	it("prunes recent sessions down to the latest 10 entries", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-prune-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const sessionsDir = historyDir;
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(
			join(sessionsDir, "recent.json"),
			`${JSON.stringify(
				Array.from({ length: 12 }, (_, index) => ({
					recoveryData: {
						sessionId: { value: `session-${index}` },
						model: stubModel,
						toolSet: ["read"],
						planSummary: null,
						compactionSummary: null,
						metadata: {
							summary: `summary-${index}`,
							firstPrompt: `prompt-${index}`,
							messageCount: 1,
							fileSizeBytes: 64,
							recentMessages: [{ role: "user", text: `prompt-${index}` }],
						},
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
						agentDir,
					},
					title: `title-${index}`,
					updatedAt: 1000 - index,
				})),
				null,
				2,
			)}\n`,
			"utf8",
		);

		const prune = await runtime.pruneRecentSessions(10);
		const recent = await runtime.listRecentSessions();

		expect(prune).toEqual({ before: 12, after: 10, removed: 2 });
		expect(recent).toHaveLength(10);
		expect(recent[0]?.recoveryData.sessionId.value).toBe("session-0");
		expect(recent.at(-1)?.recoveryData.sessionId.value).toBe("session-9");
	});

	it("rewrites legacy recent-session entries while pruning", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-legacy-prune-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const sessionsDir = historyDir;
		await mkdir(sessionsDir, { recursive: true });
		await writeFile(
			join(sessionsDir, "recent.json"),
			`${JSON.stringify(
				[
					{
						recoveryData: {
							sessionId: { value: "legacy-session" },
							model: { id: "unknown", provider: "unknown" },
							toolSet: [],
							planSummary: null,
							compactionSummary: null,
							metadata: null,
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
						},
						updatedAt: 1000,
					},
				],
				null,
				2,
			)}\n`,
			"utf8",
		);
		await writeFile(
			join(sessionsDir, "last.json"),
			`${JSON.stringify(
				{
					sessionId: { value: "legacy-session" },
					model: { id: "unknown", provider: "unknown" },
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					metadata: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const prune = await runtime.pruneRecentSessions(10);
		const recent = await runtime.listRecentSessions();
		const rewritten = JSON.parse(await readFile(join(sessionsDir, "recent.json"), "utf8")) as Array<{
			recoveryData: { model: { id: string; provider: string }; metadata?: unknown };
		}>;
		const rewrittenLast = JSON.parse(await readFile(join(sessionsDir, "last.json"), "utf8")) as {
			model: { id: string; provider: string };
			metadata?: unknown;
		};

		expect(prune).toEqual({ before: 1, after: 1, removed: 0 });
		expect(recent[0]?.recoveryData.model).toEqual({ id: "", provider: "" });
		expect(recent[0]?.recoveryData.metadata).toBeUndefined();
		expect(rewritten[0]?.recoveryData.model).toEqual({ id: "", provider: "" });
		expect(rewritten[0]?.recoveryData.metadata).toBeUndefined();
		expect(rewrittenLast.model).toEqual({ id: "", provider: "" });
		expect(rewrittenLast.metadata).toBeUndefined();
	});

	it("tracks and updates the default model for newly created sessions", async () => {
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			createAdapter: (model) => {
				const adapter = new StubKernelSessionAdapter();
				adapter.setModel(model);
				return adapter;
			},
		});

		expect(runtime.getDefaultModel()).toEqual(stubModel);
		runtime.setDefaultModel({ id: "glm-5.2", provider: "zai", displayName: "GLM 5.2" });

		const session = runtime.createSession();
		expect(runtime.getDefaultModel().id).toBe("glm-5.2");
		expect(session.state.model.id).toBe("glm-5.2");
	});

	it("createAdapter provisions a fresh adapter per session", async () => {
		const adapters: StubKernelSessionAdapter[] = [];
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			createAdapter: (_model) => {
				const adapter = new StubKernelSessionAdapter();
				adapters.push(adapter);
				return adapter;
			},
		});

		const s1 = runtime.createSession();
		const s2 = runtime.createSession();

		adapters[0]!.enqueueDefaultEvents([{ type: "message_update", timestamp: 1000, payload: { content: "one" } }]);
		adapters[1]!.enqueueDefaultEvents([{ type: "message_update", timestamp: 2000, payload: { content: "two" } }]);

		await s1.prompt("first");
		await s2.prompt("second");

		expect(adapters).toHaveLength(2);
		expect(adapters[0]!.lastInput).toBe("first");
		expect(adapters[1]!.lastInput).toBe("second");

		await s1.close();
		expect(adapters[0]!.closed).toBe(true);
		expect(adapters[1]!.closed).toBe(false);
	});

	it("rejects a second session when only a single static adapter is provided", () => {
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});

		runtime.createSession();

		expect(() => runtime.createSession()).toThrow("createAdapter");
	});

	it("throws if no adapter is provided", () => {
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
		});

		expect(() => runtime.createSession()).toThrow("No KernelSessionAdapter provided");
	});

	it("shutdown closes all sessions", async () => {
		const adapters: StubKernelSessionAdapter[] = [];
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			createAdapter: (_model) => {
				const adapter = new StubKernelSessionAdapter();
				adapters.push(adapter);
				return adapter;
			},
		});

		const s1 = runtime.createSession();
		const s2 = runtime.createSession();

		await runtime.shutdown();

		expect(s1.state.status).toBe("closed");
		expect(s2.state.status).toBe("closed");
		expect(adapters).toHaveLength(2);
		expect(adapters.every((adapter) => adapter.closed)).toBe(true);
	});

	it("exposes governor with governance components", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		expect(runtime.governor).toBeDefined();
		expect(runtime.governor.catalog).toBeDefined();
		expect(runtime.governor.permissions).toBeDefined();
		expect(runtime.governor.mutations).toBeDefined();
		expect(runtime.governor.audit).toBeDefined();
	});

	it("registers builtin tool definitions for the configured tool set", () => {
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
			toolSet: ["read", "bash", "write"],
		});

		expect(runtime.governor.catalog.has("read")).toBe(true);
		expect(runtime.governor.catalog.has("bash")).toBe(true);
		expect(runtime.governor.catalog.has("write")).toBe(true);
	});

	it("auto-allows registered read-only bash tools instead of denying them at the catalog layer", async () => {
		const adapter = new StubKernelSessionAdapter();
		adapter.enqueueDefaultEvents([
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_1",
					parameters: { command: "pwd" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_1",
					status: "success",
					result: "/tmp",
					durationMs: 20,
				},
			},
		]);

		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "interactive",
			model: stubModel,
			adapter,
			toolSet: ["bash"],
		});

		const session = runtime.createSession();
		const events: RuntimeEvent[] = [];
		session.events.onAny((event) => events.push(event));

		await session.prompt("run pwd");

		expect(events.map((event) => event.type)).toContain("tool_started");
		expect(events.map((event) => event.type)).toContain("tool_completed");
		expect(events.map((event) => event.type)).not.toContain("permission_requested");
	});

	it("exposes planEngine that can create plans", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		expect(runtime.planEngine).toBeDefined();
		const draft = runtime.planEngine.createDraft("p1", "Goal", ["Step A"]);
		expect(draft.status).toBe("draft");
		expect(draft.steps).toHaveLength(1);
	});

	it("session facade exposes plan orchestrator when planEngine available", () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const session = runtime.createSession();
		expect(session.plan).toBeDefined();
		expect(session.plan).not.toBeNull();
	});

	it("same runtime can drive multiple modes (print + json)", () => {
		const adapter = new StubKernelSessionAdapter();

		const printRuntime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const jsonRuntime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "json",
			model: stubModel,
			adapter,
		});

		const printSession = printRuntime.createSession();
		const jsonSession = jsonRuntime.createSession();

		// Both share the same runtime design — different modes but same API
		expect(printSession.context.mode).toBe("print");
		expect(jsonSession.context.mode).toBe("json");
		expect(printSession.state.status).toBe("active");
		expect(jsonSession.state.status).toBe("active");
	});
});
