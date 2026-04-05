/**
 * Tests for the TUI renderer.
 */

import { describe, expect, it } from "vitest";
import type { ConversationLine, HeaderRegion, StatusLineRegion, TuiScreenLayout } from "../adapters/tui-layout.js";
import {
	ansiClearLine,
	ansiMoveUp,
	ansiResetCursor,
	renderHeader,
	renderScreen,
	renderStatusLine,
} from "../adapters/tui-renderer.js";
import type { InteractionPhase } from "../types/index.js";

describe("renderHeader", () => {
	it("renders model name and session status", () => {
		const header: HeaderRegion = {
			modelName: "Claude 3 Sonnet",
			sessionStatus: "active",
			planStatus: null,
		};
		const result = renderHeader(header, 80);
		expect(result).toContain("Claude 3 Sonnet");
		expect(result).toContain("active");
	});

	it("renders plan status when present", () => {
		const header: HeaderRegion = {
			modelName: "Claude 3",
			sessionStatus: "active",
			planStatus: "Plan: fix bug",
		};
		const result = renderHeader(header, 80);
		expect(result).toContain("fix bug");
	});
});

describe("renderStatusLine", () => {
	it("renders idle phase", () => {
		const status: StatusLineRegion = {
			phase: "idle" as InteractionPhase,
			activeTool: null,
			planProgress: null,
			scrollPosition: null,
		};
		const result = renderStatusLine(status, 80);
		expect(result).toContain("Ready");
	});

	it("renders streaming phase", () => {
		const status: StatusLineRegion = {
			phase: "streaming" as InteractionPhase,
			activeTool: null,
			planProgress: null,
			scrollPosition: null,
		};
		const result = renderStatusLine(status, 80);
		expect(result).toContain("Streaming");
	});

	it("renders active tool name", () => {
		const status: StatusLineRegion = {
			phase: "tool_executing" as InteractionPhase,
			activeTool: "read_file",
			planProgress: null,
			scrollPosition: null,
		};
		const result = renderStatusLine(status, 80);
		expect(result).toContain("read_file");
		expect(result).toContain("Executing tool");
	});

	it("renders plan progress", () => {
		const status: StatusLineRegion = {
			phase: "idle" as InteractionPhase,
			activeTool: null,
			planProgress: "Plan: 2/5",
			scrollPosition: null,
		};
		const result = renderStatusLine(status, 80);
		expect(result).toContain("2/5");
	});

	it("renders scroll position", () => {
		const status: StatusLineRegion = {
			phase: "idle" as InteractionPhase,
			activeTool: null,
			planProgress: null,
			scrollPosition: "Lines 3-20/40",
		};
		const result = renderStatusLine(status, 120);
		expect(result).toContain("Lines 3-20/40");
	});
});

describe("renderScreen", () => {
	it("renders a complete screen with conversation lines", () => {
		const lines: ConversationLine[] = [
			{ type: "text", role: "user", content: "Hello", timestamp: 1000, authorName: "alice" },
			{ type: "text", role: "assistant", content: "Hi there", timestamp: 2000, authorName: "Assistant" },
			{ type: "divider" },
			{
				type: "tool_call",
				toolName: "read_file",
				toolCallId: "tc-1",
				status: "success",
				durationMs: 100,
			},
		];
		const layout: TuiScreenLayout = {
			mode: "interactive",
			header: { modelName: "Test", sessionStatus: "active", planStatus: null },
			conversation: { lines },
			statusLine: { phase: "idle", activeTool: null, planProgress: null, scrollPosition: "Lines 1-4/4" },
		};
		const result = renderScreen(layout, 80);
		expect(result).toContain("Hello");
		expect(result).toContain("Hi there");
		expect(result).toContain("alice");
		expect(result).toContain("read_file");
		expect(result).toContain("Ready");
	});
});

describe("ANSI helpers", () => {
	it("ansiMoveUp produces correct sequence", () => {
		expect(ansiMoveUp(3)).toBe("\x1b[3A");
	});

	it("ansiClearLine produces correct sequence", () => {
		expect(ansiClearLine()).toContain("2K");
	});

	it("ansiResetCursor produces carriage return", () => {
		expect(ansiResetCursor()).toBe("\r");
	});
});
