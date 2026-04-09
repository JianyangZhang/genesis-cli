export function computeBodyViewportRows(terminalHeight: number, headerRows: number, footerRows: number): number {
	const clampedHeaderRows = Math.min(headerRows, Math.max(0, terminalHeight - footerRows));
	return Math.max(0, terminalHeight - clampedHeaderRows - footerRows);
}

export function computeMaxScrollOffset(totalRows: number, viewportRows: number): number {
	return Math.max(0, totalRows - Math.max(0, viewportRows));
}

export function clampScrollOffset(offset: number, maxScroll: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, maxScroll)));
}

export function ensureVisibleSelectionOffset(options: {
	readonly currentOffset: number;
	readonly viewportRows: number;
	readonly selectedRange: { readonly start: number; readonly end: number } | null;
}): number {
	if (!options.selectedRange) {
		return options.currentOffset;
	}
	const viewportRows = Math.max(1, options.viewportRows);
	if (options.selectedRange.start < options.currentOffset) {
		return options.selectedRange.start;
	}
	if (options.selectedRange.end >= options.currentOffset + viewportRows) {
		return options.selectedRange.end - viewportRows + 1;
	}
	return options.currentOffset;
}
