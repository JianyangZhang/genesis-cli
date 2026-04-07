import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelCommandHost } from "../model-command-host.js";

describe("createModelCommandHost", () => {
	let settingsDir: string | undefined;
	let agentDir: string | undefined;

	afterEach(async () => {
		if (settingsDir) {
			await rm(settingsDir, { recursive: true, force: true });
			settingsDir = undefined;
		}
		if (agentDir) {
			await rm(agentDir, { recursive: true, force: true });
			agentDir = undefined;
		}
	});

	it("persists only model when switching models", async () => {
		settingsDir = await mkdtemp(join(tmpdir(), "genesis-model-host-"));
		agentDir = await mkdtemp(join(tmpdir(), "genesis-model-agent-"));
		const settingsPath = join(settingsDir, "settings.json");
		await writeFile(settingsPath, "{}\n", "utf8");
		const host = createModelCommandHost({
			agentDir,
			settingsPath,
			bootstrapDefaults: {
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
				api: "openai-completions",
			},
		});

		await host.switchModel?.({
			modelId: "glm-5.2",
			session: {
				state: {
					model: {
						id: "glm-5.1",
						provider: "zai",
						displayName: "glm-5.1",
					},
				},
				switchModel: async () => {},
			} as never,
			runtime: {
				setDefaultModel: () => {},
			} as never,
		});

		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			model: "glm-5.2",
		});
	});

	it("keeps any existing provider value unchanged when switching models", async () => {
		settingsDir = await mkdtemp(join(tmpdir(), "genesis-model-host-"));
		agentDir = await mkdtemp(join(tmpdir(), "genesis-model-agent-"));
		const settingsPath = join(settingsDir, "settings.json");
		await writeFile(
			settingsPath,
			`${JSON.stringify({ provider: "anthropic", model: "claude-3-7-sonnet" })}\n`,
			"utf8",
		);
		const host = createModelCommandHost({
			agentDir,
			settingsPath,
			bootstrapDefaults: {
				baseUrl: "https://api.anthropic.com/",
				api: "anthropic-messages",
			},
		});

		await host.switchModel?.({
			modelId: "claude-opus-4-6",
			session: {
				state: {
					model: {
						id: "claude-3-7-sonnet",
						provider: "anthropic",
						displayName: "Claude 3.7 Sonnet",
					},
				},
				switchModel: async () => {},
			} as never,
			runtime: {
				setDefaultModel: () => {},
			} as never,
		});

		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
	});
});
