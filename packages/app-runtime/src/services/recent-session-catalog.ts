import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecentSessionEntry, SessionRecoveryData } from "../types/index.js";

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
): Promise<readonly RecentSessionEntry[]> {
	const normalizedQuery = normalizeRecentSessionSearchText(query);
	if (!normalizedQuery) {
		return [];
	}
	const recent = await listRecentSessions(agentDir);
	return recent
		.map((entry) => ({ entry, score: scoreRecentSessionSearch(entry, normalizedQuery) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
		.map((item) => item.entry)
		.slice(0, 10);
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

function scoreRecentSessionSearch(entry: RecentSessionEntry, query: string): number {
	const title = normalizeRecentSessionSearchText(entry.title);
	const firstPrompt = normalizeRecentSessionSearchText(entry.recoveryData.metadata?.firstPrompt);
	const summary = normalizeRecentSessionSearchText(entry.recoveryData.metadata?.summary);
	const sessionId = entry.recoveryData.sessionId.value.toLowerCase();
	const recentMessages =
		entry.recoveryData.metadata?.recentMessages.map((message) => normalizeRecentSessionSearchText(message.text)) ?? [];
	const fields = [title, firstPrompt, summary, ...recentMessages].filter((value): value is string => Boolean(value));
	let score = 0;

	for (const field of fields) {
		score = Math.max(score, scoreSearchField(field, query));
	}
	if (sessionId === query) {
		score = Math.max(score, 500);
	} else if (sessionId.startsWith(query)) {
		score = Math.max(score, 350);
	} else if (sessionId.includes(query)) {
		score = Math.max(score, 150);
	}
	return score;
}

function scoreSearchField(field: string, query: string): number {
	if (field === query) {
		return 1200;
	}
	if (field.startsWith(query)) {
		return 900;
	}
	if (field.includes(query)) {
		return 700;
	}
	const queryTerms = query.split(" ").filter(Boolean);
	if (queryTerms.length > 1 && queryTerms.every((term) => field.includes(term))) {
		return 450;
	}
	return 0;
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
