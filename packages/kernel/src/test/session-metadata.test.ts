import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionMetadataFromSessionFile } from "../session-metadata.js";

const tempDirs: string[] = [];

describe("loadSessionMetadataFromSessionFile", () => {
	afterEach(async () => {
		const { rm } = await import("node:fs/promises");
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("extracts summary and recent messages from a session transcript", async () => {
		const dir = await mkdtemp(join(tmpdir(), "genesis-session-metadata-"));
		tempDirs.push(dir);
		await mkdir(dir, { recursive: true });
		const file = join(dir, "session.jsonl");
		await writeFile(
			file,
			[
				JSON.stringify({ type: "session", id: "s_1", timestamp: new Date().toISOString(), cwd: dir }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "inspect the resume flow" },
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: "I found the current contract gap." },
				}),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "continue with architecture cleanup" },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const metadata = await loadSessionMetadataFromSessionFile(file);
		expect(metadata?.summary).toBe("continue with architecture cleanup");
		expect(metadata?.firstPrompt).toBe("inspect the resume flow");
		expect(metadata?.messageCount).toBe(3);
		expect(metadata?.recentMessages).toEqual([
			{ role: "user", text: "inspect the resume flow" },
			{ role: "assistant", text: "I found the current contract gap." },
			{ role: "user", text: "continue with architecture cleanup" },
		]);
	});
});
