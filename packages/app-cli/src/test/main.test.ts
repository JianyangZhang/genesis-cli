import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureUserSettingsFile,
	formatDebugSessionBanner,
	main,
	parseArgs,
	readCliPackageVersion,
	resolveCliOptions,
	validateInteractiveModelConfiguration,
} from "../main.js";

const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const currentCliVersion = readCliPackageVersion();
const originalHome = process.env.HOME;
const originalGenesisEnv = {
	GENESIS_API_KEY: process.env.GENESIS_API_KEY,
	GENESIS_DEBUG: process.env.GENESIS_DEBUG,
	GENESIS_MODEL_PROVIDER: process.env.GENESIS_MODEL_PROVIDER,
	GENESIS_MODEL_ID: process.env.GENESIS_MODEL_ID,
	GENESIS_BOOTSTRAP_BASE_URL: process.env.GENESIS_BOOTSTRAP_BASE_URL,
	GENESIS_BOOTSTRAP_API: process.env.GENESIS_BOOTSTRAP_API,
};

function formatLocalTraceTimestamp(value: Date): string {
	const padTwo = (part: number): string => String(part).padStart(2, "0");
	return (
		`${value.getFullYear()}${padTwo(value.getMonth() + 1)}${padTwo(value.getDate())}` +
		`T${padTwo(value.getHours())}${padTwo(value.getMinutes())}${padTwo(value.getSeconds())}`
	);
}

afterEach(() => {
	stdoutWrite.mockClear();
	stderrWrite.mockClear();
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

	it("parses -d as debug", () => {
		expect(parseArgs(["-d"]).flags.debug).toBe(true);
	});

	it("parses --debug as debug", () => {
		expect(parseArgs(["--debug"]).flags.debug).toBe(true);
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

		expect(stdoutWrite).toHaveBeenCalledWith(`${currentCliVersion}\n`);
	});

	it("prints the version for -v", async () => {
		await main(["-v"]);

		expect(stdoutWrite).toHaveBeenCalledWith(`${currentCliVersion}\n`);
	});

	it("prints help for -h", async () => {
		await main(["-h"]);

		expect(stdoutWrite).toHaveBeenCalledWith("Genesis CLI\n");
	});

	it("prints debug flag in help output", async () => {
		await main(["-h"]);
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("--debug, -d"));
	});
});

describe("formatDebugSessionBanner", () => {
	it("renders trace-id and log directory for user feedback", () => {
		const traceId = `${formatLocalTraceTimestamp(new Date("2026-04-06T12:00:00.000Z"))}-p123-deadbeef`;
		expect(
			formatDebugSessionBanner({
				traceId,
				startedAt: "2026-04-06T12:00:00.000Z",
				pid: 123,
				debugEnabled: true,
				logRootDir: "/tmp/log-root",
				sessionDir: `/tmp/log-root/${traceId}`,
			}),
		).toBe(`[genesis-debug] trace-id: ${traceId}\n` + `[genesis-debug] logs: /tmp/log-root/${traceId}\n`);
	});
});

describe("resolveCliOptions", () => {
	it("creates ~/.genesis-cli/settings.json with defaults when missing", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsPath = join(homeDir, ".genesis-cli", "settings.json");
		process.env.HOME = homeDir;

		await ensureUserSettingsFile(settingsPath);

		const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
			env: Record<string, string>;
		};
		expect(settings.env.GENESIS_API_KEY).toBe("your_zhipu_api_key");
		expect(settings.env.GENESIS_BOOTSTRAP_API).toBe("openai-completions");
		expect(settings.env.GENESIS_MODEL_PROVIDER).toBe("zai");
		expect(settings.env.GENESIS_MODEL_ID).toBe("glm-5.1");
	});

	it("does not overwrite an existing ~/.genesis-cli/settings.json", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsDir = join(homeDir, ".genesis-cli");
		const settingsPath = join(settingsDir, "settings.json");
		process.env.HOME = homeDir;
		await mkdir(settingsDir, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ env: { GENESIS_MODEL_ID: "custom-model" } }), "utf8");

		await ensureUserSettingsFile(settingsPath);

		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			env: { GENESIS_MODEL_ID: "custom-model" },
		});
	});

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

	it("requires core config for interactive startup validation", async () => {
		const baseOptions = {
			mode: "interactive",
			debug: false,
			workingDirectory: "/tmp/workspace",
			agentDir: "/tmp/workspace/.genesis-local/agent",
			historyDir: "/tmp/history",
			settingsPath: "/tmp/settings.json",
			model: {
				provider: "zai",
				id: "glm-5.1",
				displayName: undefined,
			},
			toolSet: ["read", "bash"],
			thinkingLevel: undefined,
			bootstrapOverrides: {
				baseUrl: "https://example.com/api/",
				api: "openai-completions",
			},
			configSources: {},
		} as const;

		expect(() =>
			validateInteractiveModelConfiguration(baseOptions as never, {
				...process.env,
				GENESIS_API_KEY: "",
			}),
		).toThrow("GENESIS_API_KEY is required for interactive mode.");
		expect(() =>
			validateInteractiveModelConfiguration({
				...baseOptions,
				bootstrapOverrides: { ...baseOptions.bootstrapOverrides, baseUrl: undefined },
			} as never, {
				...process.env,
				GENESIS_API_KEY: "test-key",
			}),
		).toThrow("GENESIS_BOOTSTRAP_BASE_URL is required for interactive mode.");
		expect(() =>
			validateInteractiveModelConfiguration({
				...baseOptions,
				model: { ...baseOptions.model, provider: "" },
			} as never, {
				...process.env,
				GENESIS_API_KEY: "test-key",
			}),
		).toThrow("GENESIS_MODEL_PROVIDER is required for interactive mode.");
		expect(() =>
			validateInteractiveModelConfiguration({
				...baseOptions,
				model: { ...baseOptions.model, id: "" },
			} as never, {
				...process.env,
				GENESIS_API_KEY: "test-key",
			}),
		).toThrow("GENESIS_MODEL_ID is required for interactive mode.");
	});

	it("fails fast when ~/.genesis-cli/settings.json contains invalid JSON", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsDir = join(homeDir, ".genesis-cli");
		const settingsPath = join(settingsDir, "settings.json");
		process.env.HOME = homeDir;
		await mkdir(settingsDir, { recursive: true });
		await writeFile(settingsPath, '{"env":{"GENESIS_MODEL_ID":"glm-5.1",}', "utf8");

		await expect(resolveCliOptions({})).rejects.toThrow(`Invalid user file at ${settingsPath}:`);
	});

	it("does not inject placeholder api keys from settings into process.env", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const settingsDir = join(homeDir, ".genesis-cli");
		await mkdir(settingsDir, { recursive: true });
		await writeFile(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				env: {
					GENESIS_API_KEY: "your_zhipu_api_key",
					GENESIS_MODEL_PROVIDER: "settings-provider",
				},
			}),
			"utf8",
		);

		delete process.env.GENESIS_API_KEY;
		process.env.HOME = homeDir;

		const options = await resolveCliOptions({});
		expect(options.model.provider).toBe("settings-provider");
		expect(process.env.GENESIS_API_KEY).toBeUndefined();
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

	it("enables debug mode from GENESIS_DEBUG", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		process.env.HOME = homeDir;
		process.env.GENESIS_DEBUG = "true";

		const options = await resolveCliOptions({});
		expect(options.debug).toBe(true);
	});

	it("accepts 1 for GENESIS_DEBUG", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		process.env.HOME = homeDir;
		process.env.GENESIS_DEBUG = "1";

		const options = await resolveCliOptions({});
		expect(options.debug).toBe(true);
	});

	it("enables debug mode from --debug", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		process.env.HOME = homeDir;

		const options = await resolveCliOptions({ debug: true });
		expect(options.debug).toBe(true);
	});

	it("prefers project settings over user settings", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const workingDirectory = await mkdtemp(join(tmpdir(), "genesis-cli-project-"));
		const userSettingsDir = join(homeDir, ".genesis-cli");
		const projectSettingsDir = join(workingDirectory, ".genesis");
		process.env.HOME = homeDir;
		delete process.env.GENESIS_MODEL_PROVIDER;
		delete process.env.GENESIS_MODEL_ID;
		await mkdir(userSettingsDir, { recursive: true });
		await mkdir(projectSettingsDir, { recursive: true });
		await writeFile(
			join(userSettingsDir, "settings.json"),
			JSON.stringify({ model: "user-model", provider: "user-provider" }),
			"utf8",
		);
		await writeFile(
			join(projectSettingsDir, "settings.json"),
			JSON.stringify({ model: "project-model", provider: "project-provider" }),
			"utf8",
		);

		const options = await resolveCliOptions({ cwd: workingDirectory });
		expect(options.model.provider).toBe("project-provider");
		expect(options.model.id).toBe("project-model");
		expect(options.configSources.provider).toEqual({
			layer: "project",
			detail: join(projectSettingsDir, "settings.json"),
		});
		expect(options.configSources.model).toEqual({
			layer: "project",
			detail: join(projectSettingsDir, "settings.json"),
		});
	});

	it("prefers local settings over project settings", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const workingDirectory = await mkdtemp(join(tmpdir(), "genesis-cli-project-"));
		const settingsDir = join(workingDirectory, ".genesis");
		process.env.HOME = homeDir;
		delete process.env.GENESIS_MODEL_PROVIDER;
		delete process.env.GENESIS_MODEL_ID;
		await mkdir(join(homeDir, ".genesis-cli"), { recursive: true });
		await mkdir(settingsDir, { recursive: true });
		await writeFile(
			join(settingsDir, "settings.json"),
			JSON.stringify({ model: "project-model", provider: "project-provider" }),
			"utf8",
		);
		await writeFile(
			join(settingsDir, "settings.local.json"),
			JSON.stringify({ model: "local-model", provider: "local-provider" }),
			"utf8",
		);

		const options = await resolveCliOptions({ cwd: workingDirectory });
		expect(options.model.provider).toBe("local-provider");
		expect(options.model.id).toBe("local-model");
		expect(options.configSources.provider).toEqual({
			layer: "local",
			detail: join(settingsDir, "settings.local.json"),
		});
		expect(options.configSources.model).toEqual({
			layer: "local",
			detail: join(settingsDir, "settings.local.json"),
		});
	});

	it("prefers cli flags over shell env and local settings", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "genesis-cli-home-"));
		const workingDirectory = await mkdtemp(join(tmpdir(), "genesis-cli-project-"));
		const settingsDir = join(workingDirectory, ".genesis");
		process.env.HOME = homeDir;
		process.env.GENESIS_MODEL_PROVIDER = "shell-provider";
		process.env.GENESIS_MODEL_ID = "shell-model";
		await mkdir(settingsDir, { recursive: true });
		await writeFile(
			join(settingsDir, "settings.local.json"),
			JSON.stringify({ model: "local-model", provider: "local-provider" }),
			"utf8",
		);

		const options = await resolveCliOptions({
			cwd: workingDirectory,
			provider: "cli-provider",
			model: "cli-model",
		});
		expect(options.model.provider).toBe("cli-provider");
		expect(options.model.id).toBe("cli-model");
		expect(options.configSources.provider).toEqual({ layer: "cli", detail: "--provider" });
		expect(options.configSources.model).toEqual({ layer: "cli", detail: "--model" });
	});
});
