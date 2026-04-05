import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSessionStoreDir, readLastSession, readRecentSessions, writeLastSession } from "../session-store.js";

describe("session-store", () => {
	it("writes and reads last session recovery data", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-cli-agent-"));
		const storeDir = getSessionStoreDir(agentDir);

		const data = {
			sessionId: { value: "s_test" },
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
			agentDir,
			sessionFile: join(agentDir, "sessions", "s_test.json"),
		};

		await writeLastSession(storeDir, data as any);
		const loaded = await readLastSession(storeDir);
		expect(loaded?.sessionId.value).toBe("s_test");
		expect(loaded?.model.id).toBe("glm-5.1");
		expect(loaded?.agentDir).toBe(agentDir);
	});

	it("maintains a recent sessions list", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-cli-agent-"));
		const storeDir = getSessionStoreDir(agentDir);

		await writeLastSession(
			storeDir,
			{
				sessionId: { value: "s_1" },
				model: { id: "glm-5.1", provider: "zai" },
				toolSet: ["read"],
				planSummary: null,
				compactionSummary: null,
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
				sessionFile: join(agentDir, "sessions", "s_1.json"),
			} as any,
			{ title: "first" },
		);
		await writeLastSession(
			storeDir,
			{
				sessionId: { value: "s_2" },
				model: { id: "glm-5.1", provider: "zai" },
				toolSet: ["read"],
				planSummary: null,
				compactionSummary: null,
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
				sessionFile: join(agentDir, "sessions", "s_2.json"),
			} as any,
			{ title: "second" },
		);

		const recent = await readRecentSessions(storeDir);
		expect(recent.length).toBe(2);
		expect(recent[0]?.recoveryData.sessionId.value).toBe("s_2");
		expect(recent[0]?.title).toBe("second");
	});
});
