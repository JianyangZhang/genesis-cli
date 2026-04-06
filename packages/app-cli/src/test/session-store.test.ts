import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
		const transcriptDir = join(agentDir, "transcripts");
		await mkdir(transcriptDir, { recursive: true });
		await writeFile(
			join(transcriptDir, "s_1.jsonl"),
			[
				JSON.stringify({ type: "session", id: "s_1", timestamp: new Date().toISOString(), cwd: agentDir }),
				JSON.stringify({
					type: "message",
					id: "m_1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "first prompt" },
				}),
				JSON.stringify({
					type: "message",
					id: "m_2",
					parentId: "m_1",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: "first answer" },
				}),
			].join("\n") + "\n",
			"utf8",
		);
		await writeFile(
			join(transcriptDir, "s_2.jsonl"),
			[
				JSON.stringify({ type: "session", id: "s_2", timestamp: new Date().toISOString(), cwd: agentDir }),
				JSON.stringify({
					type: "message",
					id: "m_1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "resume this coding task" },
				}),
				JSON.stringify({
					type: "message",
					id: "m_2",
					parentId: "m_1",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: "Sure, here is the plan." },
				}),
			].join("\n") + "\n",
			"utf8",
		);

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
				sessionFile: join(transcriptDir, "s_1.jsonl"),
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
				sessionFile: join(transcriptDir, "s_2.jsonl"),
			} as any,
		);

		const recent = await readRecentSessions(storeDir);
		expect(recent.length).toBe(2);
		expect(recent[0]?.recoveryData.sessionId.value).toBe("s_2");
		expect(recent[0]?.summary).toBe("resume this coding task");
		expect(recent[0]?.recentMessages).toEqual([
			{ role: "user", text: "resume this coding task" },
			{ role: "assistant", text: "Sure, here is the plan." },
		]);
		expect(recent[1]?.title).toBe("first");
	});
});
