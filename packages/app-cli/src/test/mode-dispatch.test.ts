import { describe, expect, it } from "vitest";
import {
	acceptFirstSlashSuggestion,
	computeInteractiveFooterSeparatorWidth,
	computePromptCursorRowsUp,
	computeSlashSuggestions,
	countRenderedTerminalRows,
	formatInteractiveInputSeparator,
	formatInteractivePermissionBlock,
	formatInteractivePromptBuffer,
	formatInteractiveToolEvent,
	formatInteractiveToolResult,
	formatInteractiveToolTitle,
	formatSlashSuggestionHint,
	formatTranscriptAssistantLine,
	formatTranscriptUserLine,
	formatTurnNotice,
	formatWelcomeBottomBorder,
	formatWelcomeCenteredLine,
	formatWelcomeFilledLine,
	formatWelcomeTopBorder,
	mergeStreamingText,
	movePermissionSelection,
	permissionDecisionFromSelection,
	shouldRenderInteractiveTranscriptEvent,
	wrapTranscriptContent,
} from "../mode-dispatch.js";

describe("interactive transcript formatting", () => {
	it("formats user lines as a compact highlighted block", () => {
		const line = formatTranscriptUserLine("Hello");
		expect(line).toContain("Hello");
		expect(line).toContain("\x1b[48;5;250m");
	});

	it("formats assistant lines with a themed bullet prefix", () => {
		const line = formatTranscriptAssistantLine("Hello");
		expect(line).toContain("⏺");
		expect(line).toContain("Hello");
	});

	it("keeps the live interactive prompt buffer unstyled", () => {
		expect(formatInteractivePromptBuffer("Hello")).toBe("Hello");
	});

	it("formats a full-width separator for the input area", () => {
		expect(formatInteractiveInputSeparator(5)).toContain("─────");
	});

	it("keeps footer separators inside a safe terminal margin", () => {
		expect(computeInteractiveFooterSeparatorWidth(80)).toBe(78);
		expect(computeInteractiveFooterSeparatorWidth(10)).toBe(20);
	});

	it("closes the welcome card top border at the requested width", () => {
		const line = formatWelcomeTopBorder(40, "0.0.0");
		const visible = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		expect(visible).toHaveLength(40);
		expect(visible.endsWith("╮")).toBe(true);
	});

	it("keeps the welcome bottom border aligned to the requested width", () => {
		expect(formatWelcomeBottomBorder(40)).toHaveLength(40);
		expect(formatWelcomeBottomBorder(40).startsWith("╰")).toBe(true);
		expect(formatWelcomeBottomBorder(40).endsWith("╯")).toBe(true);
	});

	it("keeps welcome body rows aligned to the frame width", () => {
		const filled = formatWelcomeFilledLine(38, "abc");
		const centered = formatWelcomeCenteredLine(38, "abc");
		expect(filled).toHaveLength(40);
		expect(centered).toHaveLength(40);
		expect(filled.startsWith("│")).toBe(true);
		expect(centered.endsWith("│")).toBe(true);
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

	it("suppresses internal tool transcript noise", () => {
		expect(
			shouldRenderInteractiveTranscriptEvent({
				id: "evt-tool",
				category: "tool",
				type: "tool_denied",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "bash",
				toolCallId: "call-1",
				reason: "not allowed",
			}),
		).toBe(false);
	});

	it("suppresses permission events from the generic transcript formatter", () => {
		expect(
			shouldRenderInteractiveTranscriptEvent({
				id: "evt-2",
				category: "permission",
				type: "permission_requested",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "read_file",
				toolCallId: "call-1",
				riskLevel: "L2",
			}),
		).toBe(false);
	});

	it("formats turn notices for thinking and responding", () => {
		expect(formatTurnNotice("thinking")).toContain("Thinking");
		expect(formatTurnNotice("responding")).toContain("Responding");
	});

	it("wraps transcript content for streaming redraw", () => {
		expect(wrapTranscriptContent("abcdef", 3)).toEqual(["abc", "def"]);
		expect(wrapTranscriptContent("你好吗", 4)).toEqual(["你好", "吗"]);
	});

	it("counts rendered footer rows after terminal resize", () => {
		expect(countRenderedTerminalRows(["──────────"], 4)).toBe(3);
		expect(computePromptCursorRowsUp(["──────────", "❯ hello", "──────────"], 4, 6)).toBe(4);
	});

	it("merges overlapping streaming chunks without duplicating text", () => {
		expect(mergeStreamingText("你好", "好吗")).toBe("你好吗");
		expect(mergeStreamingText("抱歉，当前可用", "当前可用的工具")).toBe("抱歉，当前可用的工具");
		expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
		expect(mergeStreamingText("抱歉", "     抱歉，当前环境中")).toBe("抱歉，当前环境中");
		expect(mergeStreamingText("看起来", "  看起来 `bash` 工具当前确实不可用")).toBe(
			"看起来 `bash` 工具当前确实不可用",
		);
	});

	it("formats interactive tool steps like Claude-style blocks", () => {
		expect(formatInteractiveToolTitle("bash", { command: "pwd" })).toBe("⏺ Bash(pwd)");
		expect(
			formatInteractiveToolEvent(
				{
					id: "tool-1",
					category: "tool",
					type: "tool_completed",
					timestamp: Date.now(),
					sessionId: { value: "s1" },
					toolName: "bash",
					toolCallId: "call-1",
					status: "success",
					result: "/tmp",
					durationMs: 10,
				},
				{ command: "pwd" },
			),
		).toContain("⎿");
		expect(
			formatInteractiveToolResult("write", undefined, {
				file_path: "/tmp/test.txt",
				content: "hello\nworld",
			}),
		).toContain("Wrote 2 lines to test.txt");
		expect(
			formatInteractiveToolEvent({
				id: "tool-2",
				category: "tool",
				type: "tool_started",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "write",
				toolCallId: "call-2",
				parameters: { file_path: "/tmp/test.txt", content: "hello\nworld" },
			}),
		).toContain("│ Preview");
		expect(
			formatInteractiveToolEvent({
				id: "tool-3",
				category: "tool",
				type: "tool_started",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "edit",
				toolCallId: "call-3",
				parameters: {
					file_path: "/tmp/test.txt",
					old_string: "old line",
					new_string: "new line",
				},
			}),
		).toContain("│ Diff");
		expect(
			formatInteractiveToolEvent({
				id: "tool-3",
				category: "tool",
				type: "tool_started",
				timestamp: Date.now(),
				sessionId: { value: "s1" },
				toolName: "edit",
				toolCallId: "call-3",
				parameters: {
					file_path: "/tmp/test.txt",
					old_string: "old line",
					new_string: "new line",
				},
			}),
		).toContain("- old line");
		expect(
			formatInteractiveToolResult("edit", undefined, {
				file_path: "/tmp/test.txt",
				old_string: "old line",
				new_string: "new line",
			}),
		).toContain("Applied edit to test.txt");
	});

	it("formats a structured permission block", () => {
		const block = formatInteractivePermissionBlock(
			{
				toolName: "write",
				riskLevel: "L2",
				targetPath: "/tmp/test.txt",
			},
			1,
		);
		expect(block).toContain("⏺ Write(test.txt)");
		expect(block).toContain("❯ \u001b[48;5;111m\u001b[38;5;16m2. Yes, allow during this session\u001b[0m");
		expect(block).toContain("  1. Yes");
	});

	it("cycles permission selection and maps it to decisions", () => {
		expect(movePermissionSelection(0, -1)).toBe(2);
		expect(movePermissionSelection(2, 1)).toBe(0);
		expect(permissionDecisionFromSelection(0)).toBe("allow_once");
		expect(permissionDecisionFromSelection(1)).toBe("allow_for_session");
		expect(permissionDecisionFromSelection(2)).toBe("deny");
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
