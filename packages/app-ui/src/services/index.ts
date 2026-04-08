// services/ — Formatting, event-to-output mapping, interaction state.
export type { InteractionPhase, InteractionState, JsonEnvelope, OutputMode, RpcEnvelope } from "../types/index.js";
export { formatEventAsText, formatPermissionPrompt, formatPlanSummaryText, formatToolStep } from "./event-formatter.js";
export { initialInteractionState, reduceInteractionState } from "./interaction-state.js";
export { buildInteractiveFooterLeadingLines, formatTurnNotice } from "./interactive-footer.js";
export { eventToJsonEnvelope, sanitizeForJson } from "./json-formatter.js";
export {
	buildResumeBrowserBodyBlocks,
	buildResumeBrowserFooterHintLines,
	buildResumeBrowserHeaderLines,
	buildRestoredContextLines,
	formatResumeBrowserTranscriptBlocks,
	measureResumeBrowserSelectedLineOffset,
	moveResumeBrowserSelection,
} from "./resume-browser.js";
export {
	createRpcError,
	createRpcResponse,
	eventToRpcNotification,
	parseRpcRequest,
	RPC_ERRORS,
	RPC_METHODS,
} from "./rpc-formatter.js";
