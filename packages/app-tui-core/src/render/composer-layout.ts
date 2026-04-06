import { computePromptCursorColumn } from "./composer-metrics.js";

export interface ComposerBlockLayout {
	readonly lines: readonly string[];
	readonly cursorLineIndex: number;
	readonly cursorColumn: number;
}

export interface RenderedComposerBlock extends ComposerBlockLayout {
	readonly block: string;
	readonly renderedWidth: number;
}

export interface RenderedTextBlock {
	readonly block: string;
	readonly lines: readonly string[];
}

export function composeSectionBlock(options: {
	readonly leadingLines?: readonly string[];
	readonly separator?: string;
	readonly bodyLines?: readonly string[];
	readonly trailingSeparator?: boolean;
}): readonly string[] {
	const lines: string[] = [];
	const leadingLines = options.leadingLines ?? [];
	const bodyLines = options.bodyLines ?? [];
	if (leadingLines.length > 0) {
		lines.push(...leadingLines);
	}
	if (options.separator && (leadingLines.length > 0 || bodyLines.length > 0)) {
		lines.push(options.separator);
	}
	if (bodyLines.length > 0) {
		lines.push(...bodyLines);
	}
	if (options.separator && (options.trailingSeparator ?? false) && (leadingLines.length > 0 || bodyLines.length > 0)) {
		lines.push(options.separator);
	}
	return lines;
}

export function composePromptBlock(options: {
	readonly leadingLines: readonly string[];
	readonly separator: string;
	readonly bodyLines?: readonly string[];
	readonly prompt: string;
	readonly buffer: string;
	readonly cursor: number;
	readonly hint?: string;
	readonly trailingSeparator?: boolean;
}): ComposerBlockLayout {
	const lines = [
		...composeSectionBlock({
			leadingLines: options.leadingLines,
			separator: options.separator,
			bodyLines: options.bodyLines,
		}),
		`${options.prompt}${options.buffer}${options.hint ?? ""}`,
	];
	const trailingSeparator = options.trailingSeparator ?? true;
	if (trailingSeparator) {
		lines.push(options.separator);
	}
	return {
		lines,
		cursorLineIndex: trailingSeparator ? lines.length - 2 : lines.length - 1,
		cursorColumn: computePromptCursorColumn(options.prompt, options.buffer, options.cursor),
	};
}

export function materializeComposerBlock(
	layout: ComposerBlockLayout,
	renderedWidth: number,
): RenderedComposerBlock {
	return {
		block: layout.lines.join("\n"),
		lines: layout.lines,
		cursorLineIndex: layout.cursorLineIndex,
		cursorColumn: layout.cursorColumn,
		renderedWidth: Math.max(1, renderedWidth),
	};
}

export function materializeTextBlock(lines: readonly string[]): RenderedTextBlock {
	return {
		block: lines.join("\n"),
		lines,
	};
}
