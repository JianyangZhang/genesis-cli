import { describe, expect, it } from "vitest";
import type { KernelSessionAdapter, RawUpstreamEvent } from "../adapters/kernel-session-adapter.js";
import { createAppRuntime } from "../create-app-runtime.js";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import { createToolGovernor } from "../governance/tool-governor.js";
import { createPlanEngine } from "../planning/plan-engine.js";
import { createRuntimeContext } from "../runtime-context.js";
import { SessionFacadeImpl } from "../session/session-facade.js";
import { createInitialSessionState } from "../session/session-state.js";
import type { ModelDescriptor, SessionId, SessionState } from "../types/index.js";
import { expectGovernorProbeAllows } from "./governor-test-helpers.js";
import { StubKernelSessionAdapter } from "./stubs/stub-kernel-session-adapter.js";

const stubId: SessionId = { value: "facade-test" };
const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

describe("SessionFacade", () => {
	function createFacade() {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus);
		return { facade, adapter, globalBus };
	}

	it("transitions to active on construction", () => {
		const { facade } = createFacade();
		expect(facade.state.status).toBe("active");
	});

	it("exposes session id", () => {
		const { facade } = createFacade();
		expect(facade.id).toEqual(stubId);
	});

	it("exposes runtime context", () => {
		const { facade } = createFacade();
		expect(facade.context.mode).toBe("print");
		expect(facade.context.workingDirectory).toBe("/tmp");
	});

	it("processes prompt and emits normalized events", async () => {
		const { facade, adapter, globalBus } = createFacade();
		const globalEvents: RuntimeEvent[] = [];
		globalBus.onCategory("tool", (event) => globalEvents.push(event));

		adapter.enqueueDefaultEvents([
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: { toolName: "read", toolCallId: "c1", parameters: {} },
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "read", toolCallId: "c1", status: "success", durationMs: 100 },
			},
		]);

		await facade.prompt("Read the file");

		expect(globalEvents).toHaveLength(2);
		expect(globalEvents[0]!.type).toBe("tool_started");
		expect(globalEvents[1]!.type).toBe("tool_completed");
	});

	it("records tool completion exactly once in fallback governance mode", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "read", category: "file-read" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L0",
				readOnly: true,
				concurrency: "unlimited",
				confirmation: "never",
				subAgentAllowed: true,
				timeoutMs: 30_000,
			},
			executorTag: "read",
		});

		const adapterWithoutHook: KernelSessionAdapter = {
			async *sendPrompt() {
				yield {
					type: "tool_execution_start",
					timestamp: 1000,
					payload: { toolName: "read", toolCallId: "read_1", parameters: { path: "/tmp/a.txt" } },
				};
				yield {
					type: "tool_execution_end",
					timestamp: 1100,
					payload: { toolName: "read", toolCallId: "read_1", status: "success", durationMs: 100 },
				};
			},
			async *sendContinue() {},
			abort() {},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: stubId,
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(adapterWithoutHook, state, context, globalBus, governor);
		await facade.prompt("read file");

		expect(governor.audit.size).toBe(1);
	});

	it("updates task state during prompt", async () => {
		const { facade, adapter } = createFacade();

		adapter.enqueueDefaultEvents([{ type: "message_update", timestamp: 1000, payload: { content: "hi" } }]);

		const stateHistory: string[] = [];
		facade.onStateChange((s) => stateHistory.push(s.taskState.status));

		await facade.prompt("test");

		// Should have transitioned: idle → running → idle
		expect(stateHistory).toContain("running");
		expect(stateHistory.at(-1)).toBe("idle");
	});

	it("session events bus receives events", async () => {
		const { facade, adapter } = createFacade();
		const sessionEvents: RuntimeEvent[] = [];
		facade.events.on("text_delta", (e) => sessionEvents.push(e));
		facade.events.on("usage_updated", (e) => sessionEvents.push(e));

		adapter.enqueueDefaultEvents([
			{ type: "message_update", timestamp: 1000, payload: { content: "Hello" } },
			{
				type: "usage_update",
				timestamp: 1001,
				payload: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144, isFinal: true },
			},
		]);

		await facade.prompt("test");

		expect(sessionEvents).toHaveLength(2);
		if (sessionEvents[0]!.type === "text_delta") {
			expect(sessionEvents[0]!.content).toBe("Hello");
		}
		if (sessionEvents[1]!.type === "usage_updated") {
			expect(sessionEvents[1]!.usage.totalTokens).toBe(144);
		}
	});

	it("emits compaction events when compact() is invoked", async () => {
		const adapter = new StubKernelSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "interactive",
			model: { id: "stub-model", provider: "stub" },
			toolSet: ["read", "edit"],
			adapter,
		});
		const session = runtime.createSession();
		const seen: string[] = [];
		session.events.onAny((event) => {
			seen.push(event.type);
		});

		await session.compact();

		expect(seen).toContain("compaction_started");
		expect(seen).toContain("compaction_completed");
		await session.close();
		await runtime.shutdown();
	});

	it("close emits session_closed event", async () => {
		const { facade, globalBus } = createFacade();
		let closed = false;
		globalBus.on("session_closed", () => {
			closed = true;
		});

		await facade.close();

		expect(closed).toBe(true);
		expect(facade.state.status).toBe("closed");
	});

	it("close calls adapter close", async () => {
		const { facade, adapter } = createFacade();
		await facade.close();
		expect(adapter.closed).toBe(true);
	});

	it("captures recovery data before closing the adapter", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		const order: string[] = [];

		const adapter: KernelSessionAdapter = {
			async *sendPrompt() {},
			async *sendContinue() {},
			abort() {},
			async close() {
				order.push("close");
			},
			async getRecoveryData() {
				order.push("getRecoveryData");
				return {
					sessionId: stubId,
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					metadata: {
						summary: "resume architecture cleanup",
						firstPrompt: "resume architecture cleanup",
						messageCount: 1,
						fileSizeBytes: 64,
						recentMessages: [{ role: "user", text: "resume architecture cleanup" }],
					},
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus);
		await facade.close();

		expect(order).toEqual(["getRecoveryData", "close"]);
	});

	it("snapshotRecoveryData canonicalizes session-facing recovery fields from facade context", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp/project",
			agentDir: "/tmp/agent",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		const adapter: KernelSessionAdapter = {
			async *sendPrompt() {},
			async *sendContinue() {},
			abort() {},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: { value: "adapter-id" },
					model: { id: "", provider: "" },
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
					sessionFile: "/tmp/agent/session.jsonl",
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus);
		const recoveryData = await facade.snapshotRecoveryData();

		expect(recoveryData).toMatchObject({
			sessionId: stubId,
			model: stubModel,
			toolSet: ["read"],
			workingDirectory: "/tmp/project",
			agentDir: "/tmp/agent",
			sessionFile: "/tmp/agent/session.jsonl",
		});
	});

	it("close emits canonicalized recovery data on session_closed", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp/project",
			agentDir: "/tmp/agent",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		let seenRecoveryData: SessionRecoveryData | null = null;
		const adapter: KernelSessionAdapter = {
			async *sendPrompt() {},
			async *sendContinue() {},
			abort() {},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: { value: "adapter-id" },
					model: { id: "", provider: "" },
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		globalBus.on("session_closed", (event) => {
			seenRecoveryData = event.recoveryData;
		});

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus);
		await facade.close();

		expect(seenRecoveryData).toMatchObject({
			sessionId: stubId,
			model: stubModel,
			toolSet: ["read"],
			workingDirectory: "/tmp/project",
			agentDir: "/tmp/agent",
		});
	});

	it("snapshotRecoveryData prefers in-memory plan/compaction summaries when adapter payload is missing them", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, undefined, createPlanEngine());

		facade.plan!.createAndActivate("p1", "收口会话契约", ["补齐摘要事实源"]);
		adapter.enqueueDefaultEvents([
			{
				type: "compaction_end",
				timestamp: 1000,
				payload: {
					compactedSummary: "会话摘要已更新",
					recentUserPrompts: ["继续补齐 P0-1"],
					recentAssistantResponses: ["我会先统一 recovery 契约。"],
				},
			},
		]);
		await facade.prompt("trigger compaction state sync");

		const recoveryData = await facade.snapshotRecoveryData();
		expect(recoveryData.planSummary).not.toBeNull();
		expect(recoveryData.planSummary?.planId).toBe("p1");
		expect(recoveryData.compactionSummary).not.toBeNull();
		expect(recoveryData.compactionSummary?.compactedSummary).toBe("会话摘要已更新");
	});

	it("prompt throws after close", async () => {
		const { facade } = createFacade();
		await facade.close();
		await expect(facade.prompt("test")).rejects.toThrow("Session is closed");
	});

	it("abort calls adapter abort for an active stream", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});

		let releaseStream!: () => void;
		const streamBlocked = new Promise<void>((r) => {
			releaseStream = r;
		});
		let abortCalled = false;

		const slowAdapter: KernelSessionAdapter = {
			async *sendPrompt(_input: string) {
				await streamBlocked;
				if (!abortCalled) {
					yield {
						type: "message_update",
						timestamp: 1000,
						payload: { content: "after abort" },
					} as RawUpstreamEvent;
				}
			},
			async *sendContinue(_input: string): AsyncIterable<RawUpstreamEvent> {
				await streamBlocked;
				if (!abortCalled) {
					yield {
						type: "message_update",
						timestamp: 1000,
						payload: { content: "" },
					} as RawUpstreamEvent;
				}
			},
			abort() {
				abortCalled = true;
			},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: stubId,
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(slowAdapter, state, context, globalBus);
		const prompt = facade.prompt("test");
		await new Promise((r) => setTimeout(r, 0));

		facade.abort();
		expect(abortCalled).toBe(true);

		releaseStream();
		await prompt;
	});

	it("onStateChange notifies listeners", async () => {
		const { facade, adapter } = createFacade();

		adapter.enqueueDefaultEvents([]);

		const states: string[] = [];
		facade.onStateChange((s) => states.push(s.taskState.status));

		await facade.prompt("test");

		expect(states.length).toBeGreaterThanOrEqual(2);
		expect(states).toContain("running");
	});

	// --- Fix 3: RuntimeContext.taskState sync ---

	it("updates context.taskState during prompt", async () => {
		const { facade, adapter } = createFacade();
		adapter.enqueueDefaultEvents([{ type: "message_update", timestamp: 1000, payload: { content: "hi" } }]);

		const contextStates: string[] = [];
		facade.onStateChange(() => contextStates.push(facade.context.taskState.status));

		await facade.prompt("test");

		expect(contextStates).toContain("running");
		expect(contextStates.at(-1)).toBe("idle");
	});

	// --- Fix 2: Concurrency guard ---

	it("rejects concurrent prompt calls", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});

		let releaseStream!: () => void;
		const streamBlocked = new Promise<void>((r) => {
			releaseStream = r;
		});

		const slowAdapter: KernelSessionAdapter = {
			async *sendPrompt(_input: string) {
				await streamBlocked;
				yield { type: "message_update", timestamp: 1000, payload: { content: "hi" } } as RawUpstreamEvent;
			},
			async *sendContinue(_input: string): AsyncIterable<RawUpstreamEvent> {
				await streamBlocked;
				yield { type: "message_update", timestamp: 1000, payload: { content: "" } } as RawUpstreamEvent;
			},
			abort() {},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: stubId,
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(slowAdapter, state, context, globalBus);

		const first = facade.prompt("first");

		// Give the event loop a tick so the first prompt enters the for-await
		await new Promise((r) => setTimeout(r, 0));

		await expect(facade.prompt("second")).rejects.toThrow("already running");

		releaseStream();
		await first;
	});

	it("keeps the running lock until an aborted stream settles", async () => {
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});

		let releaseStream!: () => void;
		const streamBlocked = new Promise<void>((r) => {
			releaseStream = r;
		});
		let aborted = false;

		const slowAdapter: KernelSessionAdapter = {
			async *sendPrompt(_input: string) {
				await streamBlocked;
				if (!aborted) {
					yield { type: "message_update", timestamp: 1000, payload: { content: "hi" } } as RawUpstreamEvent;
				}
			},
			async *sendContinue(_input: string): AsyncIterable<RawUpstreamEvent> {
				await streamBlocked;
				if (!aborted) {
					yield { type: "message_update", timestamp: 1000, payload: { content: "" } } as RawUpstreamEvent;
				}
			},
			abort() {
				aborted = true;
			},
			async close() {},
			async getRecoveryData() {
				return {
					sessionId: stubId,
					model: stubModel,
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				};
			},
			resume() {},
		};

		const facade = new SessionFacadeImpl(slowAdapter, state, context, globalBus);
		const first = facade.prompt("first");
		await new Promise((r) => setTimeout(r, 0));

		facade.abort();
		await expect(facade.prompt("second")).rejects.toThrow("already running");

		releaseStream();
		await first;
	});

	it("allows sequential prompt calls", async () => {
		const { facade, adapter } = createFacade();
		adapter.enqueueDefaultEvents([]);
		await facade.prompt("first");
		await facade.prompt("second");
		// No error thrown
	});

	it("gates tool execution before emitting tool_started when adapter supports governance hooks", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["bash"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["bash"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "bash", category: "command-execution" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "unlimited",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "bash",
		});

		adapter.enqueueDefaultEvents([
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_1",
					parameters: { command: "echo hello" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "bash", toolCallId: "bash_1", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const prompt = facade.prompt("run bash");
		await new Promise((r) => setTimeout(r, 0));
		expect(received).toHaveLength(1);
		expect(received[0]!.type).toBe("permission_requested");
		expect(governor.audit.size).toBe(0);
		await facade.resolvePermission("bash_1", "deny");
		await prompt;
	});

	it("resumes a gated tool after permission approval", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["bash"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["bash"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "bash", category: "command-execution" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "unlimited",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "bash",
		});
		adapter.enqueueDefaultEvents([
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_1",
					parameters: { command: "echo hello" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "bash", toolCallId: "bash_1", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const prompt = facade.prompt("run bash");
		await new Promise((r) => setTimeout(r, 0));
		expect(received.map((event) => event.type)).toEqual(["permission_requested"]);

		await facade.resolvePermission("bash_1", "allow_once");
		await prompt;

		expect(received.map((event) => event.type)).toEqual([
			"permission_requested",
			"permission_resolved",
			"tool_started",
			"tool_completed",
		]);
		expect(governor.audit.size).toBe(1);
	});

	it("emits tool_denied when a gated tool is rejected by the user", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["bash"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["bash"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "bash", category: "command-execution" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "unlimited",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "bash",
		});
		adapter.enqueueDefaultEvents([
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_2",
					parameters: { command: "echo hello" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "bash", toolCallId: "bash_2", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const prompt = facade.prompt("run bash");
		await new Promise((r) => setTimeout(r, 0));
		await facade.resolvePermission("bash_2", "deny");
		await prompt;

		expect(received.map((event) => event.type)).toEqual([
			"permission_requested",
			"permission_resolved",
			"tool_denied",
		]);
	});

	it("auto-allows the same read-only bash command within the session", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["bash"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["bash"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "bash", category: "command-execution" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "unlimited",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "bash",
		});
		adapter.enqueueEventsForPrompt("run bash once", [
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_pwd_1",
					parameters: { command: "pwd" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "bash", toolCallId: "bash_pwd_1", status: "success", durationMs: 20 },
			},
		]);
		adapter.enqueueEventsForPrompt("run bash twice", [
			{
				type: "tool_execution_start",
				timestamp: 3000,
				payload: {
					toolName: "bash",
					toolCallId: "bash_pwd_2",
					parameters: { command: "pwd" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 4000,
				payload: { toolName: "bash", toolCallId: "bash_pwd_2", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		await facade.prompt("run bash once");

		const eventsAfterFirstPrompt = received.length;
		await facade.prompt("run bash twice");

		expect(received.slice(eventsAfterFirstPrompt).map((event) => event.type)).toEqual([
			"tool_started",
			"tool_completed",
		]);
		expect(received.map((event) => event.type)).not.toContain("permission_requested");
	});

	it("reuses allow_for_session approval for write on the same file within the session", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["write"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["write"]),
		});
		const governor = createToolGovernor();
		const recordedApprovals: Parameters<typeof governor.recordSessionApproval>[0][] = [];
		const originalRecordSessionApproval = governor.recordSessionApproval.bind(governor);
		governor.recordSessionApproval = (entry) => {
			recordedApprovals.push(entry);
			originalRecordSessionApproval(entry);
		};
		governor.catalog.register({
			identity: { name: "write", category: "file-mutation" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "per_target",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "write",
		});
		adapter.enqueueEventsForPrompt("write once", [
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "write",
					toolCallId: "write_1",
					parameters: { file_path: "/tmp/.tmp-tests/one.txt", content: "hello" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "write", toolCallId: "write_1", status: "success", durationMs: 20 },
			},
		]);
		adapter.enqueueEventsForPrompt("write twice", [
			{
				type: "tool_execution_start",
				timestamp: 3000,
				payload: {
					toolName: "write",
					toolCallId: "write_2",
					parameters: { file_path: "/tmp/.tmp-tests/one.txt", content: "world" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 4000,
				payload: { toolName: "write", toolCallId: "write_2", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const firstPrompt = facade.prompt("write once");
		await new Promise((r) => setTimeout(r, 0));
		await facade.resolvePermission("write_1", "allow_for_session");
		await firstPrompt;

		expect(recordedApprovals[0]).toMatchObject({
			toolName: "write",
			riskLevel: "L3",
			targetPattern: "/tmp/**",
		});
		const writeProbe = expectGovernorProbeAllows(governor, {
			sessionId: stubId.value,
			toolName: "write",
			toolCallId: "write_probe",
			workingDirectory: "/tmp",
			sessionMode: "print",
			isSubAgent: false,
			targetPath: "/tmp/.tmp-tests/one.txt",
			parameters: { file_path: "/tmp/.tmp-tests/one.txt", content: "world" },
		});
		writeProbe.complete({
			targetPath: "/tmp/.tmp-tests/one.txt",
			durationMs: 0,
		});

		const eventsAfterFirstPrompt = received.length;
		await facade.prompt("write twice");

		expect(received.slice(eventsAfterFirstPrompt).map((event) => event.type)).toEqual([
			"tool_started",
			"tool_completed",
		]);
	});

	it("reuses allow_for_session approval for edit on the same file within the session", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["edit"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["edit"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "edit", category: "file-mutation" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "per_target",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "edit",
		});
		adapter.enqueueEventsForPrompt("edit once", [
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "edit",
					toolCallId: "edit_1",
					parameters: {
						file_path: "/tmp/.tmp-tests/two.txt",
						old_string: "before",
						new_string: "after",
					},
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "edit", toolCallId: "edit_1", status: "success", durationMs: 20 },
			},
		]);
		adapter.enqueueEventsForPrompt("edit twice", [
			{
				type: "tool_execution_start",
				timestamp: 3000,
				payload: {
					toolName: "edit",
					toolCallId: "edit_2",
					parameters: {
						file_path: "/tmp/.tmp-tests/two.txt",
						old_string: "after",
						new_string: "final",
					},
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 4000,
				payload: { toolName: "edit", toolCallId: "edit_2", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const firstPrompt = facade.prompt("edit once");
		await new Promise((r) => setTimeout(r, 0));
		await facade.resolvePermission("edit_1", "allow_for_session");
		await firstPrompt;

		const editProbe = expectGovernorProbeAllows(governor, {
			sessionId: stubId.value,
			toolName: "edit",
			toolCallId: "edit_probe",
			workingDirectory: "/tmp",
			sessionMode: "print",
			isSubAgent: false,
			targetPath: "/tmp/.tmp-tests/two.txt",
			parameters: {
				file_path: "/tmp/.tmp-tests/two.txt",
				old_string: "after",
				new_string: "final",
			},
		});
		editProbe.complete({
			targetPath: "/tmp/.tmp-tests/two.txt",
			durationMs: 0,
		});

		const eventsAfterFirstPrompt = received.length;
		await facade.prompt("edit twice");

		expect(received.slice(eventsAfterFirstPrompt).map((event) => event.type)).toEqual([
			"tool_started",
			"tool_completed",
		]);
	});

	it("reuses allow_for_session approval for another file under the same working directory", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["write"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["write"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "write", category: "file-mutation" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "per_target",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "write",
		});
		adapter.enqueueEventsForPrompt("write first file", [
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "write",
					toolCallId: "write_a",
					parameters: { file_path: "/tmp/.tmp-tests/a.txt", content: "hello" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "write", toolCallId: "write_a", status: "success", durationMs: 20 },
			},
		]);
		adapter.enqueueEventsForPrompt("write second file", [
			{
				type: "tool_execution_start",
				timestamp: 3000,
				payload: {
					toolName: "write",
					toolCallId: "write_b",
					parameters: { file_path: "/tmp/.tmp-tests/b.txt", content: "world" },
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 4000,
				payload: { toolName: "write", toolCallId: "write_b", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const firstPrompt = facade.prompt("write first file");
		await new Promise((r) => setTimeout(r, 0));
		await facade.resolvePermission("write_a", "allow_for_session");
		await firstPrompt;

		const writeSecondProbe = expectGovernorProbeAllows(governor, {
			sessionId: stubId.value,
			toolName: "write",
			toolCallId: "write_probe_b",
			workingDirectory: "/tmp",
			sessionMode: "print",
			isSubAgent: false,
			targetPath: "/tmp/.tmp-tests/b.txt",
			parameters: { file_path: "/tmp/.tmp-tests/b.txt", content: "world" },
		});
		writeSecondProbe.complete({
			targetPath: "/tmp/.tmp-tests/b.txt",
			durationMs: 0,
		});

		const eventsAfterFirstPrompt = received.length;
		await facade.prompt("write second file");
		expect(received.slice(eventsAfterFirstPrompt).map((event) => event.type)).toEqual([
			"tool_started",
			"tool_completed",
		]);
	});

	it("asks again when the same tool targets a different directory outside the session scope", async () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["edit"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp/project",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["edit"]),
		});
		const governor = createToolGovernor();
		governor.catalog.register({
			identity: { name: "edit", category: "file-mutation" },
			contract: {
				parameterSchema: { type: "object", properties: {} },
				output: { type: "text" },
				errorTypes: [],
			},
			policy: {
				riskLevel: "L3",
				readOnly: false,
				concurrency: "per_target",
				confirmation: "always",
				subAgentAllowed: true,
				timeoutMs: 60_000,
			},
			executorTag: "edit",
		});
		adapter.enqueueEventsForPrompt("edit external one", [
			{
				type: "tool_execution_start",
				timestamp: 1000,
				payload: {
					toolName: "edit",
					toolCallId: "edit_external_1",
					parameters: {
						file_path: "/opt/tmp-tests/a.txt",
						old_string: "before",
						new_string: "after",
					},
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 2000,
				payload: { toolName: "edit", toolCallId: "edit_external_1", status: "success", durationMs: 20 },
			},
		]);
		adapter.enqueueEventsForPrompt("edit external two", [
			{
				type: "tool_execution_start",
				timestamp: 3000,
				payload: {
					toolName: "edit",
					toolCallId: "edit_external_2",
					parameters: {
						file_path: "/var/tmp-tests/b.txt",
						old_string: "before",
						new_string: "after",
					},
				},
			},
			{
				type: "tool_execution_end",
				timestamp: 4000,
				payload: { toolName: "edit", toolCallId: "edit_external_2", status: "success", durationMs: 20 },
			},
		]);

		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);
		const received: RuntimeEvent[] = [];
		globalBus.onCategory("permission", (event) => received.push(event));
		globalBus.onCategory("tool", (event) => received.push(event));

		const firstPrompt = facade.prompt("edit external one");
		await new Promise((r) => setTimeout(r, 0));
		await facade.resolvePermission("edit_external_1", "allow_for_session");
		await firstPrompt;

		const eventsAfterFirstPrompt = received.length;
		const secondPrompt = facade.prompt("edit external two");
		await new Promise((r) => setTimeout(r, 0));
		expect(received.slice(eventsAfterFirstPrompt).map((event) => event.type)).toEqual(["permission_requested"]);
		await facade.resolvePermission("edit_external_2", "deny");
		await secondPrompt;
	});
});

// ---------------------------------------------------------------------------
// Plan integration tests
// ---------------------------------------------------------------------------

describe("SessionFacade — plan integration", () => {
	function createFacadeWithPlan() {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});

		const planEngine = createPlanEngine();
		const facade = new SessionFacadeImpl(adapter, state, context, globalBus, undefined, planEngine);
		return { facade, adapter, globalBus, planEngine };
	}

	it("exposes plan orchestrator when planEngine is provided", () => {
		const { facade } = createFacadeWithPlan();
		expect(facade.plan).not.toBeNull();
		expect(facade.plan!.engine).toBeDefined();
	});

	it("plan is null when no planEngine is provided", () => {
		const adapter = new StubKernelSessionAdapter();
		const globalBus = createEventBus();
		const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));
		const context = createRuntimeContext({
			sessionId: stubId,
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			toolSet: new Set(["read"]),
		});
		const facade = new SessionFacadeImpl(adapter, state, context, globalBus);
		expect(facade.plan).toBeNull();
	});

	it("switches the active model and notifies state listeners", async () => {
		const { facade, adapter } = createFacadeWithPlan();
		const seenModels: string[] = [];
		facade.onStateChange((state) => seenModels.push(state.model.id));

		await facade.switchModel({ id: "glm-5.2", provider: "zai", displayName: "GLM 5.2" });

		expect(facade.state.model.id).toBe("glm-5.2");
		expect(facade.context.model.id).toBe("glm-5.2");
		expect(adapter.lastModel.id).toBe("glm-5.2");
		expect(seenModels).toContain("glm-5.2");
	});

	it("plan events update sessionState.planSummary", () => {
		const { facade } = createFacadeWithPlan();
		expect(facade.state.planSummary).toBeNull();

		facade.plan!.createAndActivate("p1", "Test goal", ["Step A"]);

		// After plan creation, planSummary should be updated via event listener
		expect(facade.state.planSummary).not.toBeNull();
		expect(facade.state.planSummary!.planId).toBe("p1");
		expect(facade.state.planSummary!.stepCount).toBe(1);
	});

	it("plan state changes trigger onStateChange", () => {
		const { facade } = createFacadeWithPlan();
		const states: SessionState[] = [];
		facade.onStateChange((s) => states.push(s));

		facade.plan!.createAndActivate("p1", "Goal", ["Step A"]);

		expect(states.length).toBeGreaterThan(0);
		const last = states[states.length - 1]!;
		expect(last.planSummary).not.toBeNull();
	});

	it("plan boundary violation prevents step completion", () => {
		const { facade } = createFacadeWithPlan();
		facade.plan!.createAndActivate("p1", "Goal", ["Step A"]);
		facade.plan!.assignTask(0, {
			taskId: "task-1",
			goal: "Do something",
			scope: { allowedPaths: ["packages/app-runtime/**"], forbiddenPaths: [] },
			inputs: { docs: [], files: [], assumptions: [] },
			deliverables: ["code"],
			verification: [{ name: "build", type: "command", command: "npm run build", description: "Build" }],
			stopConditions: [{ type: "max_file_count", value: 100, description: "Safety limit" }],
		});

		const result = {
			taskId: "task-1",
			status: "completed" as const,
			modifiedPaths: ["packages/OUTSIDE/src/hack.ts"],
			verifications: [],
			risks: [],
			handoffNotes: [],
			completedAt: Date.now(),
		};
		const plan = facade.plan!.submitResult(0, result);

		// Step should be failed, not completed
		expect(plan.steps[0].status).toBe("failed");
	});
});
