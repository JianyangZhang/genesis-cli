// UI — TUI components, formatters, event mappers.

export type {
	ConversationLine,
	ConversationRegion,
	HeaderRegion,
	LayoutAccumulator,
	StatusLineRegion,
	ToolCallDisplayStatus,
	TuiScreenLayout,
} from "./adapters/index.js";
// Adapters (TUI)
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
	createLayoutAccumulator,
	renderHeader,
	renderScreen,
	renderStatusLine,
} from "./adapters/index.js";
export type {
	InteractiveLocalCommandDeps,
	SlashCommandRegistry,
	SlashCommandResolution,
} from "./domain/index.js";
// Domain (slash commands)
export {
	createBuiltinCommands,
	createInteractiveLocalCommands,
	renderWorkingTreeSummary,
	createSlashCommandRegistry,
} from "./domain/index.js";
// Services (formatters + interaction state)
export {
	buildInteractiveFooterLeadingLines,
	buildRestoredContextLines,
	buildResumeBrowserBodyBlocks,
	buildResumeBrowserFooterHintLines,
	buildResumeBrowserHeaderLines,
	createRpcError,
	createRpcResponse,
	eventToJsonEnvelope,
	eventToRpcNotification,
	formatEventAsText,
	formatPermissionPrompt,
	formatPlanSummaryText,
	formatResumeBrowserTranscriptBlocks,
	formatToolStep,
	formatTurnNotice,
	initialInteractionState,
	measureResumeBrowserSelectedLineOffset,
	moveResumeBrowserSelection,
	parseRpcRequest,
	RPC_ERRORS,
	RPC_METHODS,
	reduceInteractionState,
	sanitizeForJson,
} from "./services/index.js";
// Types
export type {
	InteractionPhase,
	InteractionState,
	JsonEnvelope,
	ModelOption,
	OutputMode,
	OutputSink,
	RenderContext,
	ResumeBrowserState,
	RpcEnvelope,
	SlashCommand,
	SlashCommandContext,
	SlashCommandHost,
	SlashCommandResult,
	SlashCommandType,
} from "./types/index.js";
