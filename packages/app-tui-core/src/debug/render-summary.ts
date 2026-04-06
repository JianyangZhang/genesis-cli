import type { FramePatch, ScreenFrame, TerminalCapabilities, TerminalModePlan } from "../types/index.js";

export function summarizeTerminalCapabilities(capabilities: TerminalCapabilities): Record<string, unknown> {
	return {
		hostFamily: capabilities.hostFamily,
		alternateScreen: capabilities.alternateScreen,
		mouseTracking: capabilities.mouseTracking,
		focusReporting: capabilities.focusReporting,
		bracketedPaste: capabilities.bracketedPaste,
		synchronizedOutput: capabilities.synchronizedOutput,
		extendedKeys: capabilities.extendedKeys,
	};
}

export function summarizeTerminalModePlan(plan: TerminalModePlan): Record<string, unknown> {
	return {
		enterLength: plan.enter.length,
		refreshLength: plan.refresh.length,
		reenterLength: plan.reenter.length,
		exitLength: plan.exit.length,
		state: {
			cursorHidden: plan.state.cursorHidden,
			alternateScreenActive: plan.state.alternateScreenActive,
			mouseTrackingActive: plan.state.mouseTrackingActive,
			focusReportingActive: plan.state.focusReportingActive,
			bracketedPasteActive: plan.state.bracketedPasteActive,
		},
	};
}

export function summarizeScreenFrame(frame: ScreenFrame): Record<string, unknown> {
	const nonEmptyRows = frame.lines.reduce((count, line) => count + (line.length > 0 ? 1 : 0), 0);
	return {
		width: frame.width,
		height: frame.height,
		lineCount: frame.lines.length,
		nonEmptyRows,
		cursor: frame.cursor,
	};
}

export function summarizeFramePatches(patches: readonly FramePatch[]): Record<string, unknown> {
	let writeLineCount = 0;
	let clearLineCount = 0;
	let moveCursorCount = 0;
	for (const patch of patches) {
		if (patch.type === "write-line") {
			writeLineCount += 1;
			continue;
		}
		if (patch.type === "clear-line") {
			clearLineCount += 1;
			continue;
		}
		moveCursorCount += 1;
	}
	return {
		total: patches.length,
		writeLineCount,
		clearLineCount,
		moveCursorCount,
	};
}
