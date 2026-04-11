import { describe, expect, it } from "vitest";
import {
	appendThinkingDetailText,
	clearInteractiveDetailPanelState,
	collapseInteractiveDetailPanel,
	formatCompactionDetailText,
	hasInteractiveDetailPanelContent,
	initialInteractiveDetailPanelState,
	readInteractiveDetailPanelText,
	setInteractiveDetailPanelScroll,
	showCompactionDetailSummary,
	toggleInteractiveDetailPanel,
} from "../services/interactive-detail-panel-state.js";

describe("interactive detail panel state", () => {
	it("tracks thinking content and toggle/scroll state", () => {
		let state = initialInteractiveDetailPanelState();
		expect(hasInteractiveDetailPanelContent(state)).toBe(false);

		state = appendThinkingDetailText(state, "thinking");
		expect(hasInteractiveDetailPanelContent(state)).toBe(true);
		expect(readInteractiveDetailPanelText(state)).toBe("thinking");

		state = toggleInteractiveDetailPanel(state, { hasContent: true });
		expect(state.expanded).toBe(true);
		expect(state.scrollOffset).toBe(0);

		state = setInteractiveDetailPanelScroll(state, 4);
		expect(state.scrollOffset).toBe(4);

		state = collapseInteractiveDetailPanel(state);
		expect(state.expanded).toBe(false);
		expect(state.scrollOffset).toBe(0);
	});

	it("switches to compaction summary and clears state", () => {
		let state = appendThinkingDetailText(initialInteractiveDetailPanelState(), "draft");
		state = showCompactionDetailSummary(state, formatCompactionDetailText({
			compressedAt: Date.now(),
			originalMessageCount: 10,
			retainedMessageCount: 3,
			estimatedTokensSaved: 42,
			compactedSummary: "summary",
		}));

		expect(readInteractiveDetailPanelText(state)).toContain("Compaction summary");
		expect(readInteractiveDetailPanelText(state)).toContain("Compressed conversation:");
		expect(readInteractiveDetailPanelText(state)).toContain("summary");
		expect(state.thinkingText).toBe("");

		state = clearInteractiveDetailPanelState(state);
		expect(hasInteractiveDetailPanelContent(state)).toBe(false);
		expect(state.expanded).toBe(false);
	});
});
