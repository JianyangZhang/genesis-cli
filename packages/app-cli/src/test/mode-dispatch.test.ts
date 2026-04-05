import { describe, expect, it } from "vitest";
import {
	formatTranscriptAssistantLine,
	formatTranscriptUserLine,
	shouldRenderInteractiveTranscriptEvent,
} from "../mode-dispatch.js";

describe("interactive transcript formatting", () => {
	it("formats user lines as a compact highlighted block", () => {
		const line = formatTranscriptUserLine("Hello");
		expect(line).toContain("Hello");
		expect(line).toContain("\x1b[48;5;238m");
	});

	it("formats assistant lines without author prefixes", () => {
		expect(formatTranscriptAssistantLine("Hello")).toBe("Hello");
	});

	it("suppresses session lifecycle events", () => {
		expect(
			shouldRenderInteractiveTranscriptEvent({
				id: "evt-1",
				category: "session",
				type: "session_created",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				model: {
					id: "glm-5.1",
					displayName: "GLM 5.1",
					provider: "zhipu",
				},
				toolSet: [],
			}),
		).toBe(false);
	});

	it("keeps non-session events visible in the transcript", () => {
		expect(
			shouldRenderInteractiveTranscriptEvent({
				id: "evt-2",
				category: "tool",
				type: "tool_started",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "read_file",
				toolCallId: "call-1",
				parameters: {},
			}),
		).toBe(true);
	});
});
