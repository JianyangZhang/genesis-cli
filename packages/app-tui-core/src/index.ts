export {
	detectTerminalCapabilities,
	detectTerminalHostFamily,
} from "./capabilities/terminal-capabilities.js";
export {
	createInteractiveModePlan,
	createRestoredModeState,
} from "./lifecycle/terminal-modes.js";
export { diffScreenFrames } from "./render/frame-diff.js";
export {
	encodeFramePatches,
	encodeResetScrollRegion,
	encodeSetScrollRegion,
} from "./render/frame-patch-encoder.js";
export {
	composePromptBlock,
	composeSectionBlock,
	materializeComposerBlock,
	materializeTextBlock,
	type ComposerBlockLayout,
	type RenderedComposerBlock,
	type RenderedTextBlock,
} from "./render/composer-layout.js";
export { computePromptCursorColumn } from "./render/composer-metrics.js";
export {
	fitTerminalLine,
	measureTerminalDisplayWidth,
	stripAnsiControlSequences,
	truncatePlainText,
} from "./render/text-primitives.js";
export {
	computeEphemeralRows,
	computeFooterCursorRowsFromEnd,
	computeFooterCursorRowsUp,
	computePromptCursorRowsUp,
	countRenderedTerminalRows,
} from "./render/terminal-metrics.js";
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
	TerminalSelectionColumns,
	TerminalSelectionRange,
	TerminalCapabilities,
	TerminalEnvironment,
	TerminalHostFamily,
	TerminalModePlan,
	TerminalModeState,
} from "./types/index.js";
