import type { RecentSessionEntry, RecentSessionMatchSource, RecentSessionSearchHit } from "@pickle-pee/runtime";
import type { ResumeBrowserState } from "../types/index.js";

export function moveResumeBrowserSelection(currentIndex: number, delta: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(total - 1, currentIndex + delta));
}

export function formatResumeBrowserTranscriptBlocks(state: ResumeBrowserState, now = Date.now()): readonly string[] {
	const lines: string[] = [];
	lines.push(...buildResumeBrowserHeaderLines(state, now));
	lines.push("");
	for (const block of buildResumeBrowserBodyBlocks(state, now)) {
		lines.push(...block.split("\n"));
	}
	lines.push(...buildResumeBrowserFooterHintLines());
	return [lines.join("\n")];
}

export function buildResumeBrowserHeaderLines(state: ResumeBrowserState, now = Date.now()): readonly string[] {
	const countLabel =
		state.hits.length > 0 ? ` (${Math.min(state.selectedIndex + 1, state.hits.length)} of ${state.hits.length})` : "";
	const selectedHit = state.hits[state.selectedIndex] ?? state.hits[0] ?? null;
	const statusLine = selectedHit
		? [
				formatRecentSessionUpdatedAt(selectedHit.entry.updatedAt, now),
				formatResumeBrowserModelLabel(selectedHit) ?? "legacy session",
				state.query.trim().length > 0 ? `filter: ${state.query}` : "recent sessions",
				state.previewExpanded ? "preview on" : "preview off",
			]
				.filter(Boolean)
				.join(" · ")
		: state.loading
			? "Searching..."
			: state.hits.length === 0
				? "No recent sessions."
				: "Recent sessions";
	return [`Resume Session${countLabel}`, statusLine];
}

export function buildResumeBrowserBodyBlocks(state: ResumeBrowserState, now = Date.now()): readonly string[] {
	if (state.loading) {
		return ["Searching..."];
	}
	if (state.hits.length === 0) {
		return ["No recent sessions."];
	}
	const blocks: string[] = [];
	for (const [index, hit] of state.hits.entries()) {
		blocks.push(
			buildResumeBrowserHitLines(hit, { selected: index === state.selectedIndex, now, query: state.query }).join(
				"\n",
			),
		);
		if (state.previewExpanded && index === state.selectedIndex) {
			blocks.push(["Preview", ...buildResumeBrowserPreviewLines(hit, now), ""].join("\n"));
		}
	}
	return blocks;
}

export function buildResumeBrowserFooterHintLines(): readonly string[] {
	return ["Type to search · Enter to open · ↑↓ to select · Ctrl+V preview · Esc cancel"];
}

export function measureResumeBrowserSelectedLineOffset(state: ResumeBrowserState, now = Date.now()): number {
	let offset = 4;
	if (state.loading || state.hits.length === 0) {
		return offset;
	}
	for (let index = 0; index < state.selectedIndex; index += 1) {
		offset += buildResumeBrowserHitLines(state.hits[index]!, { selected: false, now, query: state.query }).length;
	}
	return offset;
}

export function buildResumeBrowserPreviewLines(hit: RecentSessionSearchHit, now = Date.now()): readonly string[] {
	const summary = readResumeSummary(hit);
	const metadata = hit.entry.recoveryData.metadata;
	const lines = [
		`  Session: ${hit.entry.recoveryData.sessionId.value}`,
		`  Updated: ${formatRecentSessionUpdatedAt(hit.entry.updatedAt, now)}`,
		`  Headline: ${hit.headline}`,
		`  Match source: ${formatResumeBrowserMatchSource(hit.matchSource)}`,
	];
	if (summary.goal) {
		lines.push(`  Goal: ${summary.goal}`);
	}
	if (summary.userIntent) {
		lines.push(`  User asked: ${summary.userIntent}`);
	}
	if (summary.assistantState && summary.assistantState !== summary.lastAssistantTurn) {
		lines.push(`  Assistant state: ${summary.assistantState}`);
	}
	for (const message of metadata?.recentMessages ?? []) {
		const role = message.role === "user" ? "User" : "Assistant";
		lines.push(`  ${role}: ${message.text}`);
	}
	return lines;
}

export function buildRestoredContextLines(source: RecentSessionEntry | RecentSessionSearchHit): readonly string[] {
	const entry = "entry" in source ? source.entry : source;
	const preview = entry.recoveryData.metadata?.recentMessages ?? [];
	if (preview.length === 0) {
		return [];
	}
	const lines = ["Restored context:"];
	for (const item of preview) {
		const label = item.role === "user" ? "User" : "Assistant";
		lines.push(`  ${label}: ${truncateResumePreviewText(item.text, 88)}`);
	}
	return lines;
}

export function resolveRecentSessionDirectSelection(
	selector: string,
	displayedEntries: readonly RecentSessionEntry[],
	allRecentEntries: readonly RecentSessionEntry[],
): RecentSessionEntry | null {
	const idxText = selector.startsWith("#") ? selector.slice(1) : selector;
	const idx = Number.parseInt(idxText, 10);
	if (Number.isFinite(idx) && idx >= 1 && idx <= displayedEntries.length) {
		return displayedEntries[idx - 1] ?? null;
	}

	const exact = allRecentEntries.find((entry) => entry.recoveryData.sessionId.value === selector) ?? null;
	if (exact) {
		return exact;
	}

	const prefixMatches = allRecentEntries.filter((entry) => entry.recoveryData.sessionId.value.startsWith(selector));
	return prefixMatches.length === 1 ? (prefixMatches[0] ?? null) : null;
}

export function resolveResumeBrowserSelectedIndex(
	hits: readonly RecentSessionSearchHit[],
	selectedSessionId: string | null,
	fallbackIndex: number,
): number {
	if (hits.length === 0) {
		return 0;
	}
	if (selectedSessionId) {
		const matchedIndex = hits.findIndex((hit) => hit.entry.recoveryData.sessionId.value === selectedSessionId);
		if (matchedIndex >= 0) {
			return matchedIndex;
		}
	}
	return moveResumeBrowserSelection(fallbackIndex, 0, hits.length);
}

export function summarizeResumeBrowserHit(hit: RecentSessionSearchHit | null | undefined): Record<string, unknown> | null {
	if (!hit) {
		return null;
	}
	return {
		sessionId: hit.entry.recoveryData.sessionId.value,
		matchSource: hit.matchSource,
		headline: hit.headline,
		title: hit.entry.title,
		summarySource: hit.entry.recoveryData.metadata?.resumeSummary?.source ?? "legacy",
		summaryVersion: hit.entry.recoveryData.metadata?.resumeSummary?.version ?? null,
	};
}

function buildResumeBrowserHitLines(
	hit: RecentSessionSearchHit,
	options: { readonly selected: boolean; readonly now: number; readonly query: string },
): readonly string[] {
	const summary = readResumeSummary(hit);
	const cursor = options.selected ? "❯" : " ";
	const title = pickResumeBrowserTitle(hit, options.query);
	const compactTitle = compactResumeBrowserLine(title, 96);
	const sessionLabel = formatResumeBrowserSessionLabel(hit, title);
	const goal = compactResumeBrowserLine(summary.goal, 120);
	const firstPrompt = compactResumeBrowserLine(summary.userIntent, 120);
	const matchText = compactResumeBrowserLine(normalizeResumeText(hit.snippet), 120);
	const lines = [
		`${cursor} ${compactTitle}`,
		`  ${[
			formatRecentSessionUpdatedAt(hit.entry.updatedAt, options.now),
			formatResumeBrowserModelLabel(hit),
			sessionLabel,
		]
			.filter(Boolean)
			.join(" · ")}`,
	];
	if (goal) {
		lines.push(`  Goal: ${goal}`);
	}
	if (firstPrompt && firstPrompt !== goal) {
		lines.push(`  User: ${firstPrompt}`);
	}
	if (hit.matchSource !== "recent" && matchText && matchText !== firstPrompt && matchText !== goal) {
		lines.push(`  Match (${formatResumeBrowserMatchSource(hit.matchSource)}): ${matchText}`);
	}
	lines.push("");
	return lines;
}

function formatResumeBrowserMatchSource(source: RecentSessionMatchSource): string {
	switch (source) {
		case "recent":
			return "recent";
		case "title":
			return "title";
		case "first_prompt":
			return "first prompt";
		case "summary":
			return "summary";
		case "recent_user_message":
			return "user message";
		case "recent_assistant_message":
			return "assistant message";
		case "session_id":
			return "session id";
	}
	return source;
}

function shortSessionId(sessionId: string): string {
	return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function pickResumeBrowserTitle(hit: RecentSessionSearchHit, query: string): string {
	const summary = readResumeSummary(hit);
	const sessionId = hit.entry.recoveryData.sessionId.value;
	if (query.trim().length > 0) {
		return (
			normalizeMeaningfulResumeTitle(hit.headline, sessionId) ??
			summary.title ??
			summary.goal ??
			summary.userIntent ??
			"Unnamed session"
		);
	}
	return (
		summary.title ??
		summary.goal ??
		normalizeMeaningfulResumeTitle(hit.entry.title, sessionId) ??
		summary.userIntent ??
		normalizeMeaningfulResumeTitle(hit.headline, sessionId) ??
		"Unnamed session"
	);
}

function formatResumeBrowserModelLabel(hit: RecentSessionSearchHit): string | null {
	const model = hit.entry.recoveryData.model;
	const modelName = normalizeResumeIdentityText(model?.displayName) ?? normalizeResumeIdentityText(model?.id);
	const provider = normalizeResumeIdentityText(model?.provider);
	if (modelName && provider) {
		return `${modelName} via ${provider}`;
	}
	return modelName ?? provider ?? null;
}

function formatRecentSessionUpdatedAt(updatedAt: number, now: number): string {
	const deltaMs = Math.max(0, now - updatedAt);
	const deltaSeconds = Math.floor(deltaMs / 1000);
	if (deltaSeconds < 10) return "just now";
	if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
	const deltaMinutes = Math.floor(deltaSeconds / 60);
	if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
	const deltaHours = Math.floor(deltaMinutes / 60);
	if (deltaHours < 24) return `${deltaHours}h ago`;
	const deltaDays = Math.floor(deltaHours / 24);
	if (deltaDays < 7) return `${deltaDays}d ago`;
	return new Date(updatedAt).toISOString().slice(0, 10);
}

function normalizeResumeText(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

function readResumeSummary(hit: RecentSessionSearchHit): {
	readonly title: string | null;
	readonly goal: string | null;
	readonly userIntent: string | null;
	readonly assistantState: string | null;
	readonly lastAssistantTurn: string | null;
} {
	const metadata = hit.entry.recoveryData.metadata;
	return {
		title: normalizeResumeText(metadata?.resumeSummary?.title) ?? normalizeResumeText(hit.entry.title),
		goal: normalizeResumeText(metadata?.resumeSummary?.goal) ?? normalizeResumeText(metadata?.summary),
		userIntent:
			normalizeResumeText(metadata?.resumeSummary?.userIntent) ?? normalizeResumeText(metadata?.firstPrompt),
		assistantState:
			normalizeResumeText(metadata?.resumeSummary?.assistantState) ??
			normalizeResumeText(metadata?.recentMessages.find((message) => message.role === "assistant")?.text),
		lastAssistantTurn:
			normalizeResumeText(metadata?.resumeSummary?.lastAssistantTurn) ??
			normalizeResumeText(metadata?.recentMessages.filter((message) => message.role === "assistant").at(-1)?.text),
	};
}

function formatResumeBrowserSessionLabel(hit: RecentSessionSearchHit, title: string): string {
	const sessionId = normalizeResumeSessionId(hit.entry.recoveryData.sessionId.value);
	if (!sessionId) {
		return title === "Unnamed session" ? "legacy session" : "";
	}
	const shortId = shortSessionId(sessionId);
	return title === "Unnamed session" ? `session ${shortId}` : shortId;
}

function normalizeMeaningfulResumeTitle(value: string | null | undefined, sessionId: string): string | null {
	const normalized = normalizeResumeText(value);
	if (!normalized) {
		return null;
	}
	return normalized === sessionId ? null : normalized;
}

function normalizeResumeIdentityText(value: string | null | undefined): string | null {
	const normalized = normalizeResumeText(value);
	if (!normalized) {
		return null;
	}
	return normalized.toLowerCase() === "unknown" ? null : normalized;
}

function normalizeResumeSessionId(sessionId: string | null | undefined): string | null {
	const normalized = normalizeResumeText(sessionId);
	if (!normalized) {
		return null;
	}
	return normalized.toLowerCase().startsWith("unknown") ? null : normalized;
}

function compactResumeBrowserLine(value: string | null | undefined, maxLength: number): string | null {
	const normalized = normalizeResumeText(value);
	if (!normalized) {
		return null;
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function truncateResumePreviewText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
