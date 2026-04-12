import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { createSessionEngine } from "../session/session-engine.js";
import type { SessionFacade } from "../session/session-facade.js";

function createFakeSession(id: string, runtimeEvents = createEventBus()): SessionFacade {
	const sessionEvents = createEventBus();
	const stateListeners = new Set<(state: SessionFacade["state"]) => void>();
	const state = {
		id: { value: id },
		status: "active",
		model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
	} as SessionFacade["state"];
	const session = {
		id: { value: id },
		state,
		context: {
			sessionId: { value: id },
			workingDirectory: `/tmp/${id}`,
			mode: "interactive",
			model: state.model,
			toolSet: new Set(),
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		} as SessionFacade["context"],
		events: sessionEvents,
		plan: null,
		prompt: vi.fn(async () => {}),
		continue: vi.fn(async () => {}),
		abort: vi.fn(),
		close: vi.fn(async () => {
			runtimeEvents.emit({
				id: `closed-${id}`,
				timestamp: Date.now(),
				sessionId: { value: id },
				category: "session",
				type: "session_closed",
				recoveryData: {
					sessionId: { value: id },
					model: state.model,
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
			} as never);
		}),
		snapshotRecoveryData: vi.fn(async () => ({}) as never),
		resolvePermission: vi.fn(async () => {}),
		switchModel: vi.fn(async () => {}),
		onStateChange: (listener) => {
			stateListeners.add(listener);
			return () => {
				stateListeners.delete(listener);
			};
		},
		compact: vi.fn(async () => {}),
	} satisfies SessionFacade;
	return session;
}

describe("session engine", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not leak unhandled rejections when recent-session input persistence fails", async () => {
		const runtimeEvents = createEventBus();
		const session = createFakeSession("input-failure", runtimeEvents);
		const onUnhandled = vi.fn();
		process.once("unhandledRejection", onUnhandled);
		const engine = createSessionEngine({
			runtimeEvents,
			createSession: () => session,
			recoverSession: () => session,
			recordClosedRecentSession: async () => {},
			recordRecentSessionInput: async () => Promise.reject(new Error("history write failed")),
			recordRecentSessionAssistantText: async () => {},
			scheduleRecentSessionEvent: () => {},
		});

		engine.createSession();
		await engine.submit("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onUnhandled).not.toHaveBeenCalled();
	});

	it("does not leak unhandled rejections when recent-session assistant persistence fails", async () => {
		const runtimeEvents = createEventBus();
		const session = createFakeSession("assistant-failure", runtimeEvents);
		const onUnhandled = vi.fn();
		process.once("unhandledRejection", onUnhandled);
		const engine = createSessionEngine({
			runtimeEvents,
			createSession: () => session,
			recoverSession: () => session,
			recordClosedRecentSession: async () => {},
			recordRecentSessionInput: async () => {},
			recordRecentSessionAssistantText: async () => Promise.reject(new Error("assistant write failed")),
			scheduleRecentSessionEvent: () => {},
		});

		engine.createSession();
		engine.recordAssistantText("assistant output");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onUnhandled).not.toHaveBeenCalled();
	});
});
