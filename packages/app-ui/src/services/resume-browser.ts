import type { RecentSessionMatchSource, RecentSessionSearchHit } from "@pickle-pee/runtime";
import type { ResumeBrowserState } from "../types/index.js";

export function moveResumeBrowserSelection(currentIndex: number, delta: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(total - 1, currentIndex + delta));
}

export function formatResumeBrowserTranscriptBlocks(state: ResumeBrowserState): readonly string[] {
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
			const selected = index === state.selectedIndex;
			const cursor = selected ? "❯" : " ";
			const meta = [
				formatResumeBrowserMatchSource(hit.matchSource),
				hit.entry.recoveryData.model.displayName ?? hit.entry.recoveryData.model.id,
				shortSessionId(hit.entry.recoveryData.sessionId.value),
			].filter(Boolean);
			lines.push(`${cursor} ${hit.headline}`);
			lines.push(`  ${meta.join(" · ")}`);
			lines.push(`  ${hit.matchSource === "recent" ? "Preview" : "Match"}: ${hit.snippet}`);
			lines.push("");
		}
	}

	lines.push("Type to search · Enter to open · ↑↓ to select · Ctrl+V preview · Esc cancel");

	if (state.previewExpanded) {
		const previewHit = state.hits[state.selectedIndex] ?? null;
		if (previewHit) {
			lines.push("");
			lines.push("Preview");
			lines.push(...buildResumeBrowserPreviewLines(previewHit));
		}
	}

	return [lines.join("\n")];
}

export function buildResumeBrowserPreviewLines(hit: RecentSessionSearchHit): readonly string[] {
	const metadata = hit.entry.recoveryData.metadata;
	const lines = [
		`  Session: ${hit.entry.recoveryData.sessionId.value}`,
		`  Headline: ${hit.headline}`,
		`  Match source: ${formatResumeBrowserMatchSource(hit.matchSource)}`,
	];
	if (metadata?.firstPrompt) {
		lines.push(`  First prompt: ${metadata.firstPrompt}`);
	}
	if (metadata?.summary && metadata.summary !== metadata.firstPrompt) {
		lines.push(`  Summary: ${metadata.summary}`);
	}
	for (const message of metadata?.recentMessages ?? []) {
		const role = message.role === "user" ? "User" : "Assistant";
		lines.push(`  ${role}: ${message.text}`);
	}
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
}

function shortSessionId(sessionId: string): string {
	return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}
