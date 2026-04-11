// services/ — Formatting, event-to-output mapping, interaction state.
export type { InteractionPhase, InteractionState, JsonEnvelope, OutputMode, RpcEnvelope } from "../types/index.js";
export type {
	InteractiveOverlayState,
	PendingPermissionDetails,
	PendingPermissionState,
} from "../types/index.js";
export { formatEventAsText, formatPermissionPrompt, formatPlanSummaryText, formatToolStep } from "./event-formatter.js";
export { initialInteractionState, reduceInteractionState } from "./interaction-state.js";
export {
	beginResumeBrowserOverlaySearch,
	clearPendingPermissionRequest,
	closeResumeBrowserOverlay,
	completeResumeBrowserOverlaySearch,
	initialInteractiveOverlayState,
	markResumeBrowserSubmitPending,
	movePendingPermissionSelection,
	moveResumeBrowserOverlaySelection,
	openResumeBrowserOverlay,
	resetInteractiveOverlayState,
	setPendingPermissionRequest,
	toggleResumeBrowserOverlayPreview,
} from "./interactive-overlay-state.js";
export {
	appendAssistantTranscriptBlock,
	appendTranscriptBlockWithSpacer,
	createInteractiveConversationState,
	materializeAssistantTranscriptBlock,
	mergeStreamingText,
} from "./interactive-conversation.js";
export {
	computeInteractiveFooterSeparatorWidth,
	formatFullWidthTranscriptUserLine,
	formatInteractiveErrorDetailLine,
	formatInteractiveErrorLine,
	formatInteractiveInfoLine,
	formatInteractiveInputSeparator,
	formatInteractivePromptBuffer,
	formatInteractiveWarningLine,
	formatTranscriptAssistantLine,
	formatTranscriptUserBlocks,
	formatTranscriptUserLine,
} from "./interactive-display.js";
export { buildInteractiveFooterLeadingLines, formatTurnNotice } from "./interactive-footer.js";
export { INTERACTIVE_THEME } from "./interactive-theme.js";
export { eventToJsonEnvelope, sanitizeForJson } from "./json-formatter.js";
export {
	beginResumeBrowserSearch,
	buildRestoredContextLines,
	buildResumeBrowserBodyBlocks,
	buildResumeBrowserFooterHintLines,
	buildResumeBrowserHeaderLines,
	buildResumeBrowserResumedLines,
	completeResumeBrowserSearch,
	createResumeBrowserState,
	formatResumeBrowserTranscriptBlocks,
	measureResumeBrowserSelectedLineOffset,
	moveResumeBrowserSelection,
	resolveRecentSessionDirectSelection,
	resolveResumeBrowserKeyAction,
	resolveResumeBrowserSelectedIndex,
	resolveResumeBrowserSubmitHit,
	summarizeResumeBrowserHit,
	toggleResumeBrowserPreviewState,
} from "./resume-browser.js";
export {
	createRpcError,
	createRpcResponse,
	eventToRpcNotification,
	parseRpcRequest,
	RPC_ERRORS,
	RPC_METHODS,
} from "./rpc-formatter.js";
