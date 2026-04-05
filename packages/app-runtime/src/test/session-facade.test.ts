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

		adapter.enqueueDefaultEvents([{ type: "message_update", timestamp: 1000, payload: { content: "Hello" } }]);

		await facade.prompt("test");

		expect(sessionEvents).toHaveLength(1);
		if (sessionEvents[0]!.type === "text_delta") {
			expect(sessionEvents[0]!.content).toBe("Hello");
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
			getRecoveryData() {
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
			getRecoveryData() {
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
			getRecoveryData() {
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
