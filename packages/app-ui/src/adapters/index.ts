// adapters/ — TUI layout, rendering, and event-to-layout mapping.

export type { LayoutAccumulator } from "./event-to-layout.js";
export { createLayoutAccumulator } from "./event-to-layout.js";
export type {
	ConversationLine,
	ConversationRegion,
	DividerLine,
	HeaderRegion,
	PermissionPromptLine,
	PlanStepLine,
	StatusLineRegion,
	TextLine,
	ToolCallDisplayStatus,
	ToolCallLine,
	TuiScreenLayout,
} from "./tui-layout.js";
export {
	ansiClearBelow,
	ansiClearLine,
	ansiCursorHome,
	ansiDisableFocusReporting,
	ansiDisableMouseTracking,
	ansiEnableFocusReporting,
	ansiEnableMouseTracking,
	ansiEnterAlternateScreen,
	ansiExitAlternateScreen,
	ansiHideCursor,
	ansiMoveLeft,
	ansiMoveRight,
	ansiMoveUp,
	ansiResetCursor,
	ansiRestoreCursor,
	ansiSaveCursor,
	ansiShowCursor,
	renderHeader,
	renderScreen,
	renderStatusLine,
} from "./tui-renderer.js";
