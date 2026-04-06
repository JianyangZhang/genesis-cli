export function wrapTranscriptContent(content: string, width: number): readonly string[] {
	if (content.length === 0) {
		return [""];
	}
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const ch of content.replace(/\r\n/g, "\n")) {
		if (ch === "\n") {
			lines.push(current);
			current = "";
			currentWidth = 0;
			continue;
		}
		const charWidth = measureTerminalDisplayWidth(ch);
		if (currentWidth + charWidth > safeWidth && current.length > 0) {
			lines.push(current);
			current = ch;
			currentWidth = charWidth;
			continue;
		}
		current += ch;
		currentWidth += charWidth;
	}
	lines.push(current);
	return lines;
}

export function flattenTranscriptLines(
	blocks: readonly string[],
	width: number,
	unwrappedLeadingBlockCount = 0,
): string[] {
	const flattened: string[] = [];
	for (const [index, block] of blocks.entries()) {
		for (const logicalLine of block.split("\n")) {
			if (index < unwrappedLeadingBlockCount) {
				flattened.push(logicalLine);
				continue;
			}
			flattened.push(...wrapTranscriptContent(logicalLine, width));
		}
	}
	return flattened;
}

export function computeTranscriptDisplayRows(
	blocks: readonly string[],
	width: number,
	unwrappedLeadingBlockCount = 0,
): number {
	return flattenTranscriptLines(blocks, width, unwrappedLeadingBlockCount).length;
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
