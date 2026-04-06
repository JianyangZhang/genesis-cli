const ANSI_CONTROL_SEQUENCE_PATTERN = "\\u001b\\[[0-9;?]*[ -/]*[@-~]";
const ANSI_CONTROL_SEQUENCE_REGEX = new RegExp(ANSI_CONTROL_SEQUENCE_PATTERN, "g");

export function measureTerminalDisplayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += terminalCharWidth(ch);
	}
	return width;
}

export function stripAnsiControlSequences(text: string): string {
	return text.replace(ANSI_CONTROL_SEQUENCE_REGEX, "");
}

export function truncatePlainText(text: string, width: number): string {
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

export function fitTerminalLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const plain = stripAnsiControlSequences(line);
	const visibleWidth = measureTerminalDisplayWidth(plain);
	if (visibleWidth <= safeWidth) {
		return `${line}${" ".repeat(safeWidth - visibleWidth)}`;
	}
	const truncated = truncatePlainText(plain, safeWidth);
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - measureTerminalDisplayWidth(truncated)))}`;
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
