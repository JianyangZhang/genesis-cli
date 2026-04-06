import { describe, expect, it } from "vitest";
import {
	computeSelectionColumnsForRow,
	computeVisibleViewportLines,
	extractPlainTextSelection,
	renderSelectedPlainLine,
} from "../index.js";

describe("transcript viewport", () => {
	it("flattens wrapped blocks and slices from the bottom", () => {
		const lines = computeVisibleViewportLines({
			blocks: ["one\ntwo", "three", "four"],
			width: 10,
			maxRows: 2,
			wrapLine: (line) => [line],
		});
		expect(lines).toEqual(["three", "four"]);
	});

	it("supports scrolling upward from the bottom", () => {
		const lines = computeVisibleViewportLines({
			blocks: ["one", "two", "three", "four"],
			width: 10,
			maxRows: 2,
			offsetFromBottom: 1,
			wrapLine: (line) => [line],
		});
		expect(lines).toEqual(["two", "three"]);
	});

	it("computes per-row selection columns across multiple rows", () => {
		expect(computeSelectionColumnsForRow({ startRow: 2, startColumn: 3, endRow: 4, endColumn: 5 }, 2, 10)).toEqual({
			startColumn: 3,
			endColumn: 11,
		});
		expect(computeSelectionColumnsForRow({ startRow: 2, startColumn: 3, endRow: 4, endColumn: 5 }, 3, 10)).toEqual({
			startColumn: 1,
			endColumn: 11,
		});
		expect(computeSelectionColumnsForRow({ startRow: 2, startColumn: 3, endRow: 4, endColumn: 5 }, 4, 10)).toEqual({
			startColumn: 1,
			endColumn: 5,
		});
	});

	it("extracts and renders plain-text selections", () => {
		expect(
			extractPlainTextSelection(["Welcome back", "History line 01", "History line 02"], {
				startRow: 0,
				startColumn: 1,
				endRow: 1,
				endColumn: 8,
			}),
		).toBe("Welcome back\nHistory");
		expect(renderSelectedPlainLine("abcdef", 2, 4, 6)).toContain("\x1b[7m");
	});
});
