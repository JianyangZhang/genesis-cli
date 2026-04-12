import { createEventBus } from "@pickle-pee/runtime";
import type { SessionFacade } from "@pickle-pee/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInteractiveSessionBinding } from "../interactive-session-binding.js";

function createSession(id: string): SessionFacade {
	const events = createEventBus();
	const state = {
		id: { value: id },
		model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
	} as SessionFacade["state"];
	return {
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
		events,
		plan: null,
		prompt: async () => {},
		continue: async () => {},
		switchModel: async () => {},
		abort: () => {},
		close: async () => {},
		onStateChange: () => () => {},
		resolvePermission: async () => {},
		compact: async () => {},
		snapshotRecoveryData: async () =>
			({
				sessionId: { value: id },
				cwd: `/tmp/${id}`,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				transcriptPath: `/tmp/${id}.jsonl`,
				metadata: null,
			}) as never,
	} as SessionFacade;
}

describe("interactive session binding", () => {
	it("detaches old event listeners when switching sessions", () => {
		const first = createSession("first");
		const second = createSession("second");
		const onEvent = vi.fn();
		const binding = createInteractiveSessionBinding(first, {
			onSessionAttached: () => {},
			onSessionEvent: onEvent,
			onSessionStateChange: () => {},
		});

		binding.switchSession(second);
		first.events.emit({
			id: "old",
			timestamp: Date.now(),
			sessionId: first.id,
			category: "session",
			type: "session_resumed",
			recoveryData: {} as never,
		});
		second.events.emit({
			id: "new",
			timestamp: Date.now(),
			sessionId: second.id,
			category: "session",
			type: "session_resumed",
			recoveryData: {} as never,
		});

		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: second.id }), second);
	});
});
