import { describe, expect, it } from "vitest";
import {
	clampScrollOffset,
	computeBodyViewportRows,
	computeMaxScrollOffset,
	ensureVisibleSelectionOffset,
} from "../render/interactive-viewport.js";

describe("interactive viewport helpers", () => {
	it("computes body viewport rows from terminal/header/footer", () => {
		expect(computeBodyViewportRows(24, 4, 3)).toBe(17);
		expect(computeBodyViewportRows(5, 10, 3)).toBe(0);
	});

	it("clamps scroll offsets", () => {
		expect(computeMaxScrollOffset(20, 8)).toBe(12);
		expect(clampScrollOffset(-2, 12)).toBe(0);
		expect(clampScrollOffset(99, 12)).toBe(12);
	});

	it("adjusts offset so selected range stays visible", () => {
		expect(
			ensureVisibleSelectionOffset({
				currentOffset: 5,
				viewportRows: 6,
				selectedRange: { start: 3, end: 4 },
			}),
		).toBe(3);
		expect(
			ensureVisibleSelectionOffset({
				currentOffset: 5,
				viewportRows: 6,
				selectedRange: { start: 12, end: 14 },
			}),
		).toBe(9);
	});
});
