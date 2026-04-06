import type { FramePatch, ScrollRegion } from "../types/index.js";

export function encodeFramePatches(patches: readonly FramePatch[], terminalWidth: number): string {
	return patches.map((patch) => encodeFramePatch(patch, terminalWidth)).join("");
}

export function encodeSetScrollRegion(region: ScrollRegion): string {
	return `\x1b[${Math.max(1, region.top)};${Math.max(1, region.bottom)}r`;
}

export function encodeResetScrollRegion(): string {
	return "\x1b[r";
}

function encodeFramePatch(patch: FramePatch, terminalWidth: number): string {
	switch (patch.type) {
		case "write-line":
			return encodeAbsoluteTerminalLine(patch.row, patch.content, terminalWidth);
		case "clear-line":
			return encodeAbsoluteTerminalLine(patch.row, "", terminalWidth);
		case "move-cursor":
			return encodeCursorTo(patch.cursor.row, patch.cursor.column);
	}
}

function encodeAbsoluteTerminalLine(row: number, line: string, terminalWidth: number): string {
	return `${disableAutoWrap()}${encodeCursorTo(row, 1)}${clearLine()}${truncateLine(line, terminalWidth)}${enableAutoWrap()}`;
}

function encodeCursorTo(row: number, column: number): string {
	return `\x1b[${Math.max(1, row)};${Math.max(1, column)}H`;
}

function clearLine(): string {
	return "\x1b[2K\r";
}

function disableAutoWrap(): string {
	return "\x1b[?7l";
}

function enableAutoWrap(): string {
	return "\x1b[?7h";
}

function truncateLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	return line.length > safeWidth ? line.slice(0, safeWidth) : line;
}
