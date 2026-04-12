import type { RecentSessionSearchHit } from "@pickle-pee/runtime";
import type { InteractiveOverlayState, PendingPermissionDetails, ResumeBrowserState } from "../types/index.js";
import {
	beginResumeBrowserSearch,
	completeResumeBrowserSearch,
	createResumeBrowserState,
	moveResumeBrowserSelection,
	toggleResumeBrowserPreviewState,
} from "./resume-browser.js";

export function initialInteractiveOverlayState(): InteractiveOverlayState {
	return {
		pendingPermission: null,
		resumeBrowser: null,
		resumeBrowserSubmitPending: false,
		resumeSearchRequestId: 0,
	};
}

export function resetInteractiveOverlayState(): InteractiveOverlayState {
	return initialInteractiveOverlayState();
}

export function openResumeBrowserOverlay(
	current: InteractiveOverlayState,
	initialQuery: string,
): InteractiveOverlayState {
	return {
		...current,
		resumeBrowser: createResumeBrowserState(initialQuery),
		resumeBrowserSubmitPending: false,
	};
}

export function closeResumeBrowserOverlay(current: InteractiveOverlayState): InteractiveOverlayState {
	if (current.resumeBrowser === null) {
		return current;
	}
	return {
		...current,
		resumeBrowser: null,
		resumeBrowserSubmitPending: false,
		resumeSearchRequestId: current.resumeSearchRequestId + 1,
	};
}

export function markResumeBrowserSubmitPending(
	current: InteractiveOverlayState,
	pending: boolean,
): InteractiveOverlayState {
	if (current.resumeBrowser === null) {
		return current;
	}
	return {
		...current,
		resumeBrowserSubmitPending: pending,
	};
}

export function beginResumeBrowserOverlaySearch(
	current: InteractiveOverlayState,
	nextQuery: string,
): {
	readonly state: InteractiveOverlayState;
	readonly requestId: number;
	readonly previous: ResumeBrowserState;
	readonly selectedSessionId: string | null;
} | null {
	const browser = current.resumeBrowser;
	if (browser === null) {
		return null;
	}
	const requestId = current.resumeSearchRequestId + 1;
	return {
		state: {
			...current,
			resumeSearchRequestId: requestId,
			resumeBrowser: beginResumeBrowserSearch(browser, nextQuery),
		},
		requestId,
		previous: browser,
		selectedSessionId: browser.hits[browser.selectedIndex]?.entry.recoveryData.sessionId.value ?? null,
	};
}

export function completeResumeBrowserOverlaySearch(
	current: InteractiveOverlayState,
	params: {
		readonly requestId: number;
		readonly nextQuery: string;
		readonly hits: readonly RecentSessionSearchHit[];
		readonly selectedSessionId: string | null;
		readonly fallbackIndex: number;
	},
): InteractiveOverlayState {
	if (current.resumeBrowser === null || params.requestId !== current.resumeSearchRequestId) {
		return current;
	}
	return {
		...current,
		resumeBrowser: completeResumeBrowserSearch(
			current.resumeBrowser,
			params.nextQuery,
			params.hits,
			params.selectedSessionId,
			params.fallbackIndex,
		),
	};
}

export function moveResumeBrowserOverlaySelection(
	current: InteractiveOverlayState,
	delta: number,
): InteractiveOverlayState {
	if (current.resumeBrowser === null) {
		return current;
	}
	const nextIndex = moveResumeBrowserSelection(
		current.resumeBrowser.selectedIndex,
		delta,
		current.resumeBrowser.hits.length,
	);
	if (nextIndex === current.resumeBrowser.selectedIndex) {
		return current;
	}
	return {
		...current,
		resumeBrowser: {
			...current.resumeBrowser,
			selectedIndex: nextIndex,
		},
	};
}

export function toggleResumeBrowserOverlayPreview(current: InteractiveOverlayState): InteractiveOverlayState {
	if (current.resumeBrowser === null) {
		return current;
	}
	return {
		...current,
		resumeBrowser: toggleResumeBrowserPreviewState(current.resumeBrowser),
	};
}

export function setPendingPermissionRequest(
	current: InteractiveOverlayState,
	callId: string,
	details: PendingPermissionDetails,
): InteractiveOverlayState {
	return {
		...current,
		pendingPermission: {
			callId,
			details,
			selectedIndex: 0,
		},
	};
}

export function clearPendingPermissionRequest(
	current: InteractiveOverlayState,
	callId?: string,
): InteractiveOverlayState {
	if (current.pendingPermission === null) {
		return current;
	}
	if (callId && current.pendingPermission.callId !== callId) {
		return current;
	}
	return {
		...current,
		pendingPermission: null,
	};
}

export function movePendingPermissionSelection(
	current: InteractiveOverlayState,
	direction: -1 | 1,
): InteractiveOverlayState {
	if (current.pendingPermission === null) {
		return current;
	}
	const selectionCount = 3;
	const nextIndex = (current.pendingPermission.selectedIndex + direction + selectionCount) % selectionCount;
	return {
		...current,
		pendingPermission: {
			...current.pendingPermission,
			selectedIndex: nextIndex,
		},
	};
}
