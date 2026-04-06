export type TerminalHostFamily =
	| "native"
	| "vscode-xtermjs"
	| "jetbrains-jediterm"
	| "tmux"
	| "unknown";

export interface TerminalEnvironment {
	readonly term?: string;
	readonly termProgram?: string;
	readonly terminalEmulator?: string;
	readonly tmux?: string;
}

export interface TerminalCapabilities {
	readonly hostFamily: TerminalHostFamily;
	readonly alternateScreen: boolean;
	readonly mouseTracking: boolean;
	readonly focusReporting: boolean;
	readonly bracketedPaste: boolean;
	readonly synchronizedOutput: boolean;
	readonly extendedKeys: boolean;
}

export interface ScreenCursor {
	readonly row: number;
	readonly column: number;
}

export interface ScreenFrame {
	readonly width: number;
	readonly height: number;
	readonly lines: readonly string[];
	readonly cursor: ScreenCursor;
}

export interface FooterBlock {
	readonly lines: readonly string[];
	readonly cursorLineIndex: number;
	readonly cursorColumn: number;
}

export interface ComposedScreen {
	readonly frame: ScreenFrame;
	readonly footerStartRow: number;
	readonly pinFooterToBottom: boolean;
}

export interface TerminalSelectionRange {
	readonly startRow: number;
	readonly startColumn: number;
	readonly endRow: number;
	readonly endColumn: number;
}

export interface TerminalSelectionColumns {
	readonly startColumn: number;
	readonly endColumn: number;
}

export type FramePatch =
	| {
			readonly type: "write-line";
			readonly row: number;
			readonly content: string;
	  }
	| {
			readonly type: "clear-line";
			readonly row: number;
	  }
	| {
			readonly type: "move-cursor";
			readonly cursor: ScreenCursor;
	  };

export interface TerminalModeState {
	readonly cursorHidden: boolean;
	readonly alternateScreenActive: boolean;
	readonly mouseTrackingActive: boolean;
	readonly focusReportingActive: boolean;
	readonly bracketedPasteActive: boolean;
}

export interface TerminalModePlan {
	readonly enter: string;
	readonly refresh: string;
	readonly reenter: string;
	readonly exit: string;
	readonly state: TerminalModeState;
}

export interface ScrollRegion {
	readonly top: number;
	readonly bottom: number;
}
