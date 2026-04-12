import type { CompactionSummary } from "@pickle-pee/runtime";
import type { InteractiveDetailPanelState } from "../types/index.js";

export function initialInteractiveDetailPanelState(): InteractiveDetailPanelState {
	return {
		expanded: false,
		scrollOffset: 0,
		thinkingText: "",
		compactionDetailText: "",
	};
}

export function resetInteractiveDetailPanelState(): InteractiveDetailPanelState {
	return initialInteractiveDetailPanelState();
}

export function appendThinkingDetailText(
	current: InteractiveDetailPanelState,
	content: string,
): InteractiveDetailPanelState {
	if (content.length === 0) {
		return current;
	}
	return {
		...current,
		thinkingText: `${current.thinkingText}${content}`,
	};
}

export function showCompactionDetailSummary(
	current: InteractiveDetailPanelState,
	compactionDetailText: string,
): InteractiveDetailPanelState {
	return {
		...current,
		expanded: false,
		scrollOffset: 0,
		thinkingText: "",
		compactionDetailText,
	};
}

export function clearInteractiveDetailPanelState(current: InteractiveDetailPanelState): InteractiveDetailPanelState {
	if (
		current.expanded === false &&
		current.scrollOffset === 0 &&
		current.thinkingText.length === 0 &&
		current.compactionDetailText.length === 0
	) {
		return current;
	}
	return {
		expanded: false,
		scrollOffset: 0,
		thinkingText: "",
		compactionDetailText: "",
	};
}

export function collapseInteractiveDetailPanel(current: InteractiveDetailPanelState): InteractiveDetailPanelState {
	if (!current.expanded) {
		return current;
	}
	return {
		...current,
		expanded: false,
		scrollOffset: 0,
	};
}

export function toggleInteractiveDetailPanel(
	current: InteractiveDetailPanelState,
	options: { readonly hasContent: boolean },
): InteractiveDetailPanelState {
	if (!options.hasContent) {
		return current;
	}
	if (!current.expanded) {
		return {
			...current,
			expanded: true,
			scrollOffset: 0,
		};
	}
	return {
		...current,
		expanded: false,
	};
}

export function setInteractiveDetailPanelScroll(
	current: InteractiveDetailPanelState,
	scrollOffset: number,
): InteractiveDetailPanelState {
	if (scrollOffset === current.scrollOffset) {
		return current;
	}
	return {
		...current,
		scrollOffset,
	};
}

export function hasInteractiveDetailPanelContent(current: InteractiveDetailPanelState): boolean {
	return current.thinkingText.trim().length > 0 || current.compactionDetailText.trim().length > 0;
}

export function readInteractiveDetailPanelText(current: InteractiveDetailPanelState): string {
	if (current.thinkingText.trim().length > 0) {
		return current.thinkingText.trim();
	}
	if (current.compactionDetailText.trim().length > 0) {
		return current.compactionDetailText.trim();
	}
	return "";
}

export function formatCompactionDetailText(summary: CompactionSummary): string {
	const compactedSummary = summary.compactedSummary?.trim();
	const lines = [
		"Compaction summary",
		`Messages: ${summary.originalMessageCount} -> ${summary.retainedMessageCount}`,
		`Estimated tokens saved: ${summary.estimatedTokensSaved}`,
	];
	if (compactedSummary && compactedSummary.length > 0) {
		lines.push("", "Compressed conversation:", compactedSummary);
	}
	return lines.join("\n");
}
