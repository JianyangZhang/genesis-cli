import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawUpstreamEvent } from "../adapters/kernel-session-adapter.js";
import { EventNormalizer } from "../services/event-normalizer.js";
import type { SessionId } from "../types/index.js";

const stubSessionId: SessionId = { value: "norm-test" };

describe("EventNormalizer", () => {
	const normalizer = new EventNormalizer(stubSessionId);
	const originalDebug = process.env.GENESIS_DEBUG;

	afterEach(() => {
		if (originalDebug === undefined) {
			delete process.env.GENESIS_DEBUG;
		} else {
			process.env.GENESIS_DEBUG = originalDebug;
		}
	});

	it("maps agent_start to session_created", () => {
		const raw: RawUpstreamEvent = {
			type: "agent_start",
			timestamp: 1000,
			payload: {
				model: { id: "reference-model", provider: "reference" },
				toolSet: ["read", "edit"],
			},
		};

		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		expect(result!.category).toBe("session");
		expect(result!.type).toBe("session_created");
		expect(result!.sessionId).toBe(stubSessionId);
	});

	it("maps agent_end to session_closed", () => {
		const raw: RawUpstreamEvent = { type: "agent_end", timestamp: 2000 };
		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		expect(result!.category).toBe("session");
		expect(result!.type).toBe("session_closed");
	});

	it("maps agent_error to session_error", () => {
		const raw: RawUpstreamEvent = {
			type: "agent_error",
			timestamp: 2500,
			payload: {
				message: "401 Unauthorized",
				source: "auth",
				fatal: true,
			},
		};
		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		const event = result!;
		expect(event.category).toBe("session");
		expect(event.type).toBe("session_error");
		if (event.type === "session_error") {
			expect(event.message).toBe("401 Unauthorized");
			expect(event.source).toBe("auth");
			expect(event.fatal).toBe(true);
		}
	});

	it("maps tool_execution_start to tool_started", () => {
		const raw: RawUpstreamEvent = {
			type: "tool_execution_start",
			timestamp: 3000,
			payload: {
				toolName: "read",
				toolCallId: "call-1",
				parameters: { path: "/tmp/test.ts" },
			},
		};

		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		expect(result!.category).toBe("tool");
		expect(result!.type).toBe("tool_started");
		if (result!.type === "tool_started") {
			expect(result!.toolName).toBe("read");
			expect(result!.toolCallId).toBe("call-1");
			expect(result!.parameters).toEqual({ path: "/tmp/test.ts" });
		}
	});

	it("maps tool_execution_end to tool_completed", () => {
		const raw: RawUpstreamEvent = {
			type: "tool_execution_end",
			timestamp: 4000,
			payload: {
				toolName: "edit",
				toolCallId: "call-2",
				status: "success",
				result: "File edited",
				durationMs: 150,
			},
		};

		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		expect(result!.type).toBe("tool_completed");
		if (result!.type === "tool_completed") {
			expect(result!.status).toBe("success");
			expect(result!.durationMs).toBe(150);
		}
	});

	it("maps tool_execution_denied to tool_denied", () => {
		const raw: RawUpstreamEvent = {
			type: "tool_execution_denied",
			timestamp: 4500,
			payload: {
				toolName: "bash",
				toolCallId: "call-3",
				reason: "Permission denied",
			},
		};

		const result = normalizer.normalize(raw);

		expect(result).not.toBeNull();
		expect(result!.type).toBe("tool_denied");
		if (result!.type === "tool_denied") {
			expect(result!.toolName).toBe("bash");
			expect(result!.reason).toBe("Permission denied");
		}
	});

	it("maps compaction_start/end to compaction events", () => {
		const startRaw: RawUpstreamEvent = { type: "compaction_start", timestamp: 5000 };
		const startResult = normalizer.normalize(startRaw);
		expect(startResult!.type).toBe("compaction_started");

		const endRaw: RawUpstreamEvent = {
			type: "compaction_end",
			timestamp: 6000,
			payload: {
				originalMessageCount: 20,
				retainedMessageCount: 5,
				estimatedTokensSaved: 10000,
				compactedSummary: "Compacted summary body",
			},
		};
		const endResult = normalizer.normalize(endRaw);
		expect(endResult!.type).toBe("compaction_completed");
		if (endResult!.type === "compaction_completed") {
			expect(endResult!.summary.originalMessageCount).toBe(20);
			expect(endResult!.summary.compactedSummary).toBe("Compacted summary body");
		}
	});

	it("maps message_update with text to text_delta", () => {
		const raw: RawUpstreamEvent = {
			type: "message_update",
			timestamp: 7000,
			payload: { content: "Hello world" },
		};

		const result = normalizer.normalize(raw);
		expect(result!.type).toBe("text_delta");
		if (result!.type === "text_delta") {
			expect(result!.content).toBe("Hello world");
		}
	});

	it("maps message_update with thinking to thinking_delta", () => {
		const raw: RawUpstreamEvent = {
			type: "message_update",
			timestamp: 8000,
			payload: { kind: "thinking", content: "Let me think..." },
		};

		const result = normalizer.normalize(raw);
		expect(result!.type).toBe("thinking_delta");
		if (result!.type === "thinking_delta") {
			expect(result!.content).toBe("Let me think...");
		}
	});

	it("maps usage_update to usage_updated", () => {
		const raw: RawUpstreamEvent = {
			type: "usage_update",
			timestamp: 8500,
			payload: {
				input: 210,
				output: 95,
				cacheRead: 12,
				cacheWrite: 0,
				totalTokens: 317,
				isFinal: true,
			},
		};

		const result = normalizer.normalize(raw);
		expect(result!.type).toBe("usage_updated");
		if (result!.type === "usage_updated") {
			expect(result!.usage.totalTokens).toBe(317);
			expect(result!.isFinal).toBe(true);
		}
	});

	it("returns null for unrecognized events", () => {
		const raw: RawUpstreamEvent = { type: "unknown_event_type", timestamp: 9000 };
		const result = normalizer.normalize(raw);
		expect(result).toBeNull();
	});

	it("reports unknown events once per event type", () => {
		const onUnknownEvent = vi.fn();
		const withObserver = new EventNormalizer(stubSessionId, { onUnknownEvent });
		withObserver.normalize({ type: "unknown_event_type", timestamp: 1 });
		withObserver.normalize({ type: "unknown_event_type", timestamp: 2 });
		withObserver.normalize({ type: "unknown_event_type_2", timestamp: 3 });

		expect(onUnknownEvent).toHaveBeenCalledTimes(2);
		expect(onUnknownEvent.mock.calls[0]?.[0]).toMatchObject({
			sessionId: stubSessionId,
			type: "unknown_event_type",
			timestamp: 1,
		});
	});

	it("writes a debug warning for unknown events when GENESIS_DEBUG is enabled", () => {
		process.env.GENESIS_DEBUG = "1";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const withDebug = new EventNormalizer(stubSessionId);
		withDebug.normalize({ type: "unknown_event_type", timestamp: 1 });
		withDebug.normalize({ type: "unknown_event_type", timestamp: 2 });

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("Unknown upstream event type");

		warn.mockRestore();
	});

	it("assigns unique event IDs", () => {
		const raw: RawUpstreamEvent = { type: "agent_end", timestamp: 1000 };
		const r1 = normalizer.normalize(raw);
		const r2 = normalizer.normalize(raw);
		expect(r1!.id).not.toBe(r2!.id);
	});
});
