import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type {
	RecentSessionEntry,
	RecentSessionMatchSource,
	RecentSessionSearchHit,
	SessionRecoveryData,
	SessionRecoveryMetadata,
	SessionTranscriptMessagePreview,
} from "../types/index.js";

export const MAX_RECENT_SESSION_COUNT = 10;

export function getRecentSessionCatalogDir(historyDir: string): string {
	return historyDir;
}

export async function recordRecentSession(
	historyDir: string | undefined,
	recoveryData: SessionRecoveryData,
	options?: { readonly title?: string },
): Promise<void> {
	if (!historyDir) {
		return;
	}
	const storeDir = getRecentSessionCatalogDir(historyDir);
	await persistRecentSessionRecoveryData(storeDir, recoveryData, options);
}

export async function recordRecentSessionInput(
	historyDir: string | undefined,
	recoveryData: SessionRecoveryData,
	input: string,
	options?: { readonly title?: string },
): Promise<void> {
	if (!historyDir) {
		return;
	}
	const storeDir = getRecentSessionCatalogDir(historyDir);
	await persistRecentSessionRecoveryData(storeDir, applyRecentSessionInput(recoveryData, input), options);
}

export async function recordRecentSessionAssistantText(
	historyDir: string | undefined,
	recoveryData: SessionRecoveryData,
	text: string,
	options?: { readonly title?: string },
): Promise<void> {
	if (!historyDir) {
		return;
	}
	const storeDir = getRecentSessionCatalogDir(historyDir);
	await persistRecentSessionRecoveryData(storeDir, applyRecentSessionAssistantText(recoveryData, text), options);
}

export async function recordRecentSessionEvent(
	historyDir: string | undefined,
	recoveryData: SessionRecoveryData,
	event: RuntimeEvent,
	options?: { readonly title?: string },
): Promise<void> {
	if (!historyDir) {
		return;
	}
	const storeDir = getRecentSessionCatalogDir(historyDir);
	await persistRecentSessionRecoveryData(storeDir, applyRecentSessionRuntimeEvent(recoveryData, event), options);
}

export async function listRecentSessions(historyDir: string | undefined): Promise<readonly RecentSessionEntry[]> {
	if (!historyDir) {
		return [];
	}
	try {
		const parsed = JSON.parse(
			await readFile(join(getRecentSessionCatalogDir(historyDir), "recent.json"), "utf8"),
		) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return (parsed as RecentSessionEntry[]).map((entry) => normalizeRecentSessionEntry(entry));
	} catch {
		return [];
	}
}

export async function pruneRecentSessions(
	historyDir: string | undefined,
	maxEntries = MAX_RECENT_SESSION_COUNT,
): Promise<{ readonly before: number; readonly after: number; readonly removed: number }> {
	if (!historyDir) {
		return { before: 0, after: 0, removed: 0 };
	}
	const storeDir = getRecentSessionCatalogDir(historyDir);
	const existing = await readRecentSessionsByDir(storeDir);
	const normalized = existing.map((entry) => normalizeRecentSessionEntry(entry));
	const compacted = normalized.slice(0, Math.max(0, maxEntries));
	const before = existing.length;
	const after = compacted.length;
	const last = await readLastRecentSessionByDir(storeDir);
	const normalizedLast = last ? enrichRecoveryDataForRecentCatalog(normalizeRecentSessionRecoveryData(last)) : null;
	if (before !== after || JSON.stringify(existing) !== JSON.stringify(compacted)) {
		await mkdir(storeDir, { recursive: true });
		await writeFile(join(storeDir, "recent.json"), `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
	}
	if (last && JSON.stringify(last) !== JSON.stringify(normalizedLast)) {
		await mkdir(storeDir, { recursive: true });
		await writeFile(join(storeDir, "last.json"), `${JSON.stringify(normalizedLast, null, 2)}\n`, "utf8");
	}
	return { before, after, removed: Math.max(0, before - after) };
}

export async function searchRecentSessions(
	historyDir: string | undefined,
	query: string,
): Promise<readonly RecentSessionSearchHit[]> {
	const normalizedQuery = normalizeRecentSessionSearchText(query);
	const recent = await listRecentSessions(historyDir);
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
	const compacted = [next, ...filtered].slice(0, MAX_RECENT_SESSION_COUNT);
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

async function readLastRecentSessionByDir(storeDir: string): Promise<SessionRecoveryData | null> {
	try {
		return JSON.parse(await readFile(join(storeDir, "last.json"), "utf8")) as SessionRecoveryData;
	} catch {
		return null;
	}
}

async function readRecentSessionEntryById(storeDir: string, sessionId: string): Promise<SessionRecoveryData | null> {
	try {
		return JSON.parse(await readFile(getRecentSessionEntryFilePath(storeDir, sessionId), "utf8")) as SessionRecoveryData;
	} catch {
		return null;
	}
}

function getRecentSessionEntriesDir(storeDir: string): string {
	return join(storeDir, "entries");
}

function getRecentSessionEntryFilePath(storeDir: string, sessionId: string): string {
	return join(getRecentSessionEntriesDir(storeDir), `${sessionId}.json`);
}

function pickRecentSessionStoredTitle(recoveryData: SessionRecoveryData, explicitTitle?: string): string | undefined {
	const normalizedExplicit = normalizeRecentSessionText(explicitTitle);
	if (normalizedExplicit) {
		return normalizedExplicit;
	}
	const metadata = recoveryData.metadata;
	return (
		normalizeRecentSessionText(metadata?.firstPrompt) ??
		normalizeRecentSessionText(metadata?.resumeSummary?.title) ??
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
	pushSearchCandidate(candidates, "title", metadata?.resumeSummary?.title, query);
	pushSearchCandidate(candidates, "first_prompt", metadata?.firstPrompt, query);
	pushSearchCandidate(candidates, "first_prompt", metadata?.resumeSummary?.userIntent, query);
	pushSearchCandidate(candidates, "summary", metadata?.summary, query);
	pushSearchCandidate(candidates, "summary", metadata?.resumeSummary?.goal, query);
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
		normalizeRecentSessionText(metadata?.resumeSummary?.title) ??
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
		normalizeRecentSessionText(metadata?.resumeSummary?.goal) ??
		normalizeRecentSessionText(metadata?.summary) ??
		normalizeRecentSessionText(metadata?.resumeSummary?.assistantState) ??
		normalizeRecentSessionText(metadata?.recentMessages.find((message) => message.role === "assistant")?.text) ??
		normalizeRecentSessionText(metadata?.recentMessages.find((message) => message.role === "user")?.text) ??
		entry.recoveryData.sessionId.value
	);
}

function normalizeRecentSessionEntry(entry: RecentSessionEntry): RecentSessionEntry {
	const recoveryData = enrichRecoveryDataForRecentCatalog(normalizeRecentSessionRecoveryData(entry.recoveryData), entry.updatedAt);
	return {
		...entry,
		recoveryData,
		title: pickRecentSessionStoredTitle(recoveryData, entry.title),
	};
}

async function materializeRecentSessionRecoveryData(recoveryData: SessionRecoveryData): Promise<SessionRecoveryData> {
	const normalized = normalizeRecentSessionRecoveryData(recoveryData);
	const metadata =
		normalized.metadata ??
		(normalized.sessionFile ? await loadMetadataFromSessionFile(normalized.sessionFile) : null) ??
		undefined;
	return enrichRecoveryDataForRecentCatalog(
		metadata
			? {
					...normalized,
					metadata,
				}
			: normalized,
	);
}

async function persistRecentSessionRecoveryData(
	storeDir: string,
	recoveryData: SessionRecoveryData,
	options?: { readonly title?: string },
): Promise<void> {
	const existing = await readRecentSessionEntryById(storeDir, recoveryData.sessionId.value);
	const mergedRecoveryData = mergeRecentSessionRecoveryData(existing, recoveryData);
	const enrichedRecoveryData = await materializeRecentSessionRecoveryData(mergedRecoveryData);
	await mkdir(storeDir, { recursive: true });
	await mkdir(getRecentSessionEntriesDir(storeDir), { recursive: true });
	await writeFile(join(storeDir, "last.json"), `${JSON.stringify(enrichedRecoveryData, null, 2)}\n`, "utf8");
	await writeFile(
		getRecentSessionEntryFilePath(storeDir, enrichedRecoveryData.sessionId.value),
		`${JSON.stringify(enrichedRecoveryData, null, 2)}\n`,
		"utf8",
	);
	await upsertRecentSession(storeDir, enrichedRecoveryData, options?.title);
}

function mergeRecentSessionRecoveryData(
	existing: SessionRecoveryData | null,
	incoming: SessionRecoveryData,
): SessionRecoveryData {
	if (!existing) {
		return incoming;
	}
	return {
		...incoming,
		model: {
			...existing.model,
			...incoming.model,
			id: normalizeRecentSessionIdentityText(incoming.model.id) ?? existing.model.id,
			provider: normalizeRecentSessionIdentityText(incoming.model.provider) ?? existing.model.provider,
			displayName: normalizeRecentSessionIdentityText(incoming.model.displayName) ?? existing.model.displayName,
		},
		toolSet: incoming.toolSet.length > 0 ? incoming.toolSet : existing.toolSet,
		metadata: mergeRecentSessionMetadata(existing.metadata, incoming.metadata),
		workingDirectory: incoming.workingDirectory ?? existing.workingDirectory,
		sessionFile: incoming.sessionFile ?? existing.sessionFile,
		agentDir: incoming.agentDir ?? existing.agentDir,
	};
}

function mergeRecentSessionMetadata(
	existing: SessionRecoveryMetadata | null | undefined,
	incoming: SessionRecoveryMetadata | null | undefined,
): SessionRecoveryMetadata | undefined {
	if (!existing && !incoming) {
		return undefined;
	}
	const mergedRecentMessages = mergeRecentSessionMessages(existing?.recentMessages, incoming?.recentMessages);
	return {
		firstPrompt: normalizeRecentSessionText(existing?.firstPrompt) ?? normalizeRecentSessionText(incoming?.firstPrompt) ?? undefined,
		summary: normalizeRecentSessionText(incoming?.summary) ?? normalizeRecentSessionText(existing?.summary) ?? undefined,
		messageCount: Math.max(incoming?.messageCount ?? 0, existing?.messageCount ?? 0, mergedRecentMessages.length),
		fileSizeBytes: Math.max(incoming?.fileSizeBytes ?? 0, existing?.fileSizeBytes ?? 0),
		recentMessages: mergedRecentMessages,
		resumeSummary:
			incoming?.resumeSummary?.source === "model"
				? incoming.resumeSummary
				: existing?.resumeSummary?.source === "model"
					? existing.resumeSummary
					: incoming?.resumeSummary ?? existing?.resumeSummary ?? null,
	};
}

function mergeRecentSessionMessages(
	existing: readonly SessionTranscriptMessagePreview[] | undefined,
	incoming: readonly SessionTranscriptMessagePreview[] | undefined,
): readonly SessionTranscriptMessagePreview[] {
	const previous = existing ?? [];
	const nextMessages = incoming ?? [];
	if (nextMessages.length === 0) {
		return previous;
	}
	if (isRecentSessionMessagePrefix(previous, nextMessages)) {
		return nextMessages;
	}
	if (isRecentSessionMessagePrefix(nextMessages, previous)) {
		return previous;
	}
	const overlap = findRecentSessionMessageOverlap(previous, nextMessages);
	if (overlap > 0) {
		return [...previous, ...nextMessages.slice(overlap)];
	}
	const merged = [...previous];
	for (const message of nextMessages) {
		const next = appendRecentSessionMessage(merged, message);
		merged.splice(0, merged.length, ...next);
	}
	return merged;
}

function isRecentSessionMessagePrefix(
	prefix: readonly SessionTranscriptMessagePreview[],
	full: readonly SessionTranscriptMessagePreview[],
): boolean {
	if (prefix.length > full.length) {
		return false;
	}
	return prefix.every((message, index) => {
		const candidate = full[index];
		return candidate?.role === message.role && candidate.text === message.text;
	});
}

function findRecentSessionMessageOverlap(
	previous: readonly SessionTranscriptMessagePreview[],
	next: readonly SessionTranscriptMessagePreview[],
): number {
	const maxOverlap = Math.min(previous.length, next.length);
	for (let size = maxOverlap; size > 0; size -= 1) {
		let matches = true;
		for (let index = 0; index < size; index += 1) {
			const previousMessage = previous[previous.length - size + index];
			const nextMessage = next[index];
			if (previousMessage?.role !== nextMessage?.role || previousMessage?.text !== nextMessage?.text) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return size;
		}
	}
	return 0;
}

function applyRecentSessionInput(recoveryData: SessionRecoveryData, input: string): SessionRecoveryData {
	const text = normalizeRecentSessionText(input);
	if (!text) {
		return recoveryData;
	}
	const metadata = ensureRecentSessionMetadata(recoveryData.metadata);
	const recentMessages = appendRecentSessionMessage(metadata.recentMessages, { role: "user", text });
	return {
		...recoveryData,
		metadata: {
			...metadata,
			firstPrompt: metadata.firstPrompt ?? text,
			messageCount: Math.max(metadata.messageCount, recentMessages.length),
			recentMessages,
		},
	};
}

function applyRecentSessionAssistantText(recoveryData: SessionRecoveryData, text: string): SessionRecoveryData {
	const normalized = normalizeRecentSessionText(text);
	if (!normalized) {
		return recoveryData;
	}
	const metadata = ensureRecentSessionMetadata(recoveryData.metadata);
	const recentMessages = appendRecentSessionMessage(metadata.recentMessages, { role: "assistant", text: normalized });
	return {
		...recoveryData,
		metadata: {
			...metadata,
			messageCount: Math.max(metadata.messageCount, recentMessages.length),
			recentMessages,
			summary: metadata.summary ?? normalized,
		},
	};
}

function applyRecentSessionRuntimeEvent(recoveryData: SessionRecoveryData, event: RuntimeEvent): SessionRecoveryData {
	if (event.category !== "compaction" || event.type !== "compaction_completed") {
		return recoveryData;
	}
	const compactedSummary = normalizeRecentSessionText(event.summary.compactedSummary);
	if (!compactedSummary) {
		return recoveryData;
	}
	const metadata = ensureRecentSessionMetadata(recoveryData.metadata);
	return {
		...recoveryData,
		metadata: {
			...metadata,
			summary: metadata.summary ?? compactedSummary,
		},
	};
}

function ensureRecentSessionMetadata(metadata: SessionRecoveryMetadata | null | undefined): SessionRecoveryMetadata {
	return {
		firstPrompt: metadata?.firstPrompt,
		summary: metadata?.summary,
		messageCount: metadata?.messageCount ?? 0,
		fileSizeBytes: metadata?.fileSizeBytes ?? 0,
		recentMessages: metadata?.recentMessages ?? [],
		resumeSummary: metadata?.resumeSummary ?? null,
	};
}

function appendRecentSessionMessage(
	recentMessages: readonly SessionTranscriptMessagePreview[],
	next: SessionTranscriptMessagePreview,
): readonly SessionTranscriptMessagePreview[] {
	const normalized = normalizeRecentSessionText(next.text);
	if (!normalized) {
		return recentMessages;
	}
	const tail = [...recentMessages];
	const last = tail.at(-1);
	if (last && last.role === next.role && next.role === "assistant") {
		tail[tail.length - 1] = {
			role: "assistant",
			text: `${last.text}${normalized}`,
		};
		return trimRecentSessionMessages(tail);
	}
	return trimRecentSessionMessages([...tail, { role: next.role, text: normalized }]);
}

function trimRecentSessionMessages(messages: readonly SessionTranscriptMessagePreview[]): readonly SessionTranscriptMessagePreview[] {
	return messages.slice(-6);
}

async function loadMetadataFromSessionFile(sessionFile: string) {
	const kernel = (await import("@pickle-pee/kernel")) as {
		loadSessionMetadataFromSessionFile: (file: string) => Promise<SessionRecoveryData["metadata"] | null>;
	};
	return kernel.loadSessionMetadataFromSessionFile(sessionFile);
}

function enrichRecoveryDataForRecentCatalog(recoveryData: SessionRecoveryData, now = Date.now()): SessionRecoveryData {
	const metadata = recoveryData.metadata;
	if (!metadata) {
		return recoveryData;
	}
	const resumeSummary = buildRuleResumeSummary(metadata, now);
	if (!resumeSummary) {
		return recoveryData;
	}
	return {
		...recoveryData,
		metadata: {
			...metadata,
			firstPrompt: normalizeRecentSessionText(metadata.firstPrompt) ?? undefined,
			summary: normalizeRecentSessionText(metadata.summary) ?? undefined,
			recentMessages: metadata.recentMessages
				.map((message) => ({
					role: message.role,
					text: normalizeRecentSessionText(message.text) ?? "",
				}))
				.filter((message) => message.text.length > 0),
			resumeSummary,
		},
	};
}

function normalizeRecentSessionRecoveryData(recoveryData: SessionRecoveryData): SessionRecoveryData {
	return {
		...recoveryData,
		model: {
			...recoveryData.model,
			id: normalizeRecentSessionIdentityText(recoveryData.model.id) ?? "",
			provider: normalizeRecentSessionIdentityText(recoveryData.model.provider) ?? "",
			displayName: normalizeRecentSessionIdentityText(recoveryData.model.displayName) ?? undefined,
		},
		metadata: normalizeRecentSessionMetadata(recoveryData.metadata),
	};
}

function normalizeRecentSessionMetadata(
	metadata: SessionRecoveryData["metadata"],
): SessionRecoveryData["metadata"] | undefined {
	if (!metadata) {
		return undefined;
	}
	const recentMessages = metadata.recentMessages
		.map((message) => ({
			role: message.role,
			text: normalizeRecentSessionText(message.text) ?? "",
		}))
		.filter((message) => message.text.length > 0);
	return {
		...metadata,
		firstPrompt: normalizeRecentSessionText(metadata.firstPrompt) ?? undefined,
		summary: normalizeRecentSessionText(metadata.summary) ?? undefined,
		recentMessages,
		resumeSummary: metadata.resumeSummary
			? {
					...metadata.resumeSummary,
					title: normalizeRecentSessionText(metadata.resumeSummary.title) ?? undefined,
					goal: normalizeRecentSessionText(metadata.resumeSummary.goal) ?? undefined,
					userIntent: normalizeRecentSessionText(metadata.resumeSummary.userIntent) ?? undefined,
					assistantState: normalizeRecentSessionText(metadata.resumeSummary.assistantState) ?? undefined,
					lastUserTurn: normalizeRecentSessionText(metadata.resumeSummary.lastUserTurn) ?? undefined,
					lastAssistantTurn: normalizeRecentSessionText(metadata.resumeSummary.lastAssistantTurn) ?? undefined,
				}
			: metadata.resumeSummary ?? undefined,
	};
}

function buildRuleResumeSummary(
	metadata: NonNullable<SessionRecoveryData["metadata"]>,
	now: number,
): NonNullable<NonNullable<SessionRecoveryData["metadata"]>["resumeSummary"]> | null {
	const firstPrompt = normalizeRecentSessionText(metadata.firstPrompt);
	const summary = normalizeRecentSessionText(metadata.summary);
	const recentUserMessages = metadata.recentMessages
		.filter((message) => message.role === "user")
		.map((message) => normalizeRecentSessionText(message.text))
		.filter((value): value is string => value !== null);
	const recentAssistantMessages = metadata.recentMessages
		.filter((message) => message.role === "assistant")
		.map((message) => normalizeRecentSessionText(message.text))
		.filter((value): value is string => value !== null);
	const existing = metadata.resumeSummary;
	const title = summary ?? firstPrompt ?? recentUserMessages[0] ?? undefined;
	const goal = summary ?? firstPrompt ?? recentUserMessages[0] ?? undefined;
	const userIntent = firstPrompt ?? recentUserMessages[0] ?? summary ?? undefined;
	const lastUserTurn = recentUserMessages.at(-1);
	const lastAssistantTurn = recentAssistantMessages.at(-1);
	const assistantState = lastAssistantTurn ?? undefined;
	if (!title && !goal && !userIntent && !assistantState && !lastUserTurn && !lastAssistantTurn) {
		return existing ?? null;
	}
	if (existing?.source === "model") {
		return existing;
	}
	return {
		title,
		goal,
		userIntent,
		assistantState,
		lastUserTurn,
		lastAssistantTurn,
		generatedAt: existing?.generatedAt ?? now,
		source: "rule",
		version: 1,
	};
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

function normalizeRecentSessionIdentityText(value: string | null | undefined): string | null {
	const normalized = normalizeRecentSessionText(value);
	if (!normalized) {
		return null;
	}
	return normalized.toLowerCase() === "unknown" ? null : normalized;
}

function normalizeRecentSessionSearchText(value: string | null | undefined): string | null {
	const normalized = normalizeRecentSessionText(value);
	return normalized ? normalized.toLowerCase() : null;
}
