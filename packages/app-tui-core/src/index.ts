export {
	detectTerminalCapabilities,
	detectTerminalHostFamily,
} from "./capabilities/terminal-capabilities.js";
export {
	summarizeFramePatches,
	summarizeScreenFrame,
	summarizeTerminalCapabilities,
	summarizeTerminalModePlan,
} from "./debug/render-summary.js";
export {
	createInteractiveModePlan,
	createRestoredModeState,
} from "./lifecycle/terminal-modes.js";
export {
	type ComposerBlockLayout,
	composePromptBlock,
	composeSectionBlock,
	materializeComposerBlock,
	materializeTextBlock,
	type RenderedComposerBlock,
	type RenderedTextBlock,
} from "./render/composer-layout.js";
export { computePromptCursorColumn } from "./render/composer-metrics.js";
export { diffScreenFrames } from "./render/frame-diff.js";
export {
	clampScrollOffset,
	computeBodyViewportRows,
	computeMaxScrollOffset,
	ensureVisibleSelectionOffset,
} from "./render/interactive-viewport.js";
export {
	encodeFramePatches,
	encodeResetScrollRegion,
	encodeSetScrollRegion,
} from "./render/frame-patch-encoder.js";
export {
	computeEphemeralRows,
	computeFooterCursorRowsFromEnd,
	computeFooterCursorRowsUp,
	computePromptCursorRowsUp,
	countRenderedTerminalRows,
} from "./render/terminal-metrics.js";
export {
	fitTerminalLine,
	measureTerminalDisplayWidth,
	stripAnsiControlSequences,
	truncatePlainText,
} from "./render/text-primitives.js";
export {
	computeTranscriptDisplayRows,
	flattenTranscriptLines,
	wrapTranscriptContent,
} from "./render/transcript-layout.js";
export {
	computeSelectionColumnsForRow,
	computeVisibleViewportLines,
	extractPlainTextSelection,
	renderSelectedPlainLine,
} from "./render/transcript-viewport.js";
export { createScreenFrame } from "./screen/frame-buffer.js";
export {
	composeScreenWithFooter,
	computeFooterCursorColumn,
	computeFooterStartRow,
} from "./screen/screen-composition.js";
export type {
	ComposedScreen,
	FooterBlock,
	FramePatch,
	ScreenCursor,
	ScreenFrame,
	ScrollRegion,
	TerminalCapabilities,
	TerminalEnvironment,
	TerminalHostFamily,
	TerminalModePlan,
	TerminalModeState,
	TerminalSelectionColumns,
	TerminalSelectionRange,
} from "./types/index.js";
