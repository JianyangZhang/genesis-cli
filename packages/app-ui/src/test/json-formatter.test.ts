/**
 * Tests for the JSON formatter.
 */

import type { RuntimeEvent } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import { eventToJsonEnvelope, sanitizeForJson } from "../services/json-formatter.js";

const SID = { value: "test-session" };
const base = { id: "evt-1", timestamp: 1000, sessionId: SID };

describe("eventToJsonEnvelope", () => {
	it("creates envelope with event type and category", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hello",
		};
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.event).toBe("text_delta");
		expect(envelope.category).toBe("text");
		expect(envelope.timestamp).toBe(1000);
		expect(envelope.sessionId).toBe("test-session");
	});

	it("does not contain jsonrpc field (distinct from RPC mode)", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hi",
		};
		const envelope = eventToJsonEnvelope(event);
		expect("jsonrpc" in envelope).toBe(false);
	});

	it("does not contain id field (distinct from RPC mode)", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hi",
		};
		const envelope = eventToJsonEnvelope(event);
		expect("id" in envelope).toBe(false);
	});

	it("maps tool event fields to data", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: { path: "/src/main.ts" },
		};
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.data.toolName).toBe("read_file");
		expect(envelope.data.toolCallId).toBe("tc-1");
		expect(envelope.data.parameters).toEqual({ path: "/src/main.ts" });
	});

	it("maps plan event fields to data", () => {
		const event: RuntimeEvent = {
			...base,
			category: "plan",
			type: "plan_created",
			planId: "p-1",
			goal: "fix bug",
			stepCount: 3,
		};
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.data.planId).toBe("p-1");
		expect(envelope.data.goal).toBe("fix bug");
		expect(envelope.data.stepCount).toBe(3);
	});

	it("maps permission event fields to data", () => {
		const event: RuntimeEvent = {
			...base,
			category: "permission",
			type: "permission_resolved",
			toolName: "bash",
			toolCallId: "tc-1",
			decision: "allow",
		};
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.data.decision).toBe("allow");
	});

	it("maps session event fields to data", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_created",
			model: { id: "claude-3", provider: "anthropic" },
			toolSet: ["read"],
		};
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.data.model).toEqual({ id: "claude-3", provider: "anthropic" });
	});

	it("maps compaction event fields to data", () => {
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
		const envelope = eventToJsonEnvelope(event);
		expect(envelope.data.summary).toBeDefined();
	});
});

describe("sanitizeForJson", () => {
	it("never includes TUI-specific keys", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_started",
			toolName: "bash",
			toolCallId: "tc-1",
			parameters: {},
		};
		const data = sanitizeForJson(event);
		const forbidden = ["phase", "layout", "cursor", "ansi", "interactionState"];
		for (const key of forbidden) {
			expect(data).not.toHaveProperty(key);
		}
	});

	it("always includes event id", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hi",
		};
		const data = sanitizeForJson(event);
		expect(data.id).toBe("evt-1");
	});

	it("strips tool_completed to stable fields only", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_completed",
			toolName: "read",
			toolCallId: "tc-1",
			status: "success",
			durationMs: 100,
			result: "ok",
		};
		const data = sanitizeForJson(event);
		expect(data.toolName).toBe("read");
		expect(data.status).toBe("success");
		expect(data.durationMs).toBe(100);
	});

	it("handles text_delta content", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "Hello",
		};
		const data = sanitizeForJson(event);
		expect(data.content).toBe("Hello");
	});

	it("handles usage_updated payload", () => {
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
		const data = sanitizeForJson(event);
		expect(data.usage).toEqual(event.usage);
		expect(data.isFinal).toBe(true);
	});
});
