import { describe, expect, it } from "vitest";
import type { PiSessionAdapter, RawUpstreamEvent } from "../adapters/pi-session-adapter.js";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import { createRuntimeContext } from "../runtime-context.js";
import { SessionFacadeImpl } from "../session/session-facade.js";
import { createInitialSessionState } from "../session/session-state.js";
import type { ModelDescriptor, SessionId } from "../types/index.js";
import { StubPiSessionAdapter } from "./stubs/stub-pi-session-adapter.js";

const stubId: SessionId = { value: "facade-test" };
const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

describe("SessionFacade", () => {
	function createFacade() {
		const adapter = new StubPiSessionAdapter();
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

		const slowAdapter: PiSessionAdapter = {
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

		const slowAdapter: PiSessionAdapter = {
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

		const slowAdapter: PiSessionAdapter = {
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
});
