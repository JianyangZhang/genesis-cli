import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs, readCliPackageVersion, resolveCliOptions } from "../main.js";

const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
const originalHome = process.env.HOME;
const originalGenesisEnv = {
	GENESIS_API_KEY: process.env.GENESIS_API_KEY,
	GENESIS_MODEL_PROVIDER: process.env.GENESIS_MODEL_PROVIDER,
	GENESIS_MODEL_ID: process.env.GENESIS_MODEL_ID,
	GENESIS_BOOTSTRAP_BASE_URL: process.env.GENESIS_BOOTSTRAP_BASE_URL,
};

afterEach(() => {
	stdoutWrite.mockClear();
	process.env.HOME = originalHome;
	for (const [key, value] of Object.entries(originalGenesisEnv)) {
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
});

describe("parseArgs", () => {
	it("parses -v as version", () => {
		expect(parseArgs(["-v"]).flags.version).toBe(true);
	});

	it("parses -h as help", () => {
		expect(parseArgs(["-h"]).flags.help).toBe(true);
	});
});

describe("readCliPackageVersion", () => {
	it("reads the version from a package.json file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "genesis-cli-version-"));
		const packageJsonPath = join(dir, "package.json");
		await writeFile(packageJsonPath, JSON.stringify({ version: "1.2.3" }), "utf8");

		expect(readCliPackageVersion(packageJsonPath)).toBe("1.2.3");
	});
});

describe("main", () => {
	it("prints the version for --version", async () => {
		await main(["--version"]);

		expect(stdoutWrite).toHaveBeenCalledWith("0.0.0\n");
	});

	it("prints the version for -v", async () => {
		await main(["-v"]);

		expect(stdoutWrite).toHaveBeenCalledWith("0.0.0\n");
	});

	it("prints help for -h", async () => {
		await main(["-h"]);

		expect(stdoutWrite).toHaveBeenCalledWith("Genesis CLI\n");
	});
});

describe("resolveCliOptions", () => {
	it("loads Genesis env defaults from ~/.genesis-cli/settings.json", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsDir = join(homeDir, ".genesis-cli");
		await mkdir(settingsDir, { recursive: true });
		await writeFile(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				env: {
					GENESIS_API_KEY: "settings-api-key",
					GENESIS_MODEL_PROVIDER: "settings-provider",
					GENESIS_MODEL_ID: "settings-model",
					GENESIS_BOOTSTRAP_BASE_URL: "https://settings.example/api/",
				},
			}),
			"utf8",
		);

		delete process.env.GENESIS_API_KEY;
		delete process.env.GENESIS_MODEL_PROVIDER;
		delete process.env.GENESIS_MODEL_ID;
		delete process.env.GENESIS_BOOTSTRAP_BASE_URL;
		process.env.HOME = homeDir;

		const options = await resolveCliOptions({});
		expect(options.model.provider).toBe("settings-provider");
		expect(options.model.id).toBe("settings-model");
		expect(options.bootstrapOverrides?.baseUrl).toBe("https://settings.example/api/");
		expect(process.env.GENESIS_API_KEY).toBe("settings-api-key");
	});

	it("prefers explicit shell env over ~/.genesis-cli/settings.json", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsDir = join(homeDir, ".genesis-cli");
		await mkdir(settingsDir, { recursive: true });
		await writeFile(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				env: {
					GENESIS_MODEL_PROVIDER: "settings-provider",
					GENESIS_MODEL_ID: "settings-model",
				},
			}),
			"utf8",
		);

		process.env.HOME = homeDir;
		process.env.GENESIS_MODEL_PROVIDER = "shell-provider";
		process.env.GENESIS_MODEL_ID = "shell-model";

		const options = await resolveCliOptions({});
		expect(options.model.provider).toBe("shell-provider");
		expect(options.model.id).toBe("shell-model");
	});
});
