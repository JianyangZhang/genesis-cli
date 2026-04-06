import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppRuntime } from "../create-app-runtime.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ModelDescriptor } from "../types/index.js";
import { StubKernelSessionAdapter } from "./stubs/stub-kernel-session-adapter.js";

const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

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
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
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
		const last = JSON.parse(await readFile(join(agentDir, "sessions", "last.json"), "utf8")) as {
			sessionId: { value: string };
		};

		expect(recent).toHaveLength(1);
		expect(recent[0]?.title).toBe("recent");
		expect(recent[0]?.recoveryData.sessionId.value).toBe("recent-session");
		expect(last.sessionId.value).toBe("recent-session");
	});

	it("searches recent sessions by relevance and persists a fallback title", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-runtime-search-"));
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			agentDir,
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
		expect(results[0]?.recoveryData.sessionId.value).toBe("session-b");
		expect(results[0]?.title).toBe("README 发布说明补充");
		expect(results[1]?.recoveryData.sessionId.value).toBe("session-a");
	});

	it("createAdapter provisions a fresh adapter per session", async () => {
		const adapters: StubKernelSessionAdapter[] = [];
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			createAdapter: () => {
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
			createAdapter: () => {
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
