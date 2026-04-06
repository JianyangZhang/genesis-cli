import type { TerminalCapabilities, TerminalModePlan, TerminalModeState } from "../types/index.js";

const ESC = "\x1b[";

const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ENTER_ALT_SCREEN = `${ESC}?1049h`;
const EXIT_ALT_SCREEN = `${ESC}?1049l`;
const ENABLE_MOUSE_TRACKING = `${ESC}?1000h${ESC}?1002h${ESC}?1006h`;
const DISABLE_MOUSE_TRACKING = `${ESC}?1006l${ESC}?1002l${ESC}?1000l`;
const ENABLE_FOCUS_REPORTING = `${ESC}?1004h`;
const DISABLE_FOCUS_REPORTING = `${ESC}?1004l`;
const ENABLE_BRACKETED_PASTE = `${ESC}?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}?2004l`;

export function createInteractiveModePlan(capabilities: TerminalCapabilities): TerminalModePlan {
	const activeModes = createActiveModeSequence(capabilities);
	const exit = createExitModeSequence(capabilities);
	const enter = `${capabilities.alternateScreen ? ENTER_ALT_SCREEN : ""}${activeModes}`;
	const refresh = activeModes;
	const reenter = `${capabilities.alternateScreen ? ENTER_ALT_SCREEN : ""}${activeModes}`;

	return {
		enter,
		refresh,
		reenter,
		exit,
		state: {
			cursorHidden: true,
			alternateScreenActive: capabilities.alternateScreen,
			mouseTrackingActive: capabilities.mouseTracking,
			focusReportingActive: capabilities.focusReporting,
			bracketedPasteActive: capabilities.bracketedPaste,
		},
	};
}

function createActiveModeSequence(capabilities: TerminalCapabilities): string {
	const active: string[] = [];
	if (capabilities.focusReporting) {
		active.push(ENABLE_FOCUS_REPORTING);
	}
	if (capabilities.mouseTracking) {
		active.push(ENABLE_MOUSE_TRACKING);
	}
	if (capabilities.bracketedPaste) {
		active.push(ENABLE_BRACKETED_PASTE);
	}
	active.push(HIDE_CURSOR);
	return active.join("");
}

function createExitModeSequence(capabilities: TerminalCapabilities): string {
	const exit: string[] = [SHOW_CURSOR];
	if (capabilities.bracketedPaste) {
		exit.push(DISABLE_BRACKETED_PASTE);
	}
	if (capabilities.focusReporting) {
		exit.push(DISABLE_FOCUS_REPORTING);
	}
	if (capabilities.mouseTracking) {
		exit.push(DISABLE_MOUSE_TRACKING);
	}
	if (capabilities.alternateScreen) {
		exit.push(EXIT_ALT_SCREEN);
	}
	return exit.join("");
}

export function createRestoredModeState(): TerminalModeState {
	return {
		cursorHidden: false,
		alternateScreenActive: false,
		mouseTrackingActive: false,
		focusReportingActive: false,
		bracketedPasteActive: false,
	};
}
