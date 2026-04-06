import type { TerminalSelectionColumns, TerminalSelectionRange } from "../types/index.js";

export function computeVisibleViewportLines(options: {
	readonly blocks: readonly string[];
	readonly width: number;
	readonly maxRows: number;
	readonly offsetFromBottom?: number;
	readonly unwrappedLeadingBlockCount?: number;
	readonly wrapLine: (line: string, width: number) => readonly string[];
}): readonly string[] {
	if (options.maxRows <= 0 || options.blocks.length === 0) {
		return [];
	}
	const flattened = flattenTranscriptLines(
		options.blocks,
		options.width,
		options.wrapLine,
		options.unwrappedLeadingBlockCount ?? 0,
	);
	if (flattened.length <= options.maxRows) {
		return flattened;
	}
	const maxOffset = Math.max(0, flattened.length - options.maxRows);
	const clampedOffset = Math.max(0, Math.min(options.offsetFromBottom ?? 0, maxOffset));
	const end = flattened.length - clampedOffset;
	const start = Math.max(0, end - options.maxRows);
	return flattened.slice(start, end);
}

export function computeSelectionColumnsForRow(
	selection: TerminalSelectionRange | null,
	row: number,
	width: number,
): TerminalSelectionColumns | null {
	if (selection === null) {
		return null;
	}
	const startFirst =
		selection.startRow < selection.endRow ||
		(selection.startRow === selection.endRow && selection.startColumn <= selection.endColumn);
	const start = startFirst
		? { row: selection.startRow, column: selection.startColumn }
		: { row: selection.endRow, column: selection.endColumn };
	const end = startFirst
		? { row: selection.endRow, column: selection.endColumn }
		: { row: selection.startRow, column: selection.startColumn };
	if (row < start.row || row > end.row) {
		return null;
	}
	if (start.row === end.row) {
		return {
			startColumn: Math.min(start.column, end.column),
			endColumn: Math.max(start.column, end.column),
		};
	}
	if (row === start.row) {
		return {
			startColumn: start.column,
			endColumn: Math.max(1, width) + 1,
		};
	}
	if (row === end.row) {
		return {
			startColumn: 1,
			endColumn: end.column,
		};
	}
	return {
		startColumn: 1,
		endColumn: Math.max(1, width) + 1,
	};
}

export function extractPlainTextSelection(
	lines: readonly string[],
	selection: TerminalSelectionRange,
): string {
	if (lines.length === 0) {
		return "";
	}
	const startFirst =
		selection.startRow < selection.endRow ||
		(selection.startRow === selection.endRow && selection.startColumn <= selection.endColumn);
	const start = startFirst
		? { row: selection.startRow, column: selection.startColumn }
		: { row: selection.endRow, column: selection.endColumn };
	const end = startFirst
		? { row: selection.endRow, column: selection.endColumn }
		: { row: selection.startRow, column: selection.startColumn };
	const selectedLines: string[] = [];
	for (let row = start.row; row <= end.row; row += 1) {
		const line = lines[row] ?? "";
		const fromColumn = row === start.row ? start.column : 1;
		const toColumn = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
		selectedLines.push(slicePlainTextByDisplayColumns(line, fromColumn - 1, toColumn - 1));
	}
	return selectedLines
		.join("\n")
		.replace(/\s+$/g, "")
		.replace(/\n[ \t]+$/gm, "");
}

export function renderSelectedPlainLine(
	line: string,
	startColumn: number,
	endColumn: number,
	width: number,
): string {
	const safeStart = Math.max(1, Math.min(startColumn, endColumn));
	const safeEnd = Math.max(safeStart, Math.max(startColumn, endColumn));
	const before = slicePlainTextByDisplayColumns(line, 0, safeStart - 1);
	const selected = slicePlainTextByDisplayColumns(line, safeStart - 1, safeEnd - 1);
	const after = slicePlainTextByDisplayColumns(line, safeEnd - 1, Number.MAX_SAFE_INTEGER);
	return fitStyledLine(`${before}\x1b[7m${selected.length > 0 ? selected : " "}\x1b[0m${after}`, width);
}

function flattenTranscriptLines(
	blocks: readonly string[],
	width: number,
	wrapLine: (line: string, width: number) => readonly string[],
	unwrappedLeadingBlockCount: number,
): string[] {
	const flattened: string[] = [];
	for (const [index, block] of blocks.entries()) {
		for (const logicalLine of block.split("\n")) {
			if (index < unwrappedLeadingBlockCount) {
				flattened.push(logicalLine);
				continue;
			}
			flattened.push(...wrapLine(logicalLine, width));
		}
	}
	return flattened;
}

function fitStyledLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const plain = stripAnsi(line);
	const visibleWidth = measureTerminalDisplayWidth(plain);
	if (visibleWidth <= safeWidth) {
		return `${line}${" ".repeat(safeWidth - visibleWidth)}`;
	}
	const truncated = truncatePlainText(plain, safeWidth);
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - measureTerminalDisplayWidth(truncated)))}`;
}

function truncatePlainText(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	let output = "";
	let used = 0;
	for (const ch of text) {
		const charWidth = measureTerminalDisplayWidth(ch);
		if (used + charWidth > safeWidth) {
			break;
		}
		output += ch;
		used += charWidth;
	}
	return output;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function slicePlainTextByDisplayColumns(text: string, startColumn: number, endColumnExclusive: number): string {
	const start = Math.max(0, startColumn);
	const end = Math.max(start, endColumnExclusive);
	let output = "";
	let used = 0;
	for (const ch of text) {
		const charWidth = measureTerminalDisplayWidth(ch);
		const nextUsed = used + charWidth;
		if (nextUsed > start && used < end) {
			output += ch;
		}
		if (used >= end) {
			break;
		}
		used = nextUsed;
	}
	return output;
}

function measureTerminalDisplayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += terminalCharWidth(ch);
	}
	return width;
}

function terminalCharWidth(ch: string): number {
	if (ch === "\t") return 4;
	if (ch <= "\u001f" || ch === "\u007f") return 0;
	const codePoint = ch.codePointAt(0) ?? 0;
	if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2329 && codePoint <= 0x232a) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff)
	) {
		return 2;
	}
	return 1;
}
