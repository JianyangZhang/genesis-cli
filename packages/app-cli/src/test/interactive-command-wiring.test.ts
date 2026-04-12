import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveResumableRecoveryData } from "../interactive-command-wiring.js";

describe("resolveResumableRecoveryData", () => {
	it("returns recovery data when sessionFile exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "genesis-resume-check-"));
		const sessionFile = join(dir, "session.jsonl");
		await writeFile(sessionFile, '{"cwd":"/tmp","sessionId":"abc"}\n', "utf8");
		const recoveryData = {
			sessionId: { value: "runtime-session-id" },
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["bash"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			sessionFile,
		};

		const resolved = await resolveResumableRecoveryData(recoveryData);
		expect(resolved).toEqual(recoveryData);
	});

	it("returns null when sessionFile is missing", async () => {
		const resolved = await resolveResumableRecoveryData({
			sessionId: { value: "runtime-session-id" },
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["bash"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
		});
		expect(resolved).toBeNull();
	});

	it("returns null when sessionFile path is invalid", async () => {
		const resolved = await resolveResumableRecoveryData({
			sessionId: { value: "runtime-session-id" },
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["bash"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
			sessionFile: "/tmp/non-existent-session-file.jsonl",
		});
		expect(resolved).toBeNull();
	});
});
