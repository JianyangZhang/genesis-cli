import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";

const originalRecentSessionMaxEntries = process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES;

afterEach(() => {
	if (originalRecentSessionMaxEntries === undefined) {
		delete process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES;
	} else {
		process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES = originalRecentSessionMaxEntries;
	}
});

describe("SessionManager", () => {
	it("creates a new session and assigns a session file", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "genesis-session-manager-"));
		const manager = SessionManager.create(workspace);

		expect(manager.getSessionId().length).toBeGreaterThan(0);
		expect(manager.getSessionFile()).toBe(join(workspace, ".genesis-local", "sessions", `${manager.getSessionId()}.jsonl`));
	});

	it("keeps only the configured number of recent session files", async () => {
		process.env.GENESIS_RECENT_SESSION_MAX_ENTRIES = "2";
		const workspace = await mkdtemp(join(tmpdir(), "genesis-session-manager-prune-"));
		const createdFiles: string[] = [];

		for (let index = 0; index < 9; index += 1) {
			const manager = SessionManager.create(workspace);
			const file = manager.getSessionFile();
			expect(file).toBeTruthy();
			createdFiles.push(file!);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		const remaining = (await readdir(join(workspace, ".genesis-local", "sessions"))).sort();
		expect(remaining).toHaveLength(7);
		expect(remaining).toEqual(createdFiles.slice(-7).map((file) => file.split("/").pop()).sort());
	});
});
