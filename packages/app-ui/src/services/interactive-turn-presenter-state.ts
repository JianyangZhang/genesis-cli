import type {
	InteractiveTurnNotice,
	InteractiveTurnPresenterState,
	UsageSnapshot,
} from "../types/index.js";

export function emptyUsageSnapshot(): UsageSnapshot {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function initialInteractiveTurnPresenterState(): InteractiveTurnPresenterState {
	return {
		notice: null,
		noticeAnimationFrame: 0,
		startedAt: null,
		activeTurnUsageTotals: emptyUsageSnapshot(),
		currentMessageUsage: emptyUsageSnapshot(),
		lastTurnUsage: null,
		sessionUsageTotals: emptyUsageSnapshot(),
		queuedInputs: [],
	};
}

export function resetInteractiveTurnPresenterState(): InteractiveTurnPresenterState {
	return initialInteractiveTurnPresenterState();
}

export function normalizeUsageSnapshot(usage: UsageSnapshot): UsageSnapshot {
	return {
		input: Math.max(0, usage.input),
		output: Math.max(0, usage.output),
		cacheRead: Math.max(0, usage.cacheRead),
		cacheWrite: Math.max(0, usage.cacheWrite),
		totalTokens: Math.max(0, usage.totalTokens),
	};
}

export function addUsageSnapshots(left: UsageSnapshot, right: UsageSnapshot): UsageSnapshot {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
	};
}

export function hasUsageSnapshot(usage: UsageSnapshot | null | undefined): usage is UsageSnapshot {
	if (!usage) {
		return false;
	}
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
}

export function beginInteractiveTurnFeedback(
	current: InteractiveTurnPresenterState,
	startedAt: number,
): InteractiveTurnPresenterState {
	if (current.notice !== null) {
		return current;
	}
	return {
		...current,
		notice: "thinking",
		noticeAnimationFrame: 0,
		startedAt,
	};
}

export function beginInteractiveTurn(
	current: InteractiveTurnPresenterState,
	startedAt: number,
): InteractiveTurnPresenterState {
	return {
		...current,
		notice: "thinking",
		noticeAnimationFrame: 0,
		startedAt,
		activeTurnUsageTotals: emptyUsageSnapshot(),
		currentMessageUsage: emptyUsageSnapshot(),
	};
}

export function setInteractiveTurnNotice(
	current: InteractiveTurnPresenterState,
	notice: Exclude<InteractiveTurnNotice, null>,
	options: { readonly startedAt?: number; readonly resetAnimation?: boolean } = {},
): InteractiveTurnPresenterState {
	return {
		...current,
		notice,
		noticeAnimationFrame: options.resetAnimation === false ? current.noticeAnimationFrame : 0,
		startedAt: options.startedAt ?? current.startedAt,
	};
}

export function clearInteractiveTurnNotice(current: InteractiveTurnPresenterState): InteractiveTurnPresenterState {
	if (current.notice === null && current.noticeAnimationFrame === 0 && current.startedAt === null) {
		return current;
	}
	return {
		...current,
		notice: null,
		noticeAnimationFrame: 0,
		startedAt: null,
	};
}

export function tickInteractiveTurnNoticeAnimation(
	current: InteractiveTurnPresenterState,
): InteractiveTurnPresenterState {
	if (current.notice === null) {
		return current;
	}
	return {
		...current,
		noticeAnimationFrame: (current.noticeAnimationFrame + 1) % 3,
	};
}

export function updateInteractiveTurnUsage(
	current: InteractiveTurnPresenterState,
	usage: UsageSnapshot,
	isFinal: boolean,
): InteractiveTurnPresenterState {
	const normalized = normalizeUsageSnapshot(usage);
	if (isFinal) {
		return {
			...current,
			activeTurnUsageTotals: addUsageSnapshots(current.activeTurnUsageTotals, normalized),
			currentMessageUsage: emptyUsageSnapshot(),
		};
	}
	return {
		...current,
		currentMessageUsage: normalized,
	};
}

export function currentInteractiveTurnUsage(current: InteractiveTurnPresenterState): UsageSnapshot | null {
	const usage = addUsageSnapshots(current.activeTurnUsageTotals, current.currentMessageUsage);
	return hasUsageSnapshot(usage) ? usage : null;
}

export function currentInteractiveTurnElapsedMs(
	current: InteractiveTurnPresenterState,
	now: number,
): number | null {
	if (current.notice === null || current.startedAt === null) {
		return null;
	}
	return Math.max(0, now - current.startedAt);
}

export function completeInteractiveTurn(current: InteractiveTurnPresenterState): InteractiveTurnPresenterState {
	const completedTurnUsage = currentInteractiveTurnUsage(current);
	return {
		...clearInteractiveTurnNotice(current),
		lastTurnUsage: hasUsageSnapshot(completedTurnUsage) ? completedTurnUsage : current.lastTurnUsage,
		sessionUsageTotals: hasUsageSnapshot(completedTurnUsage)
			? addUsageSnapshots(current.sessionUsageTotals, completedTurnUsage!)
			: current.sessionUsageTotals,
		activeTurnUsageTotals: emptyUsageSnapshot(),
		currentMessageUsage: emptyUsageSnapshot(),
	};
}

export function queueInteractiveInput(
	current: InteractiveTurnPresenterState,
	input: string,
): InteractiveTurnPresenterState {
	return {
		...current,
		queuedInputs: [...current.queuedInputs, input],
	};
}

export function drainQueuedInteractiveInputs(
	current: InteractiveTurnPresenterState,
): { readonly state: InteractiveTurnPresenterState; readonly batch: string | null } {
	if (current.queuedInputs.length === 0) {
		return { state: current, batch: null };
	}
	return {
		state: {
			...current,
			queuedInputs: [],
		},
		batch: current.queuedInputs.join("\n\n"),
	};
}

export function preserveThinkingNoticeForQueuedBacklog(
	current: InteractiveTurnPresenterState,
	now: number,
): InteractiveTurnPresenterState {
	if (current.notice === "responding") {
		return {
			...current,
			notice: "thinking",
		};
	}
	if (current.notice === null) {
		return beginInteractiveTurnFeedback(current, now);
	}
	return current;
}
