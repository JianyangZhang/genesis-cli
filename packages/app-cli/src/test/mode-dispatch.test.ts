import { describe, expect, it } from "vitest";
import {
	acceptFirstSlashSuggestion,
	buildWelcomeLines,
	computeFooterCursorColumn,
	computeFooterCursorRowsFromEnd,
	computeFooterCursorRowsUp,
	computeFooterStartRow,
	computeInteractiveEphemeralRows,
	computeInteractiveFooterSeparatorWidth,
	computePromptCursorRowsUp,
	computeSlashSuggestions,
	computeVisibleTranscriptLines,
	countRenderedTerminalRows,
	fitTerminalLine,
	formatInteractiveFooter,
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
	materializeAssistantTranscriptBlock,
	mergeStreamingText,
	movePermissionSelection,
	permissionDecisionFromSelection,
	pickWelcomeGreeting,
	shouldRenderInteractiveTranscriptEvent,
	WELCOME_BIBLE_GREETINGS,
	wrapTranscriptContent,
} from "../mode-dispatch.js";

describe("interactive transcript formatting", () => {
	it("formats user lines as a compact highlighted block", () => {
		const line = formatTranscriptUserLine("Hello");
		expect(line).toContain("Hello");
		expect(line).toContain("\x1b[48;5;252m");
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

	it("formats the footer from a unified composer state", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "/he",
			cursor: 3,
			suggestions: ["help"],
			turnNotice: "thinking",
			permission: null,
		});
		expect(footer.block).toContain("Thinking");
		expect(footer.block).toContain("❯ /he");
		expect(footer.lines).toHaveLength(4);
		expect(footer.cursorLineIndex).toBe(2);
	});

	it("formats permission choices inside the unified footer", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "2",
			cursor: 1,
			suggestions: [],
			turnNotice: "responding",
			permission: {
				details: {
					toolName: "write",
					riskLevel: "L2",
					targetPath: "/tmp/test.txt",
				},
				selectedIndex: 1,
			},
		});
		expect(footer.block).toContain("Responding");
		expect(footer.block).toContain("Write(test.txt)");
		expect(footer.block).toContain("choice [Enter/1/2/3]> 2");
	});

	it("sizes footer separators to the current terminal width", () => {
		expect(computeInteractiveFooterSeparatorWidth(80)).toBe(80);
		expect(computeInteractiveFooterSeparatorWidth(10)).toBe(20);
	});

	it("closes the welcome card top border at the requested width", () => {
		const line = formatWelcomeTopBorder(40, "0.0.0");
		const visible = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		expect(visible).toHaveLength(40);
		expect(visible.endsWith("╮")).toBe(true);
	});

	it("keeps the welcome bottom border aligned to the requested width", () => {
		const visible = formatWelcomeBottomBorder(40).replace(
			new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"),
			"",
		);
		expect(visible).toHaveLength(40);
		expect(visible.startsWith("╰")).toBe(true);
		expect(visible.endsWith("╯")).toBe(true);
	});

	it("keeps welcome body rows aligned to the frame width", () => {
		const filled = formatWelcomeFilledLine(38, "abc");
		const centered = formatWelcomeCenteredLine(38, "abc");
		const filledVisible = filled.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		const centeredVisible = centered.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		expect(filledVisible).toHaveLength(40);
		expect(centeredVisible).toHaveLength(40);
		expect(filledVisible.startsWith("│")).toBe(true);
		expect(centeredVisible.endsWith("│")).toBe(true);
	});

	it("builds welcome lines without the cwd and keeps a spacer before the model line", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 80,
			version: "0.0.0",
			model: "GLM 5.1",
			provider: "zai",
			greeting: "Let there be light.",
		});
		expect(lines.some((line) => line.includes("/Users/"))).toBe(false);
		expect(lines[7]).toContain("│");
		expect(lines[8]).toContain("GLM 5.1");
	});

	it("keeps welcome lines within narrow terminal widths after fitting", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 40,
			version: "0.0.0",
			model: "GLM 5.1",
			provider: "zai",
			greeting: "Iron sharpeneth iron.",
		});
		const fitted = lines.map((line) => fitTerminalLine(line, 40));
		const visibleLengths = fitted.map(
			(line) => line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "").length,
		);
		expect(Math.max(...visibleLengths)).toBeLessThanOrEqual(40);
		expect(lines.at(-1)).toContain("Start: Enter");
	});

	it("exposes eight coding-friendly bible greetings and picks them deterministically", () => {
		expect(WELCOME_BIBLE_GREETINGS).toHaveLength(8);
		expect(pickWelcomeGreeting(0)).toBe(WELCOME_BIBLE_GREETINGS[0]);
		expect(pickWelcomeGreeting(0.15)).toBe(WELCOME_BIBLE_GREETINGS[1]);
		expect(pickWelcomeGreeting(0.95)).toBe(WELCOME_BIBLE_GREETINGS[7]);
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

	it("materializes the final assistant transcript block before redraw clears the buffer", () => {
		expect(materializeAssistantTranscriptBlock("hello")).toBe(formatTranscriptAssistantLine("hello"));
		expect(materializeAssistantTranscriptBlock("")).toBeNull();
	});

	it("keeps only the visible transcript tail for full-screen redraw", () => {
		expect(computeVisibleTranscriptLines(["one\ntwo", "three", "four"], 10, 2)).toEqual(["three", "four"]);
		expect(computeVisibleTranscriptLines(["abcdef"], 3, 2)).toEqual(["abc", "def"]);
	});

	it("keeps the compact footer below the welcome card and bottom-anchors active layouts", () => {
		expect(computeFooterStartRow(11, 40, 4, true)).toBe(12);
		expect(computeFooterStartRow(11, 40, 4, false)).toBe(37);
	});

	it("counts rendered footer rows after terminal resize", () => {
		expect(countRenderedTerminalRows(["──────────"], 4)).toBe(3);
		expect(computePromptCursorRowsUp(["──────────", "❯ hello", "──────────"], 4, 6)).toBe(4);
		expect(computeFooterCursorRowsUp(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(7);
		expect(computeFooterCursorRowsFromEnd(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(3);
		expect(computeFooterCursorColumn(4, 6)).toBe(2);
		expect(
			computeInteractiveEphemeralRows(
				{
					lines: ["⏺ hello", "world"],
					renderedWidth: 4,
					startRow: 10,
					reservedRows: 5,
				},
				{
					block: "──────────\n❯ hi\n──────────",
					lines: ["──────────", "❯ hi", "──────────"],
					cursorLineIndex: 1,
					cursorColumn: 4,
					renderedWidth: 4,
				},
			),
		).toBe(8);
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
