import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecoveryData } from "@genesis-cli/runtime";

export interface RecentSessionEntry {
	readonly recoveryData: SessionRecoveryData;
	readonly title?: string;
	readonly updatedAt: number;
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
		return parsed as RecentSessionEntry[];
	} catch {
		return [];
	}
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
