import { measureTerminalDisplayWidth, stripAnsiControlSequences, truncatePlainText } from "../render/text-primitives.js";
import type { ScreenCursor, ScreenFrame } from "../types/index.js";

export function createScreenFrame(options: {
	readonly width: number;
	readonly height: number;
	readonly lines: readonly string[];
	readonly cursor?: ScreenCursor;
}): ScreenFrame {
	const width = Math.max(1, options.width);
	const height = Math.max(1, options.height);
	const lines = normalizeLines(options.lines, width, height);
	const cursor = clampCursor(
		options.cursor ?? {
			row: Math.min(height, lines.length),
			column: 1,
		},
		width,
		height,
	);

	return {
		width,
		height,
		lines,
		cursor,
	};
}

function normalizeLines(lines: readonly string[], width: number, height: number): readonly string[] {
	const normalized = lines.slice(0, height).map((line) => truncateLine(line, width));
	while (normalized.length < height) {
		normalized.push("");
	}
	return normalized;
}

function clampCursor(cursor: ScreenCursor, width: number, height: number): ScreenCursor {
	return {
		row: Math.max(1, Math.min(cursor.row, height)),
		column: Math.max(1, Math.min(cursor.column, width)),
	};
}

function truncateLine(line: string, width: number): string {
	const plain = stripAnsiControlSequences(line);
	return measureTerminalDisplayWidth(plain) > width ? truncatePlainText(plain, width) : line;
}
