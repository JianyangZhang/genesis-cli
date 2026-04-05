#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type CliMode, createAppRuntime, type ModelDescriptor, PiMonoSessionAdapter } from "@pickle-pee/runtime";
import { ensureAgentDirBootstrapped } from "./bootstrap.js";
import { createModeHandler } from "./mode-dispatch.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CliOptions {
	readonly mode: CliMode;
	readonly workingDirectory: string;
	readonly agentDir: string;
	readonly model: ModelDescriptor;
	readonly toolSet: readonly string[];
	readonly thinkingLevel?: ThinkingLevel;
	readonly bootstrapOverrides?: BootstrapOverrides;
	readonly configSources: Readonly<Record<string, { layer: string; detail: string }>>;
}

interface BootstrapOverrides {
	readonly baseUrl?: string;
	readonly api?: string;
	readonly apiKeyEnv?: string;
	readonly authHeader?: boolean;
	readonly reasoning?: boolean;
	readonly compat?: {
		readonly supportsDeveloperRole?: boolean;
		readonly supportsReasoningEffort?: boolean;
	};
}

export interface ParsedArgs {
	readonly flags: Readonly<Record<string, string | boolean>>;
	readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i += 1) {
		const value = argv[i];
		if (value === "-h") {
			flags.help = true;
			continue;
		}
		if (value === "-v") {
			flags.version = true;
			continue;
		}
		if (!value.startsWith("--")) {
			positional.push(value);
			continue;
		}

		const key = value.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}

		flags[key] = next;
		i += 1;
	}

	return { flags, positional };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const parsed = parseArgs(argv);
	if (parsed.flags.version) {
		process.stdout.write(`${readCliPackageVersion()}\n`);
		return;
	}
	if (parsed.flags.help) {
		printHelp();
		return;
	}

	const options = await resolveCliOptions(parsed.flags);
	await ensureAgentDirBootstrapped({
		agentDir: options.agentDir,
		provider: options.model.provider,
		modelId: options.model.id,
		displayName: options.model.displayName,
		thinkingLevel: options.thinkingLevel,
		bootstrapBaseUrl: options.bootstrapOverrides?.baseUrl,
		bootstrapApi: options.bootstrapOverrides?.api,
		bootstrapApiKeyEnv: options.bootstrapOverrides?.apiKeyEnv,
		bootstrapAuthHeader: options.bootstrapOverrides?.authHeader,
		bootstrapReasoning: options.bootstrapOverrides?.reasoning,
		supportsDeveloperRole: options.bootstrapOverrides?.compat?.supportsDeveloperRole,
		supportsReasoningEffort: options.bootstrapOverrides?.compat?.supportsReasoningEffort,
	});

	const runtime = createAppRuntime({
		workingDirectory: options.workingDirectory,
		agentDir: options.agentDir,
		configSources: options.configSources,
		mode: options.mode,
		model: options.model,
		toolSet: options.toolSet,
		createAdapter: () =>
			new PiMonoSessionAdapter({
				workingDirectory: options.workingDirectory,
				agentDir: options.agentDir,
				model: options.model,
				toolSet: options.toolSet,
				thinkingLevel: options.thinkingLevel,
			}),
	});

	try {
		const handler = createModeHandler(options.mode);
		await handler.start(runtime);
	} finally {
		await runtime.shutdown();
	}
}

interface FileConfig {
	readonly provider?: string;
	readonly model?: string;
	readonly displayName?: string;
	readonly tools?: string | readonly string[];
	readonly thinking?: ThinkingLevel;
	readonly bootstrap?: {
		readonly baseUrl?: string;
		readonly api?: string;
	};
}

interface SettingsFile {
	readonly env?: Readonly<Record<string, unknown>>;
}

type SourceLayer = "default" | "agent" | "project" | "settings" | "env" | "cli";

export async function resolveCliOptions(flags: Readonly<Record<string, string | boolean>>): Promise<CliOptions> {
	const workingDirectory = resolve(readStringFlag(flags, "cwd", process.cwd()));
	const agentDir = resolve(readStringFlag(flags, "agent-dir", resolve(".genesis-local/pi-agent")));
	const settingsPath = resolve(homedir(), ".genesis-cli", "settings.json");
	const settingsEnv = await readSettingsEnv(settingsPath);
	applySettingsEnv(settingsEnv);

	const agentConfigPath = resolve(agentDir, "config.json");
	const projectConfigPath = resolve(workingDirectory, ".genesis/config.json");
	const agentConfig = await readOptionalJson(agentConfigPath);
	const projectConfig = await readOptionalJson(projectConfigPath);

	const mode = readModeFlag(flags, "mode", "interactive");

	const sources: Record<string, { layer: SourceLayer; detail: string }> = {};
	sources.cwd =
		typeof flags.cwd === "string" ? { layer: "cli", detail: "--cwd" } : { layer: "default", detail: "process.cwd()" };
	sources.agentDir =
		typeof flags["agent-dir"] === "string"
			? { layer: "cli", detail: "--agent-dir" }
			: { layer: "default", detail: ".genesis-local/pi-agent" };

	const provider = pickString(
		[
			{ value: asOptionalString(flags.provider), layer: "cli", detail: "--provider" },
			{ value: process.env.GENESIS_MODEL_PROVIDER, layer: "env", detail: "GENESIS_MODEL_PROVIDER" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_MODEL_PROVIDER"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_MODEL_PROVIDER`,
			},
			{ value: projectConfig?.provider, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.provider, layer: "agent", detail: agentConfigPath },
		],
		"zai",
		{ layer: "default", detail: "default" },
		(value, source) => {
			sources.provider = source;
			return value;
		},
	);

	const modelId = pickString(
		[
			{ value: asOptionalString(flags.model), layer: "cli", detail: "--model" },
			{ value: process.env.GENESIS_MODEL_ID, layer: "env", detail: "GENESIS_MODEL_ID" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_MODEL_ID"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_MODEL_ID`,
			},
			{ value: projectConfig?.model, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.model, layer: "agent", detail: agentConfigPath },
		],
		"glm-5.1",
		{ layer: "default", detail: "default" },
		(value, source) => {
			sources.model = source;
			return value;
		},
	);

	const displayName = pickOptionalString(
		[
			{ value: asOptionalString(flags["display-name"]), layer: "cli", detail: "--display-name" },
			{ value: process.env.GENESIS_MODEL_DISPLAY_NAME, layer: "env", detail: "GENESIS_MODEL_DISPLAY_NAME" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_MODEL_DISPLAY_NAME"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_MODEL_DISPLAY_NAME`,
			},
			{ value: projectConfig?.displayName, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.displayName, layer: "agent", detail: agentConfigPath },
		],
		(value, source) => {
			sources.displayName = source;
			return value;
		},
	);

	const toolSetRaw = pickTools(
		[
			{ value: asOptionalString(flags.tools), layer: "cli", detail: "--tools" },
			{ value: process.env.GENESIS_TOOL_SET, layer: "env", detail: "GENESIS_TOOL_SET" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_TOOL_SET"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_TOOL_SET`,
			},
			{ value: projectConfig?.tools, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.tools, layer: "agent", detail: agentConfigPath },
		],
		"read,bash,edit,write",
		{ layer: "default", detail: "default" },
		(value, source) => {
			sources.tools = source;
			return value;
		},
	);
	const toolSet = splitCsv(toolSetRaw);

	const thinkingLevel = pickOptionalString(
		[
			{ value: asOptionalString(flags.thinking), layer: "cli", detail: "--thinking" },
			{ value: process.env.GENESIS_THINKING_LEVEL, layer: "env", detail: "GENESIS_THINKING_LEVEL" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_THINKING_LEVEL"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_THINKING_LEVEL`,
			},
			{ value: projectConfig?.thinking, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.thinking, layer: "agent", detail: agentConfigPath },
		],
		(value, source) => {
			sources.thinking = source;
			return value;
		},
	) as ThinkingLevel | undefined;

	const bootstrapBaseUrl = pickOptionalString(
		[
			{ value: asOptionalString(flags["bootstrap-base-url"]), layer: "cli", detail: "--bootstrap-base-url" },
			{ value: process.env.GENESIS_BOOTSTRAP_BASE_URL, layer: "env", detail: "GENESIS_BOOTSTRAP_BASE_URL" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_BASE_URL"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_BOOTSTRAP_BASE_URL`,
			},
			{ value: projectConfig?.bootstrap?.baseUrl, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.bootstrap?.baseUrl, layer: "agent", detail: agentConfigPath },
		],
		(value, source) => {
			sources["bootstrap.baseUrl"] = source;
			return value;
		},
	);
	const bootstrapApi = pickOptionalString(
		[
			{ value: asOptionalString(flags["bootstrap-api"]), layer: "cli", detail: "--bootstrap-api" },
			{ value: process.env.GENESIS_BOOTSTRAP_API, layer: "env", detail: "GENESIS_BOOTSTRAP_API" },
			{
				value: readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_API"),
				layer: "settings",
				detail: `${settingsPath} env.GENESIS_BOOTSTRAP_API`,
			},
			{ value: projectConfig?.bootstrap?.api, layer: "project", detail: projectConfigPath },
			{ value: agentConfig?.bootstrap?.api, layer: "agent", detail: agentConfigPath },
		],
		(value, source) => {
			sources["bootstrap.api"] = source;
			return value;
		},
	);

	return {
		mode,
		workingDirectory,
		agentDir,
		model: {
			id: modelId,
			provider,
			displayName,
		},
		toolSet,
		thinkingLevel,
		bootstrapOverrides: {
			...(bootstrapBaseUrl !== undefined ? { baseUrl: bootstrapBaseUrl } : {}),
			...(bootstrapApi !== undefined ? { api: bootstrapApi } : {}),
			apiKeyEnv: readOptionalStringFlag(
				flags,
				"bootstrap-api-key-env",
				process.env.GENESIS_BOOTSTRAP_API_KEY_ENV ??
					readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_API_KEY_ENV"),
			),
			authHeader: readOptionalBooleanFlag(
				flags,
				"bootstrap-auth-header",
				process.env.GENESIS_BOOTSTRAP_AUTH_HEADER ??
					readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_AUTH_HEADER"),
			),
			reasoning: readOptionalBooleanFlag(
				flags,
				"bootstrap-reasoning",
				process.env.GENESIS_BOOTSTRAP_REASONING ?? readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_REASONING"),
			),
			compat: {
				supportsDeveloperRole: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-developer-role",
					process.env.GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE ??
						readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE"),
				),
				supportsReasoningEffort: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-reasoning-effort",
					process.env.GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT ??
						readSettingsEnvValue(settingsEnv, "GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT"),
				),
			},
		},
		configSources: sources,
	};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalString(value: string | boolean | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	return value;
}

function pickString(
	candidates: readonly { value: string | undefined; layer: SourceLayer; detail: string }[],
	fallback: string,
	fallbackSource: { layer: SourceLayer; detail: string },
	onPicked: (value: string, source: { layer: SourceLayer; detail: string }) => string,
): string {
	for (const candidate of candidates) {
		const value = normalizeOptionalString(candidate.value);
		if (value !== undefined) {
			return onPicked(value, { layer: candidate.layer, detail: candidate.detail });
		}
	}
	return onPicked(fallback, fallbackSource);
}

function pickOptionalString(
	candidates: readonly { value: string | undefined; layer: SourceLayer; detail: string }[],
	onPicked: (value: string | undefined, source: { layer: SourceLayer; detail: string }) => string | undefined,
): string | undefined {
	for (const candidate of candidates) {
		const value = normalizeOptionalString(candidate.value);
		if (value !== undefined) {
			return onPicked(value, { layer: candidate.layer, detail: candidate.detail });
		}
	}
	return onPicked(undefined, { layer: "default", detail: "default" });
}

function pickTools(
	candidates: readonly { value: string | readonly string[] | undefined; layer: SourceLayer; detail: string }[],
	fallback: string,
	fallbackSource: { layer: SourceLayer; detail: string },
	onPicked: (value: string, source: { layer: SourceLayer; detail: string }) => string,
): string {
	for (const candidate of candidates) {
		const raw = candidate.value;
		if (Array.isArray(raw)) {
			const joined = raw.filter((v) => typeof v === "string" && v.trim().length > 0).join(",");
			if (joined.length > 0) {
				return onPicked(joined, { layer: candidate.layer, detail: candidate.detail });
			}
			continue;
		}
		if (typeof raw === "string") {
			const value = normalizeOptionalString(raw);
			if (value !== undefined) {
				return onPicked(value, { layer: candidate.layer, detail: candidate.detail });
			}
		}
	}
	return onPicked(fallback, fallbackSource);
}

async function readOptionalJson(filePath: string): Promise<FileConfig | null> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as FileConfig;
	} catch {
		return null;
	}
}

async function readSettingsEnv(settingsPath: string): Promise<Readonly<Record<string, string>>> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as SettingsFile;
		if (!parsed || typeof parsed !== "object" || !parsed.env || typeof parsed.env !== "object") {
			return {};
		}

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed.env)) {
			if (typeof value === "string") {
				const trimmed = value.trim();
				if (trimmed.length > 0) {
					env[key] = trimmed;
				}
				continue;
			}
			if (typeof value === "number" || typeof value === "boolean") {
				env[key] = String(value);
			}
		}
		return env;
	} catch {
		return {};
	}
}

function applySettingsEnv(
	settingsEnv: Readonly<Record<string, string>>,
	targetEnv: NodeJS.ProcessEnv = process.env,
): void {
	for (const [key, value] of Object.entries(settingsEnv)) {
		if (targetEnv[key] === undefined) {
			targetEnv[key] = value;
		}
	}
}

function readSettingsEnvValue(settingsEnv: Readonly<Record<string, string>>, key: string): string | undefined {
	return settingsEnv[key];
}

function readModeFlag(flags: Readonly<Record<string, string | boolean>>, key: string, fallback: CliMode): CliMode {
	const value = readStringFlag(flags, key, fallback);
	if (value === "interactive" || value === "print" || value === "json" || value === "rpc") {
		return value;
	}
	throw new Error(`Unsupported mode: ${value}`);
}

function readStringFlag(flags: Readonly<Record<string, string | boolean>>, key: string, fallback: string): string {
	const value = flags[key];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readOptionalStringFlag(
	flags: Readonly<Record<string, string | boolean>>,
	key: string,
	fallback?: string,
): string | undefined {
	const value = flags[key];
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	return fallback;
}

function _readBooleanFlag(
	flags: Readonly<Record<string, string | boolean>>,
	key: string,
	envValue: string | undefined,
	fallback: boolean,
): boolean {
	const explicit = readOptionalBooleanFlag(flags, key, envValue);
	return explicit ?? fallback;
}

function readOptionalBooleanFlag(
	flags: Readonly<Record<string, string | boolean>>,
	key: string,
	envValue?: string,
): boolean | undefined {
	const value = flags[key];
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value === "true";
	}
	if (envValue === undefined) {
		return undefined;
	}
	return envValue === "true";
}

function splitCsv(value: string): readonly string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function printHelp(): void {
	process.stdout.write(`Genesis CLI\n`);
	process.stdout.write(`\n`);
	process.stdout.write(`Flags:\n`);
	process.stdout.write(`  --mode interactive|print|json|rpc\n`);
	process.stdout.write(`  --cwd <path>\n`);
	process.stdout.write(`  --agent-dir <path>\n`);
	process.stdout.write(`  --provider <provider>\n`);
	process.stdout.write(`  --model <id>\n`);
	process.stdout.write(`  --display-name <name>\n`);
	process.stdout.write(`  --tools read,bash,edit,write\n`);
	process.stdout.write(`  --thinking off|minimal|low|medium|high|xhigh\n`);
	process.stdout.write(`  --bootstrap-base-url <url>\n`);
	process.stdout.write(`  --bootstrap-api openai-completions|anthropic-messages\n`);
	process.stdout.write(`  --bootstrap-api-key-env <env-var>\n`);
	process.stdout.write(`\n`);
}

if (typeof require !== "undefined" && require.main === module) {
	void main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}

export function readCliPackageVersion(packageJsonPath = resolve(__dirname, "../package.json")): string {
	const raw = readFileSync(packageJsonPath, "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
}
