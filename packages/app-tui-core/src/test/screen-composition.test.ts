import { describe, expect, it } from "vitest";
import {
	composeScreenWithFooter,
	computeFooterCursorColumn,
	computeFooterStartRow,
} from "../index.js";

describe("screen composition", () => {
	it("pins the footer to the bottom when body content exceeds the viewport", () => {
		const composed = composeScreenWithFooter({
			width: 20,
			height: 5,
			bodyLines: ["1", "2", "3", "4", "5", "6"],
			footer: {
				lines: ["footer-a", "footer-b"],
				cursorLineIndex: 1,
				cursorColumn: 3,
			},
		});

		expect(composed.footerStartRow).toBe(4);
		expect(composed.pinFooterToBottom).toBe(true);
		expect(composed.frame.lines[3]).toBe("footer-a");
		expect(composed.frame.lines[4]).toBe("footer-b");
		expect(composed.frame.cursor).toEqual({ row: 5, column: 4 });
	});

	it("lets the footer float directly after short body content", () => {
		const composed = composeScreenWithFooter({
			width: 20,
			height: 8,
			bodyLines: ["welcome", "transcript"],
			footer: {
				lines: ["footer"],
				cursorLineIndex: 0,
				cursorColumn: 0,
			},
		});

		expect(composed.footerStartRow).toBe(3);
		expect(composed.pinFooterToBottom).toBe(false);
		expect(composed.frame.lines[0]).toBe("welcome");
		expect(composed.frame.lines[1]).toBe("transcript");
		expect(composed.frame.lines[2]).toBe("footer");
	});

	it("exposes footer row and cursor helpers", () => {
		expect(computeFooterStartRow(10, 2, 3)).toBe(4);
		expect(computeFooterCursorColumn(10, 0)).toBe(1);
		expect(computeFooterCursorColumn(10, 14)).toBe(5);
	});
});
