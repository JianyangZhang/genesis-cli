import { describe, expect, it } from "vitest";
import {
	beginResumeBrowserOverlaySearch,
	clearPendingPermissionRequest,
	closeResumeBrowserOverlay,
	completeResumeBrowserOverlaySearch,
	initialInteractiveOverlayState,
	markResumeBrowserSubmitPending,
	movePendingPermissionSelection,
	moveResumeBrowserOverlaySelection,
	openResumeBrowserOverlay,
	setPendingPermissionRequest,
	toggleResumeBrowserOverlayPreview,
} from "../services/interactive-overlay-state.js";

describe("interactive overlay state", () => {
	it("opens, updates, and closes resume browser state", () => {
		let state = openResumeBrowserOverlay(initialInteractiveOverlayState(), "readme");
		expect(state.resumeBrowser?.query).toBe("readme");
		expect(state.resumeBrowserSubmitPending).toBe(false);

		const started = beginResumeBrowserOverlaySearch(state, "release");
		expect(started).not.toBeNull();
		state = started!.state;
		expect(state.resumeBrowser?.loading).toBe(true);
		expect(state.resumeSearchRequestId).toBe(started!.requestId);

		state = completeResumeBrowserOverlaySearch(state, {
			requestId: started!.requestId,
			nextQuery: "release",
			hits: [
				{
					headline: "Release flow",
					snippet: "release",
					matchSource: "summary",
					entry: {
						title: "release",
						updatedAt: Date.now(),
						recoveryData: {
							sessionId: { value: "stored" },
							model: { id: "m", provider: "p", displayName: "model" },
							toolSet: [],
							planSummary: null,
							compactionSummary: null,
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
							metadata: null,
						},
					},
				},
			],
			selectedSessionId: null,
			fallbackIndex: 0,
		});
		expect(state.resumeBrowser?.loading).toBe(false);
		expect(state.resumeBrowser?.hits).toHaveLength(1);

		state = moveResumeBrowserOverlaySelection(state, 1);
		expect(state.resumeBrowser?.selectedIndex).toBe(0);

		state = toggleResumeBrowserOverlayPreview(state);
		expect(state.resumeBrowser?.previewExpanded).toBe(true);

		state = markResumeBrowserSubmitPending(state, true);
		expect(state.resumeBrowserSubmitPending).toBe(true);

		const closed = closeResumeBrowserOverlay(state);
		expect(closed.resumeBrowser).toBeNull();
		expect(closed.resumeBrowserSubmitPending).toBe(false);
		expect(closed.resumeSearchRequestId).toBe(state.resumeSearchRequestId + 1);
	});

	it("tracks and clears pending permission selection", () => {
		let state = setPendingPermissionRequest(initialInteractiveOverlayState(), "call-1", {
			toolName: "bash",
			toolCallId: "call-1",
			riskLevel: "high",
			reason: "needs confirmation",
		});
		expect(state.pendingPermission?.selectedIndex).toBe(0);

		state = movePendingPermissionSelection(state, 1);
		expect(state.pendingPermission?.selectedIndex).toBe(1);

		state = clearPendingPermissionRequest(state, "different");
		expect(state.pendingPermission?.callId).toBe("call-1");

		state = clearPendingPermissionRequest(state, "call-1");
		expect(state.pendingPermission).toBeNull();
	});
});
