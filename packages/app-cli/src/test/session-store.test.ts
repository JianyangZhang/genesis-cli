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
				metadata: {
					summary: "first prompt",
					firstPrompt: "first prompt",
					messageCount: 2,
					fileSizeBytes: 120,
					recentMessages: [
						{ role: "user", text: "first prompt" },
						{ role: "assistant", text: "first answer" },
					],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
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
				metadata: {
					summary: "resume this coding task",
					firstPrompt: "resume this coding task",
					messageCount: 2,
					fileSizeBytes: 180,
					recentMessages: [
						{ role: "user", text: "resume this coding task" },
						{ role: "assistant", text: "Sure, here is the plan." },
					],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				agentDir,
			} as any,
		);

		const recent = await readRecentSessions(storeDir);
		expect(recent.length).toBe(2);
		expect(recent[0]?.recoveryData.sessionId.value).toBe("s_2");
		expect(recent[0]?.recoveryData.metadata?.summary).toBe("resume this coding task");
		expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
			{ role: "user", text: "resume this coding task" },
			{ role: "assistant", text: "Sure, here is the plan." },
		]);
		expect(recent[1]?.title).toBe("first");
	});
});
