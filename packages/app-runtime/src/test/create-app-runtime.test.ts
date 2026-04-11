import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
	const originalRecentSessionMaxEntries = process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES;

	afterEach(() => {
		if (originalRecentSessionMaxEntries === undefined) {
			delete process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES;
		} else {
			process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES = originalRecentSessionMaxEntries;
		}
	});

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
			workingDirectory: "/tmp/recovered-workdir",
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
		expect(recovered.context.workingDirectory).toBe("/tmp/recovered-workdir");
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

	it("keeps recover -> setModel -> close lifecycle stable for a recovered session", async () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "interactive",
			model: stubModel,
			adapter,
		});
		const recovered = runtime.recoverSession({
			sessionId: { value: "session-lifecycle" },
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		});

		await recovered.switchModel({ provider: "test", id: "next-model", displayName: "Next Model" });
		expect(adapter.lastModel).toMatchObject({ provider: "test", id: "next-model" });
		await recovered.close();
		expect(adapter.closed).toBe(true);
	});

	it("persists recovered session facts into recent catalog after follow-up input", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-recover-facts-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/fallback",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const recovered = runtime.recoverSession({
			sessionId: { value: "recovered-facts-session" },
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			workingDirectory: "/tmp/recovered-workdir",
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		});

		await runtime.recordRecentSessionInput(recovered, "恢复后继续推进");
		const recent = await runtime.listRecentSessions();

		expect(recent[0]?.recoveryData.sessionId.value).toBe("recovered-facts-session");
		expect(recent[0]?.recoveryData.workingDirectory).toBe("/tmp/recovered-workdir");
		expect(recent[0]?.recoveryData.toolSet).toEqual(["read", "edit"]);
		expect(recent[0]?.recoveryData.metadata?.firstPrompt).toBe("恢复后继续推进");
	});

	it("supports recoverSession + compaction + close + search as a stable recent-session flow", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-recover-flow-"));
		const historyDir = join(agentDir, "history");
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter,
		});
		const recoveryData: SessionRecoveryData = {
			sessionId: { value: "recovered-session" },
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		};
		const recovered = runtime.recoverSession(recoveryData);
		let closedRecoveryData: SessionRecoveryData | null = null;
		runtime.events.on("session_closed", (event) => {
			if (event.type === "session_closed") {
				closedRecoveryData = event.recoveryData;
			}
		});

		await runtime.recordRecentSessionInput(recovered, "README 发布流程");
		await runtime.recordRecentSessionEvent(recovered, {
			id: "evt-compaction-recovered",
			category: "compaction",
			type: "compaction_completed",
			timestamp: Date.now(),
			sessionId: recovered.id,
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 4,
				estimatedTokensSaved: 128,
				compactedSummary: "README 发布流程梳理完成",
			},
		});
		await recovered.close();
		await runtime.recordClosedRecentSession(recovered, closedRecoveryData!);

		const results = await runtime.searchRecentSessions("README 发布");
		expect(results).toHaveLength(1);
		expect(results[0]?.entry.recoveryData.sessionId.value).toBe("recovered-session");
		expect(results[0]?.entry.recoveryData.metadata?.summary).toContain("README 发布流程梳理完成");
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
		const storedEntry = JSON.parse(await readFile(join(historyDir, "entries", "recent-session.json"), "utf8")) as {
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

	it("persists canonicalized recovery data from session_closed into recent catalog", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-session-closed-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const session = runtime.createSession();
		let closedRecoveryData: SessionRecoveryData | null = null;
		runtime.events.on("session_closed", (event) => {
			if (event.type === "session_closed") {
				closedRecoveryData = event.recoveryData;
			}
		});

		await session.close();
		expect(closedRecoveryData).not.toBeNull();
		await runtime.recordClosedRecentSession(session, closedRecoveryData!);

		let recent = await runtime.listRecentSessions();
		for (let attempt = 0; attempt < 20 && recent.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			recent = await runtime.listRecentSessions();
		}

		expect(recent).toHaveLength(1);
		expect(recent[0]?.recoveryData.sessionId.value).toBe(session.id.value);
		expect(recent[0]?.recoveryData.model).toMatchObject({ id: "stub-model", provider: "stub" });
		expect(recent[0]?.recoveryData.toolSet).toEqual(["read", "edit"]);
		expect(recent[0]?.recoveryData.workingDirectory).toBe("/tmp/workspace");
		expect(recent[0]?.recoveryData.agentDir).toBe(agentDir);
	});

	it("treats kernel metadata as authoritative when closing a session with live metadata", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-kernel-metadata-authority-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		const session = runtime.createSession();
		await runtime.recordRecentSessionInput(session, "live first prompt");
		await runtime.recordRecentSessionAssistantText(session, "live assistant summary");

		await runtime.recordClosedRecentSession(session, {
			sessionId: session.id,
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			metadata: {
				summary: "kernel summary",
				firstPrompt: "kernel first prompt",
				messageCount: 2,
				fileSizeBytes: 128,
				recentMessages: [
					{ role: "user", text: "kernel first prompt" },
					{ role: "assistant", text: "kernel assistant answer" },
				],
			},
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
			workingDirectory: "/tmp/workspace",
			agentDir,
		});

		const recent = await runtime.listRecentSessions();
		expect(recent).toHaveLength(1);
		expect(recent[0]?.recoveryData.metadata).toMatchObject({
			summary: "kernel summary",
			firstPrompt: "kernel first prompt",
		});
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "kernel first prompt" },
			{ role: "assistant", text: "kernel assistant answer" },
		]);
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
		await runtime.recordRecentSessionAssistantText(session, "桌游是在桌面上进行、强调面对面互动和策略思考的游戏。");

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

	it("keeps resume-browser list and search stable across unknown-to-real recovery transitions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-resume-browser-flow-"));
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

		await runtime.recordRecentSessionInput(session, "README 发布流程");
		await runtime.recordRecentSessionAssistantText(session, "我先整理发布步骤。");
		await runtime.recordRecentSessionInput(session, "继续");

		const browserResults = await runtime.searchRecentSessions("");
		const searchResults = await runtime.searchRecentSessions("README 发布");
		expect(browserResults).toHaveLength(1);
		expect(searchResults).toHaveLength(1);
		expect(browserResults[0]?.entry.recoveryData.sessionId.value).toBe(session.id.value);
		expect(searchResults[0]?.entry.recoveryData.sessionId.value).toBe(session.id.value);
		expect(browserResults[0]?.entry.recoveryData.metadata?.firstPrompt).toBe("README 发布流程");
		expect(searchResults[0]?.snippet).toContain("README 发布流程");
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

	it("keeps recent search stable after session close and compaction event updates", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-combo-guard-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const session = runtime.createSession();
		let closedRecoveryData: SessionRecoveryData | null = null;
		runtime.events.on("session_closed", (event) => {
			if (event.type === "session_closed") {
				closedRecoveryData = event.recoveryData;
			}
		});

		await runtime.recordRecentSessionEvent(session, {
			id: "evt-compaction-session",
			category: "compaction",
			type: "compaction_completed",
			timestamp: Date.now(),
			sessionId: session.id,
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 4,
				estimatedTokensSaved: 128,
				compactedSummary: "README 发布流程梳理完成",
			},
		});
		await session.close();
		await runtime.recordClosedRecentSession(session, closedRecoveryData!);

		const results = await runtime.searchRecentSessions("README 发布");
		expect(results).toHaveLength(1);
		expect(results[0]?.entry.recoveryData.sessionId.value).toBe(session.id.value);
		expect(results[0]?.entry.recoveryData.metadata?.summary).toContain("README 发布流程梳理完成");
		expect(results[0]?.matchSource).toBe("title");
	});

	it("keeps resume/compact/recent-session behavior consistent across resumed turns", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-resume-compact-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const first = runtime.createSession();
		let closedRecoveryData: SessionRecoveryData | null = null;
		runtime.events.on("session_closed", (event) => {
			if (event.type === "session_closed") {
				closedRecoveryData = event.recoveryData;
			}
		});

		await runtime.recordRecentSessionEvent(first, {
			id: "evt-compaction-first",
			category: "compaction",
			type: "compaction_completed",
			timestamp: Date.now(),
			sessionId: first.id,
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 4,
				estimatedTokensSaved: 128,
				compactedSummary: "v1 compact summary",
			},
		});
		await first.close();
		await runtime.recordClosedRecentSession(first, closedRecoveryData!);

		const resumed = await runtime.recoverSession(closedRecoveryData!);
		await runtime.recordRecentSessionEvent(resumed, {
			id: "evt-compaction-resumed",
			category: "compaction",
			type: "compaction_completed",
			timestamp: Date.now(),
			sessionId: resumed.id,
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 4,
				estimatedTokensSaved: 128,
				compactedSummary: "v2 compact summary",
			},
		});
		await resumed.close();
		await runtime.recordClosedRecentSession(resumed, closedRecoveryData!);

		const recent = await runtime.listRecentSessions();
		const hits = await runtime.searchRecentSessions("v2 compact summary");
		expect(recent).toHaveLength(1);
		expect(recent[0]?.recoveryData.sessionId.value).toBe(first.id.value);
		expect(recent[0]?.recoveryData.metadata?.summary).toContain("v2 compact summary");
		expect(hits[0]?.entry.recoveryData.sessionId.value).toBe(first.id.value);
	});

	it("keeps recent catalog consistent across close-and-new-session transitions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-clear-new-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/workspace",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const previous = runtime.createSession();
		let closedRecoveryData: SessionRecoveryData | null = null;
		runtime.events.on("session_closed", (event) => {
			if (event.type === "session_closed") {
				closedRecoveryData = event.recoveryData;
			}
		});

		await runtime.recordRecentSessionInput(previous, "旧会话：整理 README");
		await previous.close();
		await runtime.recordClosedRecentSession(previous, closedRecoveryData!);

		const next = runtime.createSession();
		await runtime.recordRecentSessionInput(next, "新会话：修复测试");

		const browserResults = await runtime.searchRecentSessions("");
		const oldResults = await runtime.searchRecentSessions("旧会话");
		const newResults = await runtime.searchRecentSessions("新会话");
		const recent = await runtime.listRecentSessions();

		expect(recent).toHaveLength(2);
		expect(recent[0]?.recoveryData.sessionId.value).toBe(next.id.value);
		expect(recent[1]?.recoveryData.sessionId.value).toBe(previous.id.value);
		expect(newResults[0]?.entry.recoveryData.sessionId.value).toBe(next.id.value);
		expect(oldResults[0]?.entry.recoveryData.sessionId.value).toBe(previous.id.value);
		expect(browserResults.map((hit) => hit.entry.recoveryData.sessionId.value)).toEqual([
			next.id.value,
			previous.id.value,
		]);
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
			`${[
				JSON.stringify({ type: "session_info", name: "桌游之夜" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "帮我整理桌游清单" } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "我先列候选项。" } }),
			].join("\n")}\n`,
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
		const storedEntry = JSON.parse(await readFile(join(historyDir, "entries", "session-from-file.json"), "utf8")) as {
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

	it("refreshes cached recent-session metadata from sessionFile when runtime metadata is absent", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-session-refresh-"));
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
		const writeSessionFile = async (title: string, prompt: string, assistant: string) =>
			writeFile(
				sessionFile,
				`${[
					JSON.stringify({ type: "session_info", name: title }),
					JSON.stringify({ type: "message", message: { role: "user", content: prompt } }),
					JSON.stringify({ type: "message", message: { role: "assistant", content: assistant } }),
				].join("\n")}\n`,
				"utf8",
			);

		await writeSessionFile("旧标题", "旧问题", "旧回答");
		await runtime.recordRecentSession({
			sessionId: { value: "session-refresh" },
			model: stubModel,
			toolSet: ["read"],
			planSummary: null,
			compactionSummary: null,
			metadata: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			agentDir,
			sessionFile,
		});

		await writeSessionFile("新标题", "新问题", "新回答");
		await runtime.recordRecentSession({
			sessionId: { value: "session-refresh" },
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
		const storedEntry = JSON.parse(await readFile(join(historyDir, "entries", "session-refresh.json"), "utf8")) as {
			metadata?: {
				summary?: string;
				firstPrompt?: string;
				recentMessages?: Array<{ role: string; text: string }>;
				resumeSummary?: { title?: string };
			};
		};

		expect(recent[0]?.recoveryData.metadata).toMatchObject({
			summary: "新标题",
			firstPrompt: "新问题",
		});
		expect(recent[0]?.recoveryData.metadata?.resumeSummary).toMatchObject({
			title: "新标题",
		});
		expect(storedEntry.metadata).toMatchObject({
			summary: "新标题",
			firstPrompt: "新问题",
		});
		expect(storedEntry.metadata?.recentMessages).toEqual([
			{ role: "user", text: "新问题" },
			{ role: "assistant", text: "新回答" },
		]);
	});

	it("prefers entry-file recovery data over recent.json projections when listing sessions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-fact-source-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		await mkdir(join(historyDir, "entries"), { recursive: true });

		await writeFile(
			join(historyDir, "recent.json"),
			`${JSON.stringify(
				[
					{
						recoveryData: {
							sessionId: { value: "session-fact-source" },
							model: stubModel,
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "projection summary",
								firstPrompt: "projection prompt",
								messageCount: 1,
								fileSizeBytes: 64,
								recentMessages: [{ role: "user", text: "projection prompt" }],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							agentDir,
						},
						title: "Projection Title",
						updatedAt: 123,
					},
				],
				null,
				2,
			)}\n`,
			"utf8",
		);
		await writeFile(
			join(historyDir, "entries", "session-fact-source.json"),
			`${JSON.stringify({
				sessionId: { value: "session-fact-source" },
				model: stubModel,
				toolSet: ["read"],
				planSummary: null,
				compactionSummary: null,
				metadata: {
					summary: "entry summary",
					firstPrompt: "entry prompt",
					messageCount: 2,
					fileSizeBytes: 96,
					recentMessages: [
						{ role: "user", text: "entry prompt" },
						{ role: "assistant", text: "entry answer" },
					],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
			})}\n`,
			"utf8",
		);

		const recent = await runtime.listRecentSessions();

		expect(recent[0]?.title).toBe("Projection Title");
		expect(recent[0]?.updatedAt).toBe(123);
		expect(recent[0]?.recoveryData.metadata).toMatchObject({
			summary: "entry summary",
			firstPrompt: "entry prompt",
		});
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "entry prompt" },
			{ role: "assistant", text: "entry answer" },
		]);
	});

	it("deduplicates duplicate recent-session projections by sessionId when listing sessions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-dedupe-recent-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		await mkdir(join(historyDir, "entries"), { recursive: true });
		await writeFile(
			join(historyDir, "recent.json"),
			`${JSON.stringify(
				[
					{
						recoveryData: {
							sessionId: { value: "session-duplicate" },
							model: stubModel,
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "new projection",
								firstPrompt: "new projection",
								messageCount: 1,
								fileSizeBytes: 64,
								recentMessages: [{ role: "user", text: "new projection" }],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							agentDir,
						},
						title: "New projection",
						updatedAt: 200,
					},
					{
						recoveryData: {
							sessionId: { value: "session-duplicate" },
							model: stubModel,
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "old projection",
								firstPrompt: "old projection",
								messageCount: 1,
								fileSizeBytes: 64,
								recentMessages: [{ role: "user", text: "old projection" }],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							agentDir,
						},
						title: "Old projection",
						updatedAt: 100,
					},
					{
						recoveryData: {
							sessionId: { value: "session-other" },
							model: stubModel,
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "other projection",
								firstPrompt: "other projection",
								messageCount: 1,
								fileSizeBytes: 64,
								recentMessages: [{ role: "user", text: "other projection" }],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							agentDir,
						},
						title: "Other projection",
						updatedAt: 50,
					},
				],
				null,
				2,
			)}\n`,
			"utf8",
		);

		const recent = await runtime.listRecentSessions();

		expect(recent).toHaveLength(2);
		expect(recent[0]?.recoveryData.sessionId.value).toBe("session-duplicate");
		expect(recent[0]?.title).toBe("New projection");
		expect(recent[1]?.recoveryData.sessionId.value).toBe("session-other");
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

	it("rewrites recent and last projections from entry facts while pruning", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-prune-fact-source-"));
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
		await mkdir(join(sessionsDir, "entries"), { recursive: true });
		await writeFile(
			join(sessionsDir, "recent.json"),
			`${JSON.stringify(
				[
					{
						recoveryData: {
							sessionId: { value: "projection-session" },
							model: stubModel,
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "projection summary",
								firstPrompt: "projection prompt",
								messageCount: 1,
								fileSizeBytes: 64,
								recentMessages: [{ role: "user", text: "projection prompt" }],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							agentDir,
						},
						title: "Projection Title",
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
			`${JSON.stringify({
				sessionId: { value: "projection-session" },
				model: stubModel,
				toolSet: ["read"],
				planSummary: null,
				compactionSummary: null,
				metadata: {
					summary: "projection summary",
					firstPrompt: "projection prompt",
					messageCount: 1,
					fileSizeBytes: 64,
					recentMessages: [{ role: "user", text: "projection prompt" }],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
			})}\n`,
			"utf8",
		);
		await writeFile(
			join(sessionsDir, "entries", "projection-session.json"),
			`${JSON.stringify({
				sessionId: { value: "projection-session" },
				model: stubModel,
				toolSet: ["read"],
				planSummary: null,
				compactionSummary: null,
				metadata: {
					summary: "entry summary",
					firstPrompt: "entry prompt",
					messageCount: 2,
					fileSizeBytes: 96,
					recentMessages: [
						{ role: "user", text: "entry prompt" },
						{ role: "assistant", text: "entry answer" },
					],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
			})}\n`,
			"utf8",
		);

		const prune = await runtime.pruneRecentSessions(10);
		const rewritten = JSON.parse(await readFile(join(sessionsDir, "recent.json"), "utf8")) as Array<{
			recoveryData: { metadata?: { summary?: string; firstPrompt?: string } };
		}>;
		const rewrittenLast = JSON.parse(await readFile(join(sessionsDir, "last.json"), "utf8")) as {
			metadata?: { summary?: string; firstPrompt?: string };
		};

		expect(prune).toEqual({ before: 1, after: 1, removed: 0 });
		expect(rewritten[0]?.recoveryData.metadata).toMatchObject({
			summary: "entry summary",
			firstPrompt: "entry prompt",
		});
		expect(rewrittenLast.metadata).toMatchObject({
			summary: "entry summary",
			firstPrompt: "entry prompt",
		});
	});

	it("uses the configured recent-session max entries by default", async () => {
		process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES = "3";
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-configured-prune-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			adapter: new StubKernelSessionAdapter(),
		});
		await mkdir(historyDir, { recursive: true });
		await writeFile(
			join(historyDir, "recent.json"),
			`${JSON.stringify(
				Array.from({ length: 5 }, (_, index) => ({
					recoveryData: {
						sessionId: { value: `session-${index}` },
						model: stubModel,
						toolSet: [],
						planSummary: null,
						compactionSummary: null,
						metadata: null,
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
					updatedAt: 1000 - index,
				})),
				null,
				2,
			)}\n`,
			"utf8",
		);

		const prune = await runtime.pruneRecentSessions();
		const recent = await runtime.listRecentSessions();

		expect(prune).toEqual({ before: 5, after: 3, removed: 2 });
		expect(recent).toHaveLength(3);
		expect(recent.map((entry) => entry.recoveryData.sessionId.value)).toEqual([
			"session-0",
			"session-1",
			"session-2",
		]);
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

	it("creates a host-scoped session engine that drives prompt, continue, and session switching", async () => {
		const adapters: StubKernelSessionAdapter[] = [];
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "interactive",
			model: stubModel,
			createAdapter: () => {
				const adapter = new StubKernelSessionAdapter();
				adapters.push(adapter);
				return adapter;
			},
		});
		const engine = runtime.createSessionEngine();

		const first = engine.createSession();
		await engine.submit("first turn");
		expect(adapters[0]?.lastInput).toBe("first turn");
		expect(engine.activeSession?.id.value).toBe(first.id.value);

		await engine.submit("carry on", { mode: "continue" });
		expect(adapters[0]?.lastInput).toBe("carry on");

		const recovered = await engine.recoverSession(
			{
				sessionId: { value: "engine-recovered" },
				model: stubModel,
				toolSet: ["read", "edit"],
				planSummary: null,
				compactionSummary: null,
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
			},
			{ closeActive: true },
		);
		expect(first.state.status).toBe("closed");
		expect(engine.activeSession?.id.value).toBe(recovered.id.value);
		expect(engine.listSessions().map((session) => session.id.value)).toEqual(["engine-recovered"]);
	});

	it("records closed sessions through session engine using the shared runtime authority path", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-engine-close-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/engine-close",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const engine = runtime.createSessionEngine({
			titleResolver: () => "Engine Session",
		});
		const session = engine.createSession();

		await runtime.recordRecentSessionInput(session, "session engine close path");
		await engine.closeSession();

		const recent = await runtime.listRecentSessions();
		expect(recent[0]?.title).toBeTruthy();
		expect(recent[0]?.recoveryData.sessionId.value).toBe(session.id.value);
		expect(recent[0]?.recoveryData.metadata?.firstPrompt).toBe("session engine close path");
	});

	it("prefers session-engine owned titles over cli-local fallback when closing sessions", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-engine-title-"));
		const historyDir = join(agentDir, "history");
		const runtime = createAppRuntime({
			workingDirectory: "/tmp/engine-title",
			agentDir,
			historyDir,
			mode: "interactive",
			model: stubModel,
			createAdapter: () => new StubKernelSessionAdapter(),
		});
		const engine = runtime.createSessionEngine({
			titleResolver: () => "Fallback Title",
		});
		const session = engine.createSession();
		engine.setSessionTitle("Engine Owned Title");

		await runtime.recordRecentSessionInput(session, "session title owned by engine");
		await engine.closeSession();

		const recent = await runtime.listRecentSessions();
		expect(recent[0]?.title).toBe("Engine Owned Title");
		expect(recent[0]?.recoveryData.metadata?.firstPrompt).toBe("session title owned by engine");
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
