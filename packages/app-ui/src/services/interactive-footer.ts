const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const TURN_NOTICE_ELAPSED_THRESHOLD_MS = 2_000;

interface UsageSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export function buildInteractiveFooterLeadingLines(state: {
	readonly terminalWidth: number;
	readonly turnNotice: "thinking" | "responding" | "tool" | "compacting" | null;
	readonly turnNoticeAnimationFrame?: number;
	readonly elapsedMs?: number | null;
	readonly currentTurnUsage?: UsageSnapshot | null;
	readonly lastTurnUsage?: UsageSnapshot | null;
	readonly sessionUsage?: UsageSnapshot | null;
	readonly activeToolLabel?: string | null;
	readonly showPendingOutputIndicator?: boolean;
	readonly detailPanelExpanded?: boolean;
	readonly detailPanelSummary?: string | null;
	readonly detailPanelLines?: readonly string[];
	readonly queuedInputs?: readonly string[];
	readonly truncateText: (text: string, width: number) => string;
}): readonly string[] {
	const leadingLines: string[] = [];
	if (state.turnNotice !== null) {
		leadingLines.push(
			formatTurnNotice(state.turnNotice, {
				animationFrame: state.turnNoticeAnimationFrame ?? 0,
				elapsedMs: state.elapsedMs ?? null,
				usage: state.currentTurnUsage ?? null,
				showPendingOutputIndicator: state.showPendingOutputIndicator ?? false,
				queuedCount: state.queuedInputs?.length ?? 0,
				toolLabel: state.activeToolLabel ?? null,
			}),
		);
	} else {
		if (hasUsageSnapshot(state.lastTurnUsage ?? null)) {
			leadingLines.push(formatUsageSummaryLine("Last turn", state.lastTurnUsage!));
		}
		if (hasUsageSnapshot(state.sessionUsage ?? null)) {
			leadingLines.push(formatUsageSummaryLine("Session", state.sessionUsage!));
		}
	}
	if ((state.detailPanelSummary?.length ?? 0) > 0) {
		leadingLines.push(`${DIM}↳ ${state.detailPanelSummary}${RESET}`);
		if (state.detailPanelExpanded) {
			leadingLines.push(...(state.detailPanelLines ?? []));
		}
	}
	if ((state.queuedInputs?.length ?? 0) > 0) {
		leadingLines.push(...formatQueuedPromptPreviewLines(state.queuedInputs ?? [], state.terminalWidth, state.truncateText));
	}
	return leadingLines;
}

export function formatTurnNotice(
	kind: "thinking" | "responding" | "tool" | "compacting",
	options: {
		readonly animationFrame?: number;
		readonly queuedCount?: number;
		readonly usage?: UsageSnapshot | null;
		readonly showPendingOutputIndicator?: boolean;
		readonly elapsedMs?: number | null;
		readonly toolLabel?: string | null;
	} = {},
): string {
	const suffix = ".".repeat(((options.animationFrame ?? 0) % 3) + 1);
	const label =
		kind === "thinking"
			? `Thinking${suffix}`
			: kind === "responding"
				? `Responding${suffix}`
				: kind === "compacting"
					? `Compacting${suffix}`
					: `${options.toolLabel ?? "Running tools"}${suffix}`;
	const meta: string[] = [];
	if ((options.elapsedMs ?? 0) >= TURN_NOTICE_ELAPSED_THRESHOLD_MS) {
		meta.push(formatElapsedLabel(options.elapsedMs ?? 0));
	}
	const usageLabel = formatUsageCompact(options.usage ?? null, options.showPendingOutputIndicator ?? false);
	if (usageLabel.length > 0) {
		meta.push(usageLabel);
	}
	if ((options.queuedCount ?? 0) > 0) {
		meta.push(`${options.queuedCount} queued`);
	}
	return `${DIM}${CYAN}· ${label}${meta.length > 0 ? ` (${meta.join(" · ")})` : ""}${RESET}`;
}

function formatQueuedPromptPreviewLines(
	queuedInputs: readonly string[],
	terminalWidth: number,
	truncateText: (text: string, width: number) => string,
): readonly string[] {
	const maxVisible = 2;
	const previewWidth = Math.max(12, terminalWidth - 18);
	const lines = queuedInputs.slice(0, maxVisible).map((input, index) => {
		const label = queuedInputs.length > 1 ? `↳ Queued ${index + 1}: ` : "↳ Queued: ";
		return `${DIM}${YELLOW}${label}${RESET}${truncateText(input, previewWidth)}`;
	});
	if (queuedInputs.length > maxVisible) {
		lines.push(`${DIM}${YELLOW}↳ +${queuedInputs.length - maxVisible} more queued${RESET}`);
	}
	return lines;
}

function formatUsageSummaryLine(label: string, usage: UsageSnapshot): string {
	return `${DIM}${CYAN}· ${label}: ${formatUsageCompact(usage)}${RESET}`;
}

function formatUsageCompact(usage: UsageSnapshot | null, showPendingOutputIndicator = false): string {
	if (usage && usage.output > 0) {
		return `↓ ${formatTokenCount(usage.output)} tokens`;
	}
	if (showPendingOutputIndicator) {
		return "↓";
	}
	return "";
}

function formatElapsedLabel(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatTokenCount(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(count / 1_000)}k`;
}

function hasUsageSnapshot(usage: UsageSnapshot | null | undefined): usage is UsageSnapshot {
	if (!usage) {
		return false;
	}
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
}
