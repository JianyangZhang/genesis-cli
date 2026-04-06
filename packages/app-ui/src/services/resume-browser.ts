import type { RecentSessionMatchSource, RecentSessionSearchHit } from "@pickle-pee/runtime";
import type { ResumeBrowserState } from "../types/index.js";

export function moveResumeBrowserSelection(currentIndex: number, delta: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(total - 1, currentIndex + delta));
}

export function formatResumeBrowserTranscriptBlocks(state: ResumeBrowserState, now = Date.now()): readonly string[] {
	const lines: string[] = [];
	lines.push(`Resume Session${state.hits.length > 0 ? ` (${Math.min(state.selectedIndex + 1, state.hits.length)} of ${state.hits.length})` : ""}`);
	lines.push("");
	lines.push(`Search: ${state.query.length > 0 ? state.query : "Type to search recent sessions..."}`);
	lines.push("");

	if (state.loading) {
		lines.push("Searching...");
	} else if (state.hits.length === 0) {
		lines.push("No recent sessions.");
	} else {
		for (const [index, hit] of state.hits.entries()) {
			lines.push(...buildResumeBrowserHitLines(hit, { selected: index === state.selectedIndex, now, query: state.query }));
		}
	}

	lines.push("Type to search · Enter to open · ↑↓ to select · Ctrl+V preview · Esc cancel");

	if (state.previewExpanded) {
		const previewHit = state.hits[state.selectedIndex] ?? null;
		if (previewHit) {
			lines.push("");
			lines.push("Preview");
			lines.push(...buildResumeBrowserPreviewLines(previewHit, now));
		}
	}

	return [lines.join("\n")];
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
	const metadata = hit.entry.recoveryData.metadata;
	const lines = [
		`  Session: ${hit.entry.recoveryData.sessionId.value}`,
		`  Updated: ${formatRecentSessionUpdatedAt(hit.entry.updatedAt, now)}`,
		`  Headline: ${hit.headline}`,
		`  Match source: ${formatResumeBrowserMatchSource(hit.matchSource)}`,
	];
	if (metadata?.summary) {
		lines.push(`  Goal: ${metadata.summary}`);
	}
	if (metadata?.firstPrompt) {
		lines.push(`  User asked: ${metadata.firstPrompt}`);
	}
	for (const message of metadata?.recentMessages ?? []) {
		const role = message.role === "user" ? "User" : "Assistant";
		lines.push(`  ${role}: ${message.text}`);
	}
	return lines;
}

function buildResumeBrowserHitLines(
	hit: RecentSessionSearchHit,
	options: { readonly selected: boolean; readonly now: number; readonly query: string },
): readonly string[] {
	const metadata = hit.entry.recoveryData.metadata;
	const cursor = options.selected ? "❯" : " ";
	const title = pickResumeBrowserTitle(hit, options.query);
	const goal = normalizeResumeText(metadata?.summary);
	const firstPrompt = normalizeResumeText(metadata?.firstPrompt);
	const matchText = normalizeResumeText(hit.snippet);
	const lines = [
		`${cursor} ${title}`,
		`  ${[
			formatRecentSessionUpdatedAt(hit.entry.updatedAt, options.now),
			formatResumeBrowserModelLabel(hit),
			shortSessionId(hit.entry.recoveryData.sessionId.value),
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
	if (query.trim().length > 0) {
		return (
			normalizeResumeText(hit.headline) ??
			normalizeResumeText(hit.entry.recoveryData.metadata?.summary) ??
			normalizeResumeText(hit.entry.recoveryData.metadata?.firstPrompt) ??
			hit.entry.recoveryData.sessionId.value
		);
	}
	return (
		normalizeResumeText(hit.entry.recoveryData.metadata?.summary) ??
		normalizeResumeText(hit.entry.title) ??
		normalizeResumeText(hit.entry.recoveryData.metadata?.firstPrompt) ??
		normalizeResumeText(hit.headline) ??
		hit.entry.recoveryData.sessionId.value
	);
}

function formatResumeBrowserModelLabel(hit: RecentSessionSearchHit): string {
	const model = hit.entry.recoveryData.model;
	const modelName = normalizeResumeText(model.displayName) ?? normalizeResumeText(model.id) ?? "unknown";
	return `${modelName} via ${model.provider}`;
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
