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

async function upsertRecentSession(
	storeDir: string,
	recoveryData: SessionRecoveryData,
	title?: string,
): Promise<void> {
	const existing = await readRecentSessionsByDir(storeDir);
	const next: RecentSessionEntry = {
		recoveryData,
		title,
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
