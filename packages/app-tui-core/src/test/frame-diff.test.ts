import { describe, expect, it } from "vitest";
import { createScreenFrame, diffScreenFrames } from "../index.js";

describe("screen frame diff", () => {
	it("emits a full redraw when there is no previous frame", () => {
		const next = createScreenFrame({
			width: 10,
			height: 3,
			lines: ["hello", "", "world"],
			cursor: { row: 3, column: 6 },
		});

		expect(diffScreenFrames(null, next)).toEqual([
			{ type: "write-line", row: 1, content: "hello" },
			{ type: "clear-line", row: 2 },
			{ type: "write-line", row: 3, content: "world" },
			{ type: "move-cursor", cursor: { row: 3, column: 6 } },
		]);
	});

	it("emits only changed lines for matching frame sizes", () => {
		const previous = createScreenFrame({
			width: 10,
			height: 3,
			lines: ["hello", "middle", "world"],
			cursor: { row: 3, column: 6 },
		});
		const next = createScreenFrame({
			width: 10,
			height: 3,
			lines: ["hello", "", "world!"],
			cursor: { row: 1, column: 3 },
		});

		expect(diffScreenFrames(previous, next)).toEqual([
			{ type: "clear-line", row: 2 },
			{ type: "write-line", row: 3, content: "world!" },
			{ type: "move-cursor", cursor: { row: 1, column: 3 } },
		]);
	});
});
