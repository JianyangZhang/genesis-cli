import { describe, expect, it } from "vitest";
import {
	acceptFirstSlashSuggestion,
	computeSlashSuggestions,
	formatSlashSuggestionHint,
	formatTranscriptAssistantLine,
	formatTranscriptUserLine,
	formatTurnNotice,
	shouldRenderInteractiveTranscriptEvent,
	wrapTranscriptContent,
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

	it("formats turn notices for thinking and responding", () => {
		expect(formatTurnNotice("thinking")).toContain("Thinking");
		expect(formatTurnNotice("responding")).toContain("Responding");
	});

	it("wraps transcript content for streaming redraw", () => {
		expect(wrapTranscriptContent("abcdef", 3)).toEqual(["abc", "def"]);
		expect(wrapTranscriptContent("你好吗", 4)).toEqual(["你好", "吗"]);
	});
});

describe("slash command hints", () => {
	const commands = [
		{ name: "help", description: "", type: "local" as const },
		{ name: "status", description: "", type: "local" as const },
		{ name: "sessions", description: "", type: "local" as const },
		{ name: "resume", description: "", type: "local" as const },
	];

	it("suggests commands when the user types a slash prefix", () => {
		expect(computeSlashSuggestions("/", commands)).toEqual(["help", "resume", "sessions", "status"]);
		expect(computeSlashSuggestions("/st", commands)).toEqual(["status"]);
	});

	it("does not suggest commands after arguments begin", () => {
		expect(computeSlashSuggestions("/status now", commands)).toEqual([]);
	});

	it("formats a dim inline hint for matching commands", () => {
		const hint = formatSlashSuggestionHint(["help", "status"], 30);
		expect(hint).toContain("/help");
		expect(hint).toContain("/status");
	});

	it("accepts the first slash suggestion on tab", () => {
		expect(acceptFirstSlashSuggestion({ buffer: "/st", cursor: 3 }, ["status", "sessions"])).toEqual({
			buffer: "/status ",
			cursor: 8,
		});
	});

	it("does not accept a suggestion once arguments have started", () => {
		expect(acceptFirstSlashSuggestion({ buffer: "/status now", cursor: 11 }, ["status"])).toBeNull();
	});
});
