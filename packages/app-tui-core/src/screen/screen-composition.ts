import { createScreenFrame } from "./frame-buffer.js";
import type { ComposedScreen, FooterBlock } from "../types/index.js";

export function composeScreenWithFooter(options: {
	readonly width: number;
	readonly height: number;
	readonly bodyLines: readonly string[];
	readonly footer: FooterBlock;
}): ComposedScreen {
	const width = Math.max(1, options.width);
	const height = Math.max(1, options.height);
	const footerHeight = options.footer.lines.length;
	const footerStartRow = computeFooterStartRow(height, footerHeight, options.bodyLines.length);
	const screenLines = Array.from({ length: height }, () => "");

	for (let index = 0; index < Math.min(options.bodyLines.length, footerStartRow - 1); index += 1) {
		screenLines[index] = options.bodyLines[index] ?? "";
	}

	for (let index = 0; index < footerHeight; index += 1) {
		const row = footerStartRow + index;
		if (row < 1 || row > height) {
			continue;
		}
		screenLines[row - 1] = options.footer.lines[index] ?? "";
	}

	return {
		frame: createScreenFrame({
			width,
			height,
			lines: screenLines,
			cursor: {
				row: footerStartRow + options.footer.cursorLineIndex,
				column: computeFooterCursorColumn(width, options.footer.cursorColumn),
			},
		}),
		footerStartRow,
		pinFooterToBottom: footerStartRow === Math.max(1, height - footerHeight + 1),
	};
}

export function computeFooterStartRow(terminalHeight: number, footerHeight: number, bodyRows: number): number {
	const naturalStartRow = 1 + Math.max(0, bodyRows);
	const bottomAnchoredStartRow = Math.max(1, terminalHeight - footerHeight + 1);
	return Math.min(naturalStartRow, bottomAnchoredStartRow);
}

export function computeFooterCursorColumn(width: number, cursorColumn: number): number {
	const safeWidth = Math.max(1, width);
	return Math.max(1, (cursorColumn % safeWidth) + 1);
}
