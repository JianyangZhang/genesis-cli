import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../auth-storage.js";
import { ModelRegistry } from "../model-registry.js";

const originalEnv = {
	GENESIS_API_KEY: process.env.GENESIS_API_KEY,
	ZAI_API_KEY: process.env.ZAI_API_KEY,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
});

async function createRegistry(): Promise<ModelRegistry> {
	const dir = await mkdtemp(join(tmpdir(), "genesis-model-registry-"));
	const modelsPath = join(dir, "models.json");
	await writeFile(
		modelsPath,
		JSON.stringify({
			providers: {
				zai: {
					apiKey: "GENESIS_API_KEY",
					models: [{ id: "glm-5.1" }],
				},
			},
		}),
		"utf8",
	);
	return ModelRegistry.create(AuthStorage.create(), modelsPath);
}

describe("ModelRegistry.getRequestAuth", () => {
	it("treats an unset env-backed api key as missing", async () => {
		delete process.env.GENESIS_API_KEY;
		delete process.env.ZAI_API_KEY;
		const registry = await createRegistry();
		const model = registry.find("zai", "glm-5.1");
		expect(model).toBeDefined();

		const auth = registry.getRequestAuth(model!);
		expect(auth.ok).toBe(false);
		if (!auth.ok) {
			expect(auth.error).toContain("No API key found");
			expect(auth.error).toContain("GENESIS_API_KEY");
			expect(auth.source.kind).toBe("missing");
			expect(auth.source.detail).toBe("GENESIS_API_KEY");
		}
	});

	it("treats placeholder api keys as unconfigured", async () => {
		process.env.GENESIS_API_KEY = "your_zhipu_api_key";
		const registry = await createRegistry();
		const model = registry.find("zai", "glm-5.1");
		expect(model).toBeDefined();

		const auth = registry.getRequestAuth(model!);
		expect(auth.ok).toBe(false);
		if (!auth.ok) {
			expect(auth.error).toContain("Placeholder API key configured");
			expect(auth.error).toContain("GENESIS_API_KEY");
			expect(auth.source.kind).toBe("env");
			expect(auth.source.detail).toBe("GENESIS_API_KEY");
			expect(auth.source.placeholder).toBe(true);
		}
	});

	it("returns bearer auth when a real env-backed api key is configured", async () => {
		process.env.GENESIS_API_KEY = "real-secret-key";
		const registry = await createRegistry();
		const model = registry.find("zai", "glm-5.1");
		expect(model).toBeDefined();

		const auth = registry.getRequestAuth(model!);
		expect(auth.ok).toBe(true);
		if (auth.ok) {
			expect(auth.apiKey).toBe("real-secret-key");
			expect(auth.headers?.authorization).toBe("Bearer real-secret-key");
			expect(auth.source.kind).toBe("env");
			expect(auth.source.detail).toBe("GENESIS_API_KEY");
		}
	});

	it("prefers auth storage over environment variables", async () => {
		process.env.GENESIS_API_KEY = "env-secret-key";
		const dir = await mkdtemp(join(tmpdir(), "genesis-model-registry-auth-"));
		const modelsPath = join(dir, "models.json");
		const authPath = join(dir, "auth.json");
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					zai: {
						apiKey: "GENESIS_API_KEY",
						models: [{ id: "glm-5.1" }],
					},
				},
			}),
			"utf8",
		);
		await writeFile(
			authPath,
			JSON.stringify({
				zai: {
					type: "api_key",
					key: "stored-secret-key",
				},
			}),
			"utf8",
		);
		const registry = ModelRegistry.create(AuthStorage.create(authPath), modelsPath);
		const model = registry.find("zai", "glm-5.1");
		expect(model).toBeDefined();

		const auth = registry.getRequestAuth(model!);
		expect(auth.ok).toBe(true);
		if (auth.ok) {
			expect(auth.apiKey).toBe("stored-secret-key");
			expect(auth.source.kind).toBe("auth_storage");
		}
	});
});
