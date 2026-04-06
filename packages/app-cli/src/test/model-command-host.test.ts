import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRuntime, ModelDescriptor, SessionFacade } from "@pickle-pee/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createModelCommandHost } from "../model-command-host.js";

describe("createModelCommandHost", () => {
	const cleanupPaths: string[] = [];

	afterEach(async () => {
		await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("lists configured models and persists a switched default", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-model-host-agent-"));
		const settingsDir = await mkdtemp(join(tmpdir(), "genesis-model-host-settings-"));
		const settingsPath = join(settingsDir, "settings.json");
		cleanupPaths.push(agentDir, settingsDir);

		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						zai: {
							baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
							api: "openai-completions",
							apiKey: "GENESIS_API_KEY",
							authHeader: true,
							models: [
								{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
								{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
							],
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await writeFile(settingsPath, "{}\n", "utf8");

		let currentModel: ModelDescriptor = { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" };
		let defaultModel = currentModel;
		const session = {
			state: { model: currentModel },
			switchModel: async (model: ModelDescriptor) => {
				currentModel = model;
				(session.state as { model: typeof model }).model = model;
			},
		} as unknown as SessionFacade;
		const runtime = {
			setDefaultModel(model: ModelDescriptor) {
				defaultModel = model;
			},
		} as unknown as AppRuntime;

		const host = createModelCommandHost({
			agentDir,
			settingsPath,
			bootstrapDefaults: {
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
				api: "openai-completions",
			},
		});

		const available = await host.listAvailableModels?.(currentModel);
		expect(available?.map((model) => model.id)).toEqual(["glm-5.1", "glm-5.2"]);

		const result = await host.switchModel?.({ session, runtime, modelId: "glm-5.2" });
		expect(result?.model.id).toBe("glm-5.2");
		expect(currentModel.id).toBe("glm-5.2");
		expect(defaultModel.id).toBe("glm-5.2");
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
			provider: "zai",
			model: "glm-5.2",
		});
	});
});
