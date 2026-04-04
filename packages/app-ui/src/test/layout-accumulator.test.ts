/**
 * Tests for the layout accumulator.
 */

import type { SessionId, SessionState } from "@genesis-cli/runtime";
import { describe, expect, it } from "vitest";
import { createLayoutAccumulator } from "../adapters/event-to-layout.js";
import type { ConversationLine } from "../adapters/tui-layout.js";

const SID: SessionId = { value: "test-session" };

function createTestSessionState(): SessionState {
	return {
		id: SID,
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		model: { id: "claude-3", provider: "test", displayName: "Claude 3" },
		toolSet: new Set(["read_file"]),
		planSummary: null,
		compactionSummary: null,
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
	};
}

const baseEvent = { id: "evt-1", timestamp: 1000, sessionId: SID };

describe("createLayoutAccumulator", () => {
	it("starts with empty conversation", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		const snapshot = acc.snapshot();
		expect(snapshot.conversation.lines).toHaveLength(0);
	});

	it("populates header from session state", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		const snapshot = acc.snapshot();
		expect(snapshot.header.modelName).toBe("Claude 3");
		expect(snapshot.header.sessionStatus).toBe("active");
	});
});

describe("push — text events", () => {
	it("accumulates text_delta as assistant text line", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({ ...baseEvent, category: "text", type: "text_delta", content: "Hello" });
		const snapshot = acc.snapshot();
		expect(snapshot.conversation.lines).toHaveLength(1);
		const line = snapshot.conversation.lines[0] as ConversationLine;
		expect(line.type).toBe("text");
		if (line.type === "text") {
			expect(line.role).toBe("assistant");
			expect(line.content).toBe("Hello");
		}
	});

	it("extends consecutive text deltas", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({ ...baseEvent, category: "text", type: "text_delta", content: "Hello" });
		acc.push({ ...baseEvent, id: "evt-2", category: "text", type: "text_delta", content: " world" });
		const snapshot = acc.snapshot();
		expect(snapshot.conversation.lines).toHaveLength(1);
		const line = snapshot.conversation.lines[0] as ConversationLine;
		if (line.type === "text") {
			expect(line.content).toBe("Hello world");
		}
	});
});

describe("push — tool events", () => {
	it("adds tool_call line on tool_started", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: {},
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		expect(line.type).toBe("tool_call");
		if (line.type === "tool_call") {
			expect(line.toolName).toBe("read_file");
			expect(line.status).toBe("running");
		}
	});

	it("updates tool_call to success on tool_completed", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: {},
		});
		acc.push({
			...baseEvent,
			id: "evt-2",
			category: "tool",
			type: "tool_completed",
			toolName: "read_file",
			toolCallId: "tc-1",
			status: "success",
			durationMs: 150,
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		if (line.type === "tool_call") {
			expect(line.status).toBe("success");
			expect(line.durationMs).toBe(150);
		}
	});

	it("updates tool_call to denied on tool_denied", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "tool",
			type: "tool_started",
			toolName: "bash",
			toolCallId: "tc-2",
			parameters: {},
		});
		acc.push({
			...baseEvent,
			id: "evt-2",
			category: "tool",
			type: "tool_denied",
			toolName: "bash",
			toolCallId: "tc-2",
			reason: "denied",
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		if (line.type === "tool_call") {
			expect(line.status).toBe("denied");
		}
	});
});

describe("push — plan events", () => {
	it("adds plan_step line on plan_step_started", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "plan",
			type: "plan_step_started",
			planId: "p-1",
			stepId: "s-1",
			stepDescription: "Read the file",
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		expect(line.type).toBe("plan_step");
		if (line.type === "plan_step") {
			expect(line.stepId).toBe("s-1");
			expect(line.description).toBe("Read the file");
			expect(line.status).toBe("in_progress");
		}
	});

	it("updates plan step to completed", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "plan",
			type: "plan_step_started",
			planId: "p-1",
			stepId: "s-1",
			stepDescription: "Read",
		});
		acc.push({
			...baseEvent,
			id: "evt-2",
			category: "plan",
			type: "plan_step_completed",
			planId: "p-1",
			stepId: "s-1",
			success: true,
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		if (line.type === "plan_step") {
			expect(line.status).toBe("completed");
		}
	});
});

describe("push — permission events", () => {
	it("adds permission_prompt line on permission_requested", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({
			...baseEvent,
			category: "permission",
			type: "permission_requested",
			toolName: "bash",
			toolCallId: "tc-1",
			riskLevel: "L3",
		});
		const snapshot = acc.snapshot();
		const line = snapshot.conversation.lines[0];
		expect(line.type).toBe("permission_prompt");
		if (line.type === "permission_prompt") {
			expect(line.toolName).toBe("bash");
			expect(line.riskLevel).toBe("L3");
		}
	});
});

describe("reset", () => {
	it("clears all conversation lines", () => {
		const acc = createLayoutAccumulator(createTestSessionState());
		acc.push({ ...baseEvent, category: "text", type: "text_delta", content: "Hello" });
		expect(acc.snapshot().conversation.lines).toHaveLength(1);
		acc.reset();
		expect(acc.snapshot().conversation.lines).toHaveLength(0);
	});
});

describe("statusLine with plan progress", () => {
	it("shows plan progress when planSummary is present", () => {
		const state = createTestSessionState();
		// Create a new state with plan summary
		const stateWithPlan = {
			...state,
			planSummary: {
				planId: "p-1",
				goal: "fix",
				status: "active" as const,
				stepCount: 5,
				completedSteps: 2,
			},
		};
		const acc = createLayoutAccumulator(stateWithPlan);
		const snapshot = acc.snapshot();
		expect(snapshot.statusLine.planProgress).toBe("Plan: 2/5");
	});

	it("reads the latest session state from a supplier", () => {
		let state = createTestSessionState();
		const acc = createLayoutAccumulator(() => state);

		state = {
			...state,
			planSummary: {
				planId: "p-2",
				goal: "ship fix",
				status: "active",
				stepCount: 4,
				completedSteps: 3,
			},
		};

		const snapshot = acc.snapshot();
		expect(snapshot.header.planStatus).toBe("Plan: ship fix");
		expect(snapshot.statusLine.planProgress).toBe("Plan: 3/4");
	});
});
