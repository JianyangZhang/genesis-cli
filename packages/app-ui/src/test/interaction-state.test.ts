/**
 * Tests for the interaction state reducer.
 */

import type { RuntimeEvent } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import { initialInteractionState, reduceInteractionState } from "../services/interaction-state.js";

const SID = { value: "test-session" };
const base = { id: "evt-1", timestamp: 1000, sessionId: SID };

describe("initialInteractionState", () => {
	it("starts idle with no active tool or plan", () => {
		const state = initialInteractionState();
		expect(state.phase).toBe("idle");
		expect(state.activeToolName).toBeNull();
		expect(state.activeToolCallId).toBeNull();
		expect(state.activePlanStepId).toBeNull();
		expect(state.activePlanId).toBeNull();
	});
});

describe("reduceInteractionState — text events", () => {
	it("transitions idle → streaming on text_delta", () => {
		const event: RuntimeEvent = { ...base, category: "text", type: "text_delta", content: "hello" };
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.phase).toBe("streaming");
	});

	it("transitions thinking → streaming on text_delta", () => {
		const current = { ...initialInteractionState(), phase: "thinking" as const };
		const event: RuntimeEvent = { ...base, category: "text", type: "text_delta", content: "hi" };
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("streaming");
	});

	it("does not change streaming → streaming on text_delta", () => {
		const current = { ...initialInteractionState(), phase: "streaming" as const };
		const event: RuntimeEvent = { ...base, category: "text", type: "text_delta", content: "more" };
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("streaming");
	});

	it("does not change tool_executing on text_delta", () => {
		const current = { ...initialInteractionState(), phase: "tool_executing" as const };
		const event: RuntimeEvent = { ...base, category: "text", type: "text_delta", content: "x" };
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("tool_executing");
	});

	it("ignores thinking_delta when idle", () => {
		const event: RuntimeEvent = { ...base, category: "text", type: "thinking_delta", content: "hmm" };
		const next = reduceInteractionState(initialInteractionState(), event);
		// thinking_delta transitions idle → streaming
		expect(next.phase).toBe("streaming");
	});
});

describe("reduceInteractionState — tool events", () => {
	it("transitions to tool_executing on tool_started", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: {},
		};
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.phase).toBe("tool_executing");
		expect(next.activeToolName).toBe("read_file");
		expect(next.activeToolCallId).toBe("tc-1");
	});

	it("transitions back to idle on tool_completed", () => {
		const current = {
			...initialInteractionState(),
			phase: "tool_executing" as const,
			activeToolName: "read_file",
			activeToolCallId: "tc-1",
		};
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_completed",
			toolName: "read_file",
			toolCallId: "tc-1",
			status: "success",
			durationMs: 100,
		};
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("idle");
		expect(next.activeToolName).toBeNull();
	});

	it("transitions back to idle on tool_denied", () => {
		const current = {
			...initialInteractionState(),
			phase: "tool_executing" as const,
			activeToolName: "bash",
			activeToolCallId: "tc-2",
		};
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_denied",
			toolName: "bash",
			toolCallId: "tc-2",
			reason: "user denied",
		};
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("idle");
		expect(next.activeToolName).toBeNull();
	});

	it("does not change phase on tool_update", () => {
		const current = {
			...initialInteractionState(),
			phase: "tool_executing" as const,
			activeToolName: "bash",
			activeToolCallId: "tc-3",
		};
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_update",
			toolName: "bash",
			toolCallId: "tc-3",
			update: "running...",
		};
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("tool_executing");
	});
});

describe("reduceInteractionState — permission events", () => {
	it("transitions to waiting_permission on permission_requested", () => {
		const event: RuntimeEvent = {
			...base,
			category: "permission",
			type: "permission_requested",
			toolName: "bash",
			toolCallId: "tc-4",
			riskLevel: "L3",
		};
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.phase).toBe("waiting_permission");
		expect(next.activeToolName).toBe("bash");
	});

	it("transitions back to idle on permission_resolved", () => {
		const current = {
			...initialInteractionState(),
			phase: "waiting_permission" as const,
			activeToolName: "bash",
			activeToolCallId: "tc-4",
		};
		const event: RuntimeEvent = {
			...base,
			category: "permission",
			type: "permission_resolved",
			toolName: "bash",
			toolCallId: "tc-4",
			decision: "allow",
		};
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("idle");
	});
});

describe("reduceInteractionState — compaction events", () => {
	it("transitions to compacting on compaction_started", () => {
		const event: RuntimeEvent = { ...base, category: "compaction", type: "compaction_started" };
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.phase).toBe("compacting");
	});

	it("transitions back to idle on compaction_completed", () => {
		const current = { ...initialInteractionState(), phase: "compacting" as const };
		const event: RuntimeEvent = {
			...base,
			category: "compaction",
			type: "compaction_completed",
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 3,
				estimatedTokensSaved: 5000,
			},
		};
		const next = reduceInteractionState(current, event);
		expect(next.phase).toBe("idle");
	});
});

describe("reduceInteractionState — plan events", () => {
	it("tracks activePlanId on plan_created", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_created",
			planId: "p-1",
			goal: "fix bug",
			stepCount: 3,
		};
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.activePlanId).toBe("p-1");
	});

	it("tracks plan step on plan_step_started", () => {
		const current = { ...initialInteractionState(), activePlanId: "p-1" };
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_step_started",
			planId: "p-1",
			stepId: "s-1",
			stepDescription: "read file",
		};
		const next = reduceInteractionState(current, event);
		expect(next.activePlanStepId).toBe("s-1");
		expect(next.activePlanId).toBe("p-1");
	});

	it("clears activePlanStepId on plan_step_completed", () => {
		const current = { ...initialInteractionState(), activePlanId: "p-1", activePlanStepId: "s-1" };
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_step_completed",
			planId: "p-1",
			stepId: "s-1",
			success: true,
		};
		const next = reduceInteractionState(current, event);
		expect(next.activePlanStepId).toBeNull();
	});

	it("clears all plan state on plan_completed", () => {
		const current = { ...initialInteractionState(), activePlanId: "p-1", activePlanStepId: "s-2" };
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_completed",
			planId: "p-1",
			goal: "done",
			success: true,
			summary: { planId: "p-1", goal: "done", status: "completed", stepCount: 3, completedSteps: 3 },
		};
		const next = reduceInteractionState(current, event);
		expect(next.activePlanId).toBeNull();
		expect(next.activePlanStepId).toBeNull();
	});
});

describe("reduceInteractionState — session events", () => {
	it("does not change phase on session events", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_created",
			model: { id: "m-1", provider: "test" },
			toolSet: [],
		};
		const next = reduceInteractionState(initialInteractionState(), event);
		expect(next.phase).toBe("idle");
	});
});
