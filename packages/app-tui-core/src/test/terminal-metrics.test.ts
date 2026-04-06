import { describe, expect, it } from "vitest";
import {
	computeEphemeralRows,
	computeFooterCursorRowsFromEnd,
	computeFooterCursorRowsUp,
	computePromptCursorRowsUp,
	countRenderedTerminalRows,
} from "../index.js";

describe("terminal metrics", () => {
	it("counts rendered rows after wrapping ANSI-stripped text", () => {
		expect(countRenderedTerminalRows(["──────────"], 4)).toBe(3);
		expect(countRenderedTerminalRows(["\x1b[32mhello\x1b[0m"], 4)).toBe(2);
	});

	it("computes prompt and footer cursor rows", () => {
		expect(computePromptCursorRowsUp(["──────────", "❯ hello", "──────────"], 4, 6)).toBe(4);
		expect(computeFooterCursorRowsUp(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(7);
		expect(computeFooterCursorRowsFromEnd(["· Thinking…", "──────────", "❯ hello", "──────────"], 4, 2, 6)).toBe(3);
	});

	it("combines streaming and footer rows into ephemeral height", () => {
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
});
