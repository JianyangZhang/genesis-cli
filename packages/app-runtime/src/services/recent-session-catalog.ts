import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	RecentSessionEntry,
	RecentSessionMatchSource,
	RecentSessionSearchHit,
	SessionRecoveryData,
} from "../types/index.js";

export function getRecentSessionCatalogDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

export async function recordRecentSession(
	agentDir: string | undefined,
	recoveryData: SessionRecoveryData,
	options?: { readonly title?: string },
): Promise<void> {
	if (!agentDir) {
		return;
	}
	const storeDir = getRecentSessionCatalogDir(agentDir);
	await mkdir(storeDir, { recursive: true });
	await writeFile(join(storeDir, "last.json"), `${JSON.stringify(recoveryData, null, 2)}\n`, "utf8");
	await upsertRecentSession(storeDir, recoveryData, options?.title);
}

export async function listRecentSessions(agentDir: string | undefined): Promise<readonly RecentSessionEntry[]> {
	if (!agentDir) {
		return [];
	}
	try {
		const parsed = JSON.parse(
			await readFile(join(getRecentSessionCatalogDir(agentDir), "recent.json"), "utf8"),
		) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed as RecentSessionEntry[];
	} catch {
		return [];
	}
}

export async function searchRecentSessions(
	agentDir: string | undefined,
	query: string,
): Promise<readonly RecentSessionSearchHit[]> {
	const normalizedQuery = normalizeRecentSessionSearchText(query);
	const recent = await listRecentSessions(agentDir);
	if (!normalizedQuery) {
		return recent.map((entry) => buildRecentSessionBrowseHit(entry)).slice(0, 10);
	}
	return recent
		.map((entry) => buildRecentSessionSearchHit(entry, normalizedQuery))
		.filter((item): item is { readonly hit: RecentSessionSearchHit; readonly score: number } => item !== null)
		.sort((a, b) => b.score - a.score || b.hit.entry.updatedAt - a.hit.entry.updatedAt)
		.map((item) => item.hit)
		.slice(0, 10);
}

function buildRecentSessionBrowseHit(entry: RecentSessionEntry): RecentSessionSearchHit {
	return {
		entry,
		headline: pickRecentSessionStoredTitle(entry.recoveryData, entry.title) ?? entry.recoveryData.sessionId.value,
		snippet: buildRecentSessionBrowseSnippet(entry),
		matchSource: "recent",
	};
}

async function upsertRecentSession(
	storeDir: string,
	recoveryData: SessionRecoveryData,
	title?: string,
): Promise<void> {
	const existing = await readRecentSessionsByDir(storeDir);
	const next: RecentSessionEntry = {
		recoveryData,
		title: pickRecentSessionStoredTitle(recoveryData, title),
		updatedAt: Date.now(),
	};
	const filtered = existing.filter((entry) => entry.recoveryData.sessionId.value !== recoveryData.sessionId.value);
	const compacted = [next, ...filtered].slice(0, 25);
	await writeFile(join(storeDir, "recent.json"), `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
}

async function readRecentSessionsByDir(storeDir: string): Promise<readonly RecentSessionEntry[]> {
	try {
		const parsed = JSON.parse(await readFile(join(storeDir, "recent.json"), "utf8")) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed as RecentSessionEntry[];
	} catch {
		return [];
	}
}

function pickRecentSessionStoredTitle(recoveryData: SessionRecoveryData, explicitTitle?: string): string | undefined {
	const normalizedExplicit = normalizeRecentSessionText(explicitTitle);
	if (normalizedExplicit) {
		return normalizedExplicit;
	}
	const metadata = recoveryData.metadata;
	return (
		normalizeRecentSessionText(metadata?.firstPrompt) ??
		normalizeRecentSessionText(metadata?.summary) ??
		normalizeRecentSessionText(metadata?.recentMessages.find((message) => message.role === "user")?.text) ??
		undefined
	);
}

function buildRecentSessionSearchHit(
	entry: RecentSessionEntry,
	query: string,
): { readonly hit: RecentSessionSearchHit; readonly score: number } | null {
	const metadata = entry.recoveryData.metadata;
	const candidates: Array<{
		readonly source: RecentSessionMatchSource;
		readonly text: string;
		readonly score: number;
	}> = [];

	pushSearchCandidate(candidates, "title", entry.title, query);
	pushSearchCandidate(candidates, "first_prompt", metadata?.firstPrompt, query);
	pushSearchCandidate(candidates, "summary", metadata?.summary, query);
	for (const message of metadata?.recentMessages ?? []) {
		pushSearchCandidate(
			candidates,
			message.role === "user" ? "recent_user_message" : "recent_assistant_message",
			message.text,
			query,
		);
	}
	pushSearchCandidate(candidates, "session_id", entry.recoveryData.sessionId.value, query);

	const best = candidates.sort((a, b) => b.score - a.score)[0];
	if (!best || best.score <= 0) {
		return null;
	}

	return {
		score: best.score,
		hit: {
			entry,
			headline: buildRecentSessionSearchHeadline(entry, best),
			snippet: buildRecentSessionSearchSnippet(best.text, query),
			matchSource: best.source,
		},
	};
}

function pushSearchCandidate(
	candidates: Array<{ readonly source: RecentSessionMatchSource; readonly text: string; readonly score: number }>,
	source: RecentSessionMatchSource,
	value: string | null | undefined,
	query: string,
): void {
	const text = normalizeRecentSessionText(value);
	if (!text) {
		return;
	}
	const normalized = normalizeRecentSessionSearchText(text);
	if (!normalized) {
		return;
	}
	const score = scoreSearchField(normalized, query, source);
	if (score > 0) {
		candidates.push({ source, text, score });
	}
}

function buildRecentSessionSearchHeadline(
	entry: RecentSessionEntry,
	best: { readonly source: RecentSessionMatchSource; readonly text: string },
): string {
	const metadata = entry.recoveryData.metadata;
	return (
		normalizeRecentSessionText(entry.title) ??
		normalizeRecentSessionText(metadata?.firstPrompt) ??
		normalizeRecentSessionText(metadata?.summary) ??
		(best.source === "recent_user_message" || best.source === "recent_assistant_message" ? best.text : null) ??
		entry.recoveryData.sessionId.value
	);
}

function buildRecentSessionSearchSnippet(text: string, query: string): string {
	const normalizedText = normalizeRecentSessionText(text) ?? text;
	const lowerText = normalizedText.toLowerCase();
	const queryTerms = query.split(" ").filter(Boolean);
	const index = queryTerms
		.map((term) => lowerText.indexOf(term))
		.filter((value) => value >= 0)
		.sort((a, b) => a - b)[0];
	if (index === undefined) {
		return truncateRecentSessionSnippet(normalizedText);
	}
	const start = Math.max(0, index - 20);
	const end = Math.min(normalizedText.length, index + Math.max(query.length, 32));
	const prefix = start > 0 ? "..." : "";
	const suffix = end < normalizedText.length ? "..." : "";
	return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

function buildRecentSessionBrowseSnippet(entry: RecentSessionEntry): string {
	const metadata = entry.recoveryData.metadata;
	return (
		normalizeRecentSessionText(metadata?.summary) ??
		normalizeRecentSessionText(metadata?.recentMessages.find((message) => message.role === "assistant")?.text) ??
		normalizeRecentSessionText(metadata?.recentMessages.find((message) => message.role === "user")?.text) ??
		entry.recoveryData.sessionId.value
	);
}

function scoreSearchField(field: string, query: string, source: RecentSessionMatchSource): number {
	const sourceWeight = getRecentSessionSearchSourceWeight(source);
	if (field === query) {
		return 1200 + sourceWeight;
	}
	if (field.startsWith(query)) {
		return 900 + sourceWeight;
	}
	if (field.includes(query)) {
		return 700 + sourceWeight;
	}
	const queryTerms = query.split(" ").filter(Boolean);
	if (queryTerms.length > 1 && queryTerms.every((term) => field.includes(term))) {
		return 450 + sourceWeight;
	}
	return 0;
}

function getRecentSessionSearchSourceWeight(source: RecentSessionMatchSource): number {
	switch (source) {
		case "recent":
			return 0;
		case "title":
			return 90;
		case "first_prompt":
			return 80;
		case "summary":
			return 60;
		case "recent_user_message":
			return 40;
		case "recent_assistant_message":
			return 20;
		case "session_id":
			return 10;
	}
}

function truncateRecentSessionSnippet(text: string): string {
	return text.length <= 56 ? text : `${text.slice(0, 53).trim()}...`;
}

function normalizeRecentSessionText(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeRecentSessionSearchText(value: string | null | undefined): string | null {
	const normalized = normalizeRecentSessionText(value);
	return normalized ? normalized.toLowerCase() : null;
}
