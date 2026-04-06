import { describe, expect, it } from "vitest";
import {
	summarizeFramePatches,
	summarizeScreenFrame,
	summarizeTerminalCapabilities,
	summarizeTerminalModePlan,
} from "../index.js";

describe("render summary", () => {
	it("summarizes terminal capabilities and mode plan", () => {
		expect(
			summarizeTerminalCapabilities({
				hostFamily: "vscode-xtermjs",
				alternateScreen: true,
				mouseTracking: false,
				focusReporting: false,
				bracketedPaste: true,
				synchronizedOutput: true,
				extendedKeys: false,
			}),
		).toMatchObject({
			hostFamily: "vscode-xtermjs",
			alternateScreen: true,
			synchronizedOutput: true,
		});

		expect(
			summarizeTerminalModePlan({
				enter: "abc",
				refresh: "de",
				reenter: "abc",
				exit: "f",
				state: {
					cursorHidden: true,
					alternateScreenActive: true,
					mouseTrackingActive: false,
					focusReportingActive: false,
					bracketedPasteActive: false,
				},
			}),
		).toMatchObject({
			enterLength: 3,
			refreshLength: 2,
			state: { cursorHidden: true },
		});
	});

	it("summarizes frames and patches", () => {
		expect(
			summarizeScreenFrame({
				width: 80,
				height: 24,
				lines: ["hello", "", "world"],
				cursor: { row: 3, column: 5 },
			}),
		).toEqual({
			width: 80,
			height: 24,
			lineCount: 3,
			nonEmptyRows: 2,
			cursor: { row: 3, column: 5 },
		});

		expect(
			summarizeFramePatches([
				{ type: "write-line", row: 1, content: "hello" },
				{ type: "clear-line", row: 2 },
				{ type: "move-cursor", cursor: { row: 3, column: 4 } },
			]),
		).toEqual({
			total: 3,
			writeLineCount: 1,
			clearLineCount: 1,
			moveCursorCount: 1,
		});
	});
});
