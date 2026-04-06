import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecoveryData } from "@pickle-pee/runtime";

export interface RecentSessionEntry {
	readonly recoveryData: SessionRecoveryData;
	readonly title?: string;
	readonly updatedAt: number;
}

interface SessionRecoveryMetadataLike {
	readonly summary?: string;
	readonly firstPrompt?: string;
	readonly messageCount: number;
	readonly fileSizeBytes: number;
	readonly recentMessages: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
}

export function getSessionStoreDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

export async function writeLastSession(
	storeDir: string,
	recoveryData: SessionRecoveryData,
	options?: { readonly title?: string },
): Promise<void> {
	await mkdir(storeDir, { recursive: true });
	const target = join(storeDir, "last.json");
	await writeFile(target, `${JSON.stringify(recoveryData, null, 2)}\n`, "utf8");
	await upsertRecentSession(storeDir, recoveryData, options?.title);
}

export async function readLastSession(storeDir: string): Promise<SessionRecoveryData | null> {
	try {
		return JSON.parse(await readFile(join(storeDir, "last.json"), "utf8")) as SessionRecoveryData;
	} catch {
		return null;
	}
}

export async function readRecentSessions(storeDir: string): Promise<readonly RecentSessionEntry[]> {
	try {
		const parsed = JSON.parse(await readFile(join(storeDir, "recent.json"), "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		const recent = parsed as RecentSessionEntry[];
		let mutated = false;
		const hydrated = await Promise.all(
			recent.map(async (entry) => {
				const nextRecoveryData = await hydrateRecentSessionRecoveryData(entry.recoveryData);
				if (nextRecoveryData !== entry.recoveryData) {
					mutated = true;
					return {
						...entry,
						recoveryData: nextRecoveryData,
					};
				}
				return entry;
			}),
		);
		if (mutated) {
			try {
				await writeFile(join(storeDir, "recent.json"), `${JSON.stringify(hydrated, null, 2)}\n`, "utf8");
			} catch {}
		}
		return hydrated;
	} catch {
		return [];
	}
}

async function hydrateRecentSessionRecoveryData<T extends SessionRecoveryData>(data: T): Promise<T> {
	if (hasDisplayableSessionMetadata(data.metadata)) {
		return data;
	}
	const { loadSessionMetadataFromSessionFile } = await import("@pickle-pee/kernel");
	const loaded = await loadSessionMetadataFromSessionFile(data.sessionFile);
	if (!loaded) {
		return data;
	}
	return {
		...data,
		metadata: {
			summary: loaded.summary,
			firstPrompt: loaded.firstPrompt,
			messageCount: loaded.messageCount,
			fileSizeBytes: loaded.fileSizeBytes,
			recentMessages: loaded.recentMessages.map((message) => ({
				role: message.role,
				text: message.text,
			})),
		},
	};
}

function hasDisplayableSessionMetadata(metadata: SessionRecoveryMetadataLike | null | undefined): boolean {
	if (!metadata) {
		return false;
	}
	if (typeof metadata.summary === "string" && metadata.summary.trim().length > 0) {
		return true;
	}
	if (typeof metadata.firstPrompt === "string" && metadata.firstPrompt.trim().length > 0) {
		return true;
	}
	return metadata.recentMessages.some((message: { readonly text: string }) => message.text.trim().length > 0);
}

async function upsertRecentSession(storeDir: string, recoveryData: SessionRecoveryData, title?: string): Promise<void> {
	const existing = await readRecentSessions(storeDir);
	const next: RecentSessionEntry = {
		recoveryData,
		title,
		updatedAt: Date.now(),
	};
	const filtered = existing.filter((entry) => entry.recoveryData.sessionId.value !== recoveryData.sessionId.value);
	const compacted = [next, ...filtered].slice(0, 25);
	await writeFile(join(storeDir, "recent.json"), `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
}
