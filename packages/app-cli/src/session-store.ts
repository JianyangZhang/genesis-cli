import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecoveryData } from "@genesis-cli/runtime";

export function getSessionStoreDir(agentDir: string): string {
	return join(agentDir, "sessions");
}

export async function writeLastSession(storeDir: string, recoveryData: SessionRecoveryData): Promise<void> {
	await mkdir(storeDir, { recursive: true });
	const target = join(storeDir, "last.json");
	await writeFile(target, `${JSON.stringify(recoveryData, null, 2)}\n`, "utf8");
}

export async function readLastSession(storeDir: string): Promise<SessionRecoveryData | null> {
	try {
		return JSON.parse(await readFile(join(storeDir, "last.json"), "utf8")) as SessionRecoveryData;
	} catch {
		return null;
	}
}
