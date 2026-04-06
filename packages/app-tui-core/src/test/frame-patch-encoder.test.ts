import { describe, expect, it } from "vitest";
import { encodeFramePatches, encodeResetScrollRegion, encodeSetScrollRegion } from "../index.js";

describe("frame patch encoder", () => {
	it("encodes line writes, clears, and cursor moves into ANSI output", () => {
		const encoded = encodeFramePatches(
			[
				{ type: "write-line", row: 2, content: "hello" },
				{ type: "clear-line", row: 3 },
				{ type: "move-cursor", cursor: { row: 4, column: 5 } },
			],
			20,
		);

		expect(encoded).toContain("\x1b[?7l");
		expect(encoded).toContain("\x1b[2;1H");
		expect(encoded).toContain("hello");
		expect(encoded).toContain("\x1b[3;1H");
		expect(encoded).toContain("\x1b[4;5H");
	});

	it("encodes scroll-region helpers", () => {
		expect(encodeSetScrollRegion({ top: 1, bottom: 20 })).toBe("\x1b[1;20r");
		expect(encodeResetScrollRegion()).toBe("\x1b[r");
	});

	it("does not clip ANSI-decorated lines by raw string length", () => {
		const line = "\x1b[38;5;236m╭─── Genesis CLI ───╮\x1b[0m";
		const encoded = encodeFramePatches([{ type: "write-line", row: 1, content: line }], 22);

		expect(encoded).toContain("╭─── Genesis CLI ───╮");
		expect(encoded).toContain("\x1b[0m");
	});
});
