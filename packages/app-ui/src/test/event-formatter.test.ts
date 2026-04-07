/**
 * Tests for the event-to-text formatter.
 */

import type { PlanSummary, RuntimeEvent } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import {
	formatEventAsText,
	formatPermissionPrompt,
	formatPlanSummaryText,
	formatToolStep,
} from "../services/event-formatter.js";

const SID = { value: "test-session" };
const base = { id: "evt-1", timestamp: 1000, sessionId: SID };

describe("formatEventAsText", () => {
	it("formats session_created", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_created",
			model: { id: "claude-3", provider: "anthropic" },
			toolSet: ["read", "write"],
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Session created");
	});

	it("formats session_resumed", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_resumed",
			recoveryData: {
				sessionId: SID,
				model: { id: "m", provider: "p" },
				toolSet: [],
				planSummary: null,
				compactionSummary: null,
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
			},
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Session resumed");
	});

	it("formats session_error", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_error",
			message: "401 Unauthorized",
			source: "auth",
			fatal: true,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Error");
		expect(text).toContain("401 Unauthorized");
	});

	it("formats tool_started", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: { path: "/src/main.ts" },
		};
		const text = formatEventAsText(event);
		expect(text).toContain("read_file");
		expect(text).toContain("path=/src/main.ts");
	});

	it("formats tool_completed success", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_completed",
			toolName: "read_file",
			toolCallId: "tc-1",
			status: "success",
			durationMs: 150,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("ok");
		expect(text).toContain("150ms");
	});

	it("formats tool_completed failure", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_completed",
			toolName: "read_file",
			toolCallId: "tc-1",
			status: "failure",
			durationMs: 50,
			result: "not found",
		};
		const text = formatEventAsText(event);
		expect(text).toContain("failed");
		expect(text).toContain("not found");
	});

	it("formats tool_denied", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_denied",
			toolName: "bash",
			toolCallId: "tc-2",
			reason: "user rejected",
		};
		const text = formatEventAsText(event);
		expect(text).toContain("denied");
		expect(text).toContain("user rejected");
	});

	it("formats plan_created", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_created",
			planId: "p-1",
			goal: "fix the bug",
			stepCount: 3,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Plan");
		expect(text).toContain("fix the bug");
		expect(text).toContain("3 steps");
	});

	it("formats plan_step_started", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_step_started",
			planId: "p-1",
			stepId: "s-1",
			stepDescription: "Read the file",
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Read the file");
	});

	it("formats plan_step_completed success", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_step_completed",
			planId: "p-1",
			stepId: "s-1",
			success: true,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("step s-1");
	});

	it("formats plan_step_failed with rework", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_step_failed",
			planId: "p-1",
			stepId: "s-1",
			reason: "test failed",
			reworkScheduled: true,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("test failed");
		expect(text).toContain("rework scheduled");
	});

	it("formats compaction_started", () => {
		const event: RuntimeEvent = { ...base, category: "compaction", type: "compaction_started" };
		const text = formatEventAsText(event);
		expect(text).toContain("Compacting");
	});

	it("formats compaction_completed", () => {
		const event: RuntimeEvent = {
			...base,
			category: "compaction",
			type: "compaction_completed",
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 20,
				retainedMessageCount: 5,
				estimatedTokensSaved: 8000,
			},
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Compacted");
		expect(text).toContain("8000 tokens saved");
	});

	it("formats text_delta", () => {
		const event: RuntimeEvent = { ...base, category: "text", type: "text_delta", content: "Hello world" };
		const text = formatEventAsText(event);
		expect(text).toBe("Hello world");
	});

	it("returns empty for thinking_delta", () => {
		const event: RuntimeEvent = { ...base, category: "text", type: "thinking_delta", content: "hmm" };
		const text = formatEventAsText(event);
		expect(text).toBe("");
	});

	it("formats final usage summaries", () => {
		const event: RuntimeEvent = {
			...base,
			category: "usage",
			type: "usage_updated",
			usage: {
				input: 120,
				output: 24,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 144,
			},
			isFinal: true,
		};
		const text = formatEventAsText(event);
		expect(text).toContain("Usage:");
		expect(text).toContain("total 144");
	});
});

describe("formatToolStep", () => {
	it("formats a step indicator", () => {
		const event = {
			...base,
			category: "tool" as const,
			type: "tool_started" as const,
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: { path: "foo.ts" },
		};
		const text = formatToolStep(event, 1, 3);
		expect(text).toContain("[1/3]");
		expect(text).toContain("read_file");
	});
});

describe("formatPlanSummaryText", () => {
	it("formats plan summary", () => {
		const summary: PlanSummary = {
			planId: "p-1",
			goal: "fix bug",
			status: "active",
			stepCount: 5,
			completedSteps: 3,
		};
		const text = formatPlanSummaryText(summary);
		expect(text).toContain("3/5");
	});
});

describe("formatPermissionPrompt", () => {
	it("formats permission request", () => {
		const event = {
			...base,
			category: "permission" as const,
			type: "permission_requested" as const,
			toolName: "bash",
			toolCallId: "tc-1",
			riskLevel: "L3",
		};
		const text = formatPermissionPrompt(event);
		expect(text).toContain("Permission required");
		expect(text).toContain("L3");
		expect(text).toContain("bash");
	});
});
