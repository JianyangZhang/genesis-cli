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
	SlashCommandRegistry,
	SlashCommandResolution,
} from "./domain/index.js";
// Domain (slash commands)
export {
	createBuiltinCommands,
	createSlashCommandRegistry,
} from "./domain/index.js";
// Services (formatters + interaction state)
export {
	createRpcError,
	createRpcResponse,
	eventToJsonEnvelope,
	eventToRpcNotification,
	formatEventAsText,
	formatPermissionPrompt,
	formatPlanSummaryText,
	formatToolStep,
	initialInteractionState,
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
	OutputMode,
	OutputSink,
	RenderContext,
	RpcEnvelope,
	SlashCommand,
	SlashCommandContext,
	SlashCommandResult,
	SlashCommandType,
} from "./types/index.js";
