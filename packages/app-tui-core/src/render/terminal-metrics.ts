const ANSI_CONTROL_SEQUENCE_PATTERN = "\\u001b\\[[0-9;?]*[ -/]*[@-~]";
const ANSI_CONTROL_SEQUENCE_REGEX = new RegExp(ANSI_CONTROL_SEQUENCE_PATTERN, "g");

export function countRenderedTerminalRows(lines: readonly string[], width: number): number {
	const safeWidth = Math.max(1, width);
	let total = 0;
	for (const line of lines) {
		const plain = stripAnsi(line);
		const visibleWidth = Math.max(1, measureTerminalDisplayWidth(plain));
		total += Math.max(1, Math.ceil(visibleWidth / safeWidth));
	}
	return total;
}

export function computePromptCursorRowsUp(lines: readonly string[], width: number, cursorColumn: number): number {
	const safeWidth = Math.max(1, width);
	const rowsBeforePrompt = countRenderedTerminalRows(lines.slice(0, 1), safeWidth);
	const promptRowOffset = Math.floor(Math.max(0, cursorColumn) / safeWidth);
	return rowsBeforePrompt + promptRowOffset;
}

export function computeFooterCursorRowsUp(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	const safeWidth = Math.max(1, width);
	const rowsBeforeCursor = countRenderedTerminalRows(lines.slice(0, cursorLineIndex), safeWidth);
	const cursorRowOffset = Math.floor(Math.max(0, cursorColumn) / safeWidth);
	return rowsBeforeCursor + cursorRowOffset;
}

export function computeFooterCursorRowsFromEnd(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	const totalRows = countRenderedTerminalRows(lines, width);
	const rowsUp = computeFooterCursorRowsUp(lines, width, cursorLineIndex, cursorColumn);
	return Math.max(0, totalRows - rowsUp - 1);
}

export function computeEphemeralRows(
	streaming: { readonly lines: readonly string[]; readonly renderedWidth: number } | null,
	footer: {
		readonly lines: readonly string[];
		readonly renderedWidth: number;
		readonly cursorLineIndex: number;
		readonly cursorColumn: number;
	} | null,
): number {
	const footerRowsUp =
		footer === null
			? 0
			: computeFooterCursorRowsUp(footer.lines, footer.renderedWidth, footer.cursorLineIndex, footer.cursorColumn);
	const streamingRows = streaming === null ? 0 : countRenderedTerminalRows(streaming.lines, streaming.renderedWidth);
	return footerRowsUp + streamingRows;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_CONTROL_SEQUENCE_REGEX, "");
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
