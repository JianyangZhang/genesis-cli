import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	computeEphemeralRows,
	computeFooterCursorColumn,
	computeFooterCursorRowsFromEnd,
	computeFooterCursorRowsUp,
	computeFooterStartRow,
	computePromptCursorRowsUp,
	computeTranscriptDisplayRows,
	countRenderedTerminalRows,
	extractPlainTextSelection,
	fitTerminalLine,
	truncatePlainText,
	wrapTranscriptContent,
} from "@pickle-pee/tui-core";
import {
	appendAssistantTranscriptBlock,
	appendTranscriptBlockWithSpacer,
	buildInteractiveFooterLeadingLines,
	computeInteractiveFooterSeparatorWidth,
	formatFullWidthTranscriptUserLine,
	formatInteractiveErrorDetailLine,
	formatInteractiveErrorLine,
	formatInteractiveInfoLine,
	formatInteractiveInputSeparator,
	formatInteractivePromptBuffer,
	formatTranscriptAssistantLine,
	formatTranscriptUserBlocks,
	formatTranscriptUserLine,
	formatTurnNotice,
	INTERACTIVE_THEME,
	materializeAssistantTranscriptBlock,
	mergeStreamingText,
} from "@pickle-pee/ui";
import { describe, expect, it, vi } from "vitest";
import {
	acceptFirstSlashSuggestion,
	buildWelcomeLines,
	computeSlashSuggestions,
	computeVisibleTranscriptLines,
	createDebouncedCallback,
	formatInteractiveFooter,
	formatInteractivePermissionBlock,
	formatInteractiveToolEvent,
	formatInteractiveToolResult,
	formatInteractiveToolTitle,
	formatSlashSuggestionHint,
	formatWelcomeBottomBorder,
	formatWelcomeCenteredLine,
	formatWelcomeFilledLine,
	formatWelcomeTopBorder,
	movePermissionSelection,
	permissionDecisionFromSelection,
	pickWelcomeGreeting,
	readInteractiveCliPackageVersion,
	shouldRenderInteractiveTranscriptEvent,
	WELCOME_BIBLE_GREETINGS,
} from "../mode-dispatch.js";

function formatLocalTraceTimestamp(value: Date): string {
	const padTwo = (part: number): string => String(part).padStart(2, "0");
	return (
		`${value.getFullYear()}${padTwo(value.getMonth() + 1)}${padTwo(value.getDate())}` +
		`T${padTwo(value.getHours())}${padTwo(value.getMinutes())}${padTwo(value.getSeconds())}`
	);
}

describe("interactive transcript formatting", () => {
	it("formats user lines as a compact highlighted block", () => {
		const line = formatTranscriptUserLine("Hello");
		expect(line).toContain("Hello");
		expect(line).toContain("\x1b[48;5;252m");
	});

	it("splits queued user batches into independent highlighted blocks", () => {
		expect(formatTranscriptUserBlocks("queued part one\n\nqueued part two")).toEqual([
			formatTranscriptUserLine("queued part one"),
			formatTranscriptUserLine("queued part two"),
		]);
	});

	it("pads highlighted user lines to the full terminal width", () => {
		const line = formatFullWidthTranscriptUserLine(" 你好 ", 12);
		const visible = line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		expect([...visible].reduce((width, ch) => width + (ch === "你" || ch === "好" ? 2 : 1), 0)).toBe(12);
		expect(line.startsWith("\x1b[48;5;252m")).toBe(true);
		expect(line.endsWith("\x1b[0m")).toBe(true);
	});

	it("formats assistant lines with a themed bullet prefix", () => {
		const line = formatTranscriptAssistantLine("Hello");
		expect(line).toContain("⏺");
		expect(line).toContain("Hello");
	});

	it("formats startup info and error lines with themed colors", () => {
		expect(formatInteractiveInfoLine("Running startup checks...")).toContain(INTERACTIVE_THEME.brand);
		expect(formatInteractiveInfoLine("Fix the configuration, then press Enter to retry.")).toContain(
			INTERACTIVE_THEME.brand,
		);
		const errorLine = formatInteractiveErrorLine("Invalid settings.json");
		expect(errorLine).toContain("Error:");
		expect(errorLine).toContain(INTERACTIVE_THEME.warningSoft);
		expect(errorLine).toContain(INTERACTIVE_THEME.bold);
		expect(formatInteractiveErrorDetailLine("Invalid settings.json")).toContain(INTERACTIVE_THEME.warningSoft);
	});

	it("keeps the live interactive prompt buffer unstyled", () => {
		expect(formatInteractivePromptBuffer("Hello")).toBe("Hello");
	});

	it("formats a full-width separator for the input area", () => {
		expect(formatInteractiveInputSeparator(5)).toContain("─────");
	});

	it("builds footer leading lines from turn notices, usage, detail panel, and queued inputs", () => {
		const lines = buildInteractiveFooterLeadingLines({
			terminalWidth: 80,
			turnNotice: null,
			lastTurnUsage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
			sessionUsage: { input: 2400, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: 3000 },
			detailPanelSummary: "2 files changed",
			detailPanelExpanded: true,
			detailPanelLines: ["- file-a.ts", "- file-b.ts"],
			queuedInputs: ["follow-up question"],
			truncateText: truncatePlainText,
		});

		expect(lines.some((line) => line.includes("Last turn"))).toBe(true);
		expect(lines.some((line) => line.includes("Session"))).toBe(true);
		expect(lines.some((line) => line.includes("2 files changed"))).toBe(true);
		expect(lines.some((line) => line.includes("Queued"))).toBe(true);
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

	it("omits the provider label when the welcome model has no provider", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 80,
			version: "0.0.0",
			model: "GLM 5.1",
			provider: "",
			greeting: "Let there be light.",
		});

		expect(lines[8]).toContain("GLM 5.1");
		expect(lines[8]).not.toContain("via");
	});

	it("keeps the model line centered when the provider label is omitted", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 80,
			version: "0.0.0",
			model: "glm-5.1",
			provider: "",
			greeting: "Let there be light.",
		});
		const stripAnsi = (line: string): string =>
			line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		const centeredVisible = stripAnsi(lines[8] ?? "");

		expect(centeredVisible).toContain("glm-5.1");
		expect(centeredVisible).toMatch(/^│\s+glm-5\.1\s+│$/);
	});

	it("shows debug trace information in the welcome buffer when provided", () => {
		const traceId = `${formatLocalTraceTimestamp(new Date("2026-04-06T12:00:00.000Z"))}-p123-abcdef12`;
		const lines = buildWelcomeLines({
			terminalWidth: 80,
			version: "0.0.0",
			model: "GLM 5.1",
			provider: "zai",
			greeting: "Let there be light.",
			debugTraceId: traceId,
		});
		expect(lines.some((line) => line.includes(`Debug trace: ${traceId}`))).toBe(true);
	});

	it("reapplies border styling after styled title segments in the top border", () => {
		const line = formatWelcomeTopBorder(80, "0.0.2");
		expect(line).toContain(`${INTERACTIVE_THEME.reset}${INTERACTIVE_THEME.welcomeBorder} `);
		expect(line.endsWith(`╮${INTERACTIVE_THEME.reset}`)).toBe(true);
	});

	it("reads the interactive CLI package version from app-cli package.json", () => {
		const packageJsonPath = resolve(__dirname, "../../package.json");
		const expectedVersion = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
		expect(readInteractiveCliPackageVersion(packageJsonPath)).toBe(expectedVersion.version);
	});

	it("keeps interactive host detached from legacy app-ui ANSI compatibility exports", () => {
		const sourcePath = resolve(__dirname, "../mode-dispatch.ts");
		const source = readFileSync(sourcePath, "utf8");
		expect(source).not.toContain("legacyTuiCompat");
		expect(source).not.toContain("ansiShowCursor,");
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
		expect(lines.at(-2)).toContain("Start: Enter");
		expect(lines.at(-2)).toContain("Help: /help");
		expect(lines.at(-2)).toContain("Exit: /exit");
		expect(lines.at(-2)).not.toContain("Scroll:");
		expect(lines.at(-1)).toBe("");
	});

	it("keeps the welcome card at a fixed width before narrow-screen fitting", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 40,
			version: "0.0.2",
			model: "GLM-5.1",
			provider: "zai",
			greeting: "A wise man will hear.",
		});
		const stripAnsi = (line: string): string =>
			line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
		expect(stripAnsi(lines[0] ?? "")).toHaveLength(80);
		expect(stripAnsi(lines[1] ?? "")).toHaveLength(80);
		expect(stripAnsi(lines[8] ?? "")).toHaveLength(80);
		expect(lines.at(-2)).toContain("Start: Enter");
	});

	it("does not wrap fixed-width welcome rows inside transcript layout", () => {
		const lines = buildWelcomeLines({
			terminalWidth: 40,
			version: "0.0.2",
			model: "GLM-5.1",
			provider: "zai",
			greeting: "A wise man will hear.",
		});
		expect(computeTranscriptDisplayRows(lines.slice(0, 10), 40, 10)).toBe(10);
		expect(computeVisibleTranscriptLines(lines.slice(0, 3), 40, 3, 0, 3)).toHaveLength(3);
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
		expect(formatTurnNotice("thinking", { animationFrame: 0 })).toContain("Thinking.");
		expect(formatTurnNotice("thinking", { animationFrame: 1 })).toContain("Thinking..");
		expect(formatTurnNotice("thinking", { animationFrame: 2 })).toContain("Thinking...");
		expect(formatTurnNotice("thinking", { elapsedMs: 2500 })).toContain("2s");
		expect(formatTurnNotice("thinking", { elapsedMs: 105000 })).toContain("1m 45s");
		expect(
			formatTurnNotice("thinking", {
				usage: { input: 1200, output: 345, cacheRead: 0, cacheWrite: 0, totalTokens: 1545 },
			}),
		).toContain("↓ 345 tokens");
		expect(formatTurnNotice("thinking", { queuedCount: 2 })).toContain("2 queued");
		expect(formatTurnNotice("responding", { animationFrame: 0 })).toContain("Responding.");
		expect(formatTurnNotice("responding", { animationFrame: 1 })).toContain("Responding..");
		expect(formatTurnNotice("responding", { animationFrame: 2 })).toContain("Responding...");
		expect(formatTurnNotice("responding", { elapsedMs: 2500 })).toContain("2s");
		expect(formatTurnNotice("responding", { showPendingOutputIndicator: true })).toContain("↓");
		expect(
			formatTurnNotice("tool", {
				animationFrame: 0,
				elapsedMs: 2500,
				toolLabel: "Running Bash(ls -la)",
			}),
		).toContain("Running Bash(ls -la).");
	});

	it("shows queued prompt previews in the footer", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "thinking",
			turnNoticeAnimationFrame: 1,
			queuedInputs: ["second prompt", "third prompt"],
			permission: null,
		});
		expect(footer.block).toContain("second prompt");
		expect(footer.block).toContain("third prompt");
		expect(footer.block).toContain("2 queued");
	});

	it("shows last-turn and session usage summaries when idle", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: null,
			lastTurnUsage: { input: 120, output: 24, cacheRead: 0, cacheWrite: 0, totalTokens: 144 },
			sessionUsage: { input: 210, output: 57, cacheRead: 0, cacheWrite: 0, totalTokens: 267 },
			permission: null,
		});
		expect(footer.block).toContain("Last turn");
		expect(footer.block).toContain("Session");
		expect(footer.block).toContain("↓ 24 tokens");
		expect(footer.block).toContain("↓ 57 tokens");
	});

	it("shows active tool status in the footer", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "tool",
			turnNoticeAnimationFrame: 1,
			elapsedMs: 2500,
			currentTurnUsage: { input: 240, output: 32, cacheRead: 0, cacheWrite: 0, totalTokens: 272 },
			activeToolLabel: "Running Bash(ls -la)",
			permission: null,
		});
		expect(footer.block).toContain("Running Bash(ls -la)..");
		expect(footer.block).toContain("↓ 32 tokens");
	});

	it("shows compacting status in the footer", () => {
		const footer = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "compacting",
			turnNoticeAnimationFrame: 1,
			elapsedMs: 2500,
			permission: null,
		});
		expect(footer.block).toContain("Compacting..");
		expect(footer.block).toContain("2s");
	});

	it("shows thinking detail panel hints and expanded content", () => {
		const collapsed = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "thinking",
			turnNoticeAnimationFrame: 0,
			detailPanelExpanded: false,
			detailPanelSummary: "ctrl+o to expand",
			detailPanelLines: ["Let me plan this carefully."],
			permission: null,
		});
		expect(collapsed.block).toContain("ctrl+o to expand");
		expect(collapsed.block).not.toContain("Let me plan this carefully.");

		const expanded = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "thinking",
			turnNoticeAnimationFrame: 0,
			detailPanelExpanded: true,
			detailPanelSummary: "esc to collapse · ↑↓",
			detailPanelLines: ["Let me plan this carefully."],
			permission: null,
		});
		expect(expanded.block).toContain("esc to collapse");
		expect(expanded.block).toContain("↑↓");
		expect(expanded.block).toContain("Let me plan this carefully.");
	});

	it("renders detail panel scroll summary", () => {
		const expanded = formatInteractiveFooter({
			terminalWidth: 80,
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
			suggestions: [],
			turnNotice: "thinking",
			turnNoticeAnimationFrame: 0,
			detailPanelExpanded: true,
			detailPanelSummary: "esc to collapse · ↑↓ · 1-16/24",
			detailPanelLines: ["Thinking line 1", "Thinking line 2"],
			permission: null,
		});
		expect(expanded.block).toContain("1-16/24");
	});

	it("debounces repeated callbacks and supports cancellation", () => {
		vi.useFakeTimers();
		try {
			const callback = vi.fn();
			const debounced = createDebouncedCallback(callback, 100);
			debounced.schedule();
			debounced.schedule();
			vi.advanceTimersByTime(99);
			expect(callback).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(callback).toHaveBeenCalledTimes(1);

			callback.mockClear();
			debounced.schedule();
			debounced.cancel();
			vi.runAllTimers();
			expect(callback).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("wraps transcript content for streaming redraw", () => {
		expect(wrapTranscriptContent("abcdef", 3)).toEqual(["abc", "def"]);
		expect(wrapTranscriptContent("你好吗", 4)).toEqual(["你好", "吗"]);
	});

	it("materializes the final assistant transcript block before redraw clears the buffer", () => {
		expect(materializeAssistantTranscriptBlock("hello")).toBe("⏺ hello");
		expect(materializeAssistantTranscriptBlock("")).toBeNull();
	});

	it("inserts a spacer row uniformly between transcript blocks", () => {
		expect(
			appendAssistantTranscriptBlock([formatTranscriptUserLine("Hello")], formatTranscriptAssistantLine("World")),
		).toEqual([formatTranscriptUserLine("Hello"), "", formatTranscriptAssistantLine("World")]);
		expect(
			appendAssistantTranscriptBlock(
				[formatTranscriptAssistantLine("Before")],
				formatTranscriptAssistantLine("After"),
			),
		).toEqual([formatTranscriptAssistantLine("Before"), "", formatTranscriptAssistantLine("After")]);
		expect(appendTranscriptBlockWithSpacer(["first"], "second")).toEqual(["first", "", "second"]);
	});

	it("keeps only the visible transcript tail for full-screen redraw", () => {
		expect(computeVisibleTranscriptLines(["one\ntwo", "three", "four"], 10, 2)).toEqual(["three", "four"]);
		expect(computeVisibleTranscriptLines(["abcdef"], 3, 2)).toEqual(["abc", "def"]);
		expect(computeVisibleTranscriptLines(["one", "two", "three", "four"], 10, 2, 1)).toEqual(["two", "three"]);
		expect(computeVisibleTranscriptLines(["one", "two", "three", "four"], 10, 2, 99)).toEqual(["one", "two"]);
		expect(computeTranscriptDisplayRows(["one\ntwo", "three"], 10)).toBe(3);
	});

	it("extracts plain-text selections across transcript rows", () => {
		expect(
			extractPlainTextSelection(["Welcome back", "History line 01", "History line 02"], {
				startRow: 0,
				startColumn: 9,
				endRow: 1,
				endColumn: 8,
			}),
		).toBe("back\nHistory");
		expect(
			extractPlainTextSelection(["abcdef"], {
				startRow: 0,
				startColumn: 2,
				endRow: 0,
				endColumn: 5,
			}),
		).toBe("bcd");
	});

	it("keeps the footer close to short transcript content before bottom-anchoring", () => {
		expect(computeFooterStartRow(40, 4, 11)).toBe(12);
		expect(computeFooterStartRow(40, 4, 12)).toBe(13);
		expect(computeFooterStartRow(40, 4, 41)).toBe(37);
	});

	it("counts rendered footer rows after terminal resize", () => {
		expect(countRenderedTerminalRows(["──────────"], 4)).toBe(3);
		expect(computePromptCursorRowsUp(["──────────", "❯ hello", "──────────"], 4, 6)).toBe(4);
		expect(computeFooterCursorRowsUp(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(7);
		expect(computeFooterCursorRowsFromEnd(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(3);
		expect(computeFooterCursorColumn(4, 6)).toBe(3);
		expect(
			computeEphemeralRows(
				{
					lines: ["⏺ hello", "world"],
					renderedWidth: 4,
				},
				{
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
		{ name: "review", description: "", type: "local" as const },
		{ name: "status", description: "", type: "local" as const },
		{ name: "resume", description: "", type: "local" as const },
	];

	it("suggests commands when the user types a slash prefix", () => {
		expect(computeSlashSuggestions("/", commands)).toEqual(["help", "resume", "review", "status"]);
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
		expect(acceptFirstSlashSuggestion({ buffer: "/st", cursor: 3 }, ["status", "review"])).toEqual({
			buffer: "/status ",
			cursor: 8,
		});
	});

	it("does not accept a suggestion once arguments have started", () => {
		expect(acceptFirstSlashSuggestion({ buffer: "/status now", cursor: 11 }, ["status"])).toBeNull();
	});
});
