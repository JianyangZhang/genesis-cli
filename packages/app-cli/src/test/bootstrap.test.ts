import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAgentDirBootstrapped } from "../bootstrap.js";

describe("ensureAgentDirBootstrapped", () => {
	it("creates models.json with the requested provider and model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "genesis-cli-bootstrap-"));
		await ensureAgentDirBootstrapped({
			agentDir: dir,
			provider: "zai",
			modelId: "glm-5.1",
			bootstrapBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
			bootstrapApi: "openai-completions",
		});

		const models = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
			providers: Record<string, unknown>;
		};
		const provider = models.providers.zai as any;
		expect(provider.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4/");
		expect(provider.api).toBe("openai-completions");
		expect(Array.isArray(provider.models)).toBe(true);
		expect(provider.models.some((model: any) => model.id === "glm-5.1")).toBe(true);
	});

	it("does not override an existing configured provider/model entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "genesis-cli-bootstrap-"));
		const existing = {
			providers: {
				zai: {
					baseUrl: "https://example.com/",
					api: "openai-completions",
					apiKey: "GENESIS_API_KEY",
					authHeader: true,
					models: [{ id: "glm-5.1", name: "glm-5.1", reasoning: false }],
				},
			},
		};
		await writeFile(join(dir, "models.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf8");
		const before = await readFile(join(dir, "models.json"), "utf8");

		await ensureAgentDirBootstrapped({
			agentDir: dir,
			provider: "zai",
			modelId: "glm-5.1",
			bootstrapBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
		});

		const after = await readFile(join(dir, "models.json"), "utf8");
		expect(after).toBe(before);
	});
});
