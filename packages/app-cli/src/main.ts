#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type AppRuntime,
	type CliMode,
	createAppRuntime,
	type ModelDescriptor,
	PiMonoSessionAdapter,
} from "@pickle-pee/runtime";
import { ensureAgentDirBootstrapped, resolveDefaultBootstrapBaseUrl } from "./bootstrap.js";
import { type DebugLoggerSession, getLastDebugSession, initializeDebugLogger } from "./debug-logger.js";
import { createModeHandler, runInteractiveStartupChecks } from "./mode-dispatch.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CliOptions {
	readonly mode: CliMode;
	readonly debug: boolean;
	readonly workingDirectory: string;
	readonly agentDir: string;
	readonly historyDir: string;
	readonly settingsPath: string;
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
		if (value === "-d") {
			flags.debug = true;
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
	const requestedMode = readModeFlag(parsed.flags, "mode", "interactive");
	await preloadSettingsEnv(parsed.flags);

	const logger = await initializeDebugLogger({
		debugEnabled: readDebugFlag(parsed.flags),
		argv,
	});
	try {
		if (requestedMode === "interactive") {
			await startInteractiveWithStartupChecks(parsed.flags, logger);
			return;
		}
		const options = await resolveCliOptions(parsed.flags);
		logger.updateContext({
			workingDirectory: options.workingDirectory,
			agentDir: options.agentDir,
			mode: options.mode,
			model: options.model,
		});
		if (options.debug) {
			process.stderr.write(formatDebugSessionBanner(logger.session));
		}
		logger.info("cli.options", "CLI options resolved", {
			mode: options.mode,
			toolSet: options.toolSet,
			debug: options.debug,
		});

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
		logger.debug("cli.bootstrap", "Agent directory bootstrapped");

		const runtime = createAppRuntime({
			workingDirectory: options.workingDirectory,
			agentDir: options.agentDir,
			historyDir: options.historyDir,
			configSources: options.configSources,
			mode: options.mode,
			model: options.model,
			toolSet: options.toolSet,
			createAdapter: (model) =>
				new PiMonoSessionAdapter({
					workingDirectory: options.workingDirectory,
					agentDir: options.agentDir,
					historyDir: options.historyDir,
					model,
					toolSet: options.toolSet,
					thinkingLevel: options.thinkingLevel,
					onAuthResolved: (report) => logAuthResolution(logger, { ...report, phase: "session_init" }),
					onUpstreamEvent: (event) => logRawUpstreamEvent(logger, { phase: "session_init", event }),
					onSessionRecovered: (report) => logSessionRecovery(logger, { ...report, phase: "session_init" }),
				}),
		});
		const recentSessionPrune = await runtime.pruneRecentSessions();
		logger.debug("resume.catalog.prune", "Pruned recent-session catalog on startup", recentSessionPrune);

		const handler = createModeHandler(options.mode, {
			modelHost: {
				agentDir: options.agentDir,
				settingsPath: options.settingsPath,
				bootstrapDefaults: {
					baseUrl: options.bootstrapOverrides?.baseUrl,
					api: options.bootstrapOverrides?.api,
				},
			},
		});
		logger.info("cli.mode", "Starting mode handler", { mode: options.mode });
		try {
			await handler.start(runtime);
		} finally {
			await runtime.shutdown();
			logger.info("cli.runtime", "Runtime shut down");
		}
	} catch (error) {
		logger.crash("cli.main", "CLI main failed", { error });
		await logger.flush();
		throw error;
	} finally {
		await logger.shutdown();
	}
}

function logAuthResolution(
	logger: Awaited<ReturnType<typeof initializeDebugLogger>>,
	data: {
		provider: string;
		modelId: string;
		sourceKind: "auth_storage" | "env" | "literal" | "missing";
		sourceDetail?: string;
		placeholder: boolean;
		authorized: boolean;
		phase: "startup_check" | "session_init";
	},
): void {
	logger.debug("auth.resolve", "Resolved model auth source", data);
}

function logRawUpstreamEvent(
	logger: Awaited<ReturnType<typeof initializeDebugLogger>>,
	data: {
		phase: "session_init";
		event: unknown;
	},
): void {
	logger.debug("model.raw_event", "Received raw upstream event", data);
}

function logSessionRecovery(
	logger: Awaited<ReturnType<typeof initializeDebugLogger>>,
	data: {
		mode: "resume" | "new";
		sessionFile?: string;
		phase: "session_init";
	},
): void {
	logger.debug("session.recovery", "Resolved session recovery source", data);
}

async function startInteractiveWithStartupChecks(
	flags: Readonly<Record<string, string | boolean>>,
	logger: Awaited<ReturnType<typeof initializeDebugLogger>>,
): Promise<void> {
	let prepared: { options: CliOptions; runtime: AppRuntime } | null = null;
	await runInteractiveStartupChecks(async () => {
		prepared = await prepareInteractiveLaunch(flags, logger);
	});
	if (!prepared) {
		throw new Error("Interactive startup checks did not produce a runtime");
	}
	const launch = prepared as { options: CliOptions; runtime: AppRuntime };
	const { options, runtime } = launch;
	const handler = createModeHandler("interactive", {
		modelHost: {
			agentDir: options.agentDir,
			settingsPath: options.settingsPath,
			bootstrapDefaults: {
				baseUrl: options.bootstrapOverrides?.baseUrl,
				api: options.bootstrapOverrides?.api,
			},
		},
	});
	logger.info("cli.mode", "Starting mode handler", { mode: options.mode });
	try {
		await handler.start(runtime);
	} finally {
		await runtime.shutdown();
		logger.info("cli.runtime", "Runtime shut down");
	}
}

async function prepareInteractiveLaunch(
	flags: Readonly<Record<string, string | boolean>>,
	logger: Awaited<ReturnType<typeof initializeDebugLogger>>,
): Promise<{ options: CliOptions; runtime: AppRuntime }> {
	const options = await resolveCliOptions(flags);
	logger.updateContext({
		workingDirectory: options.workingDirectory,
		agentDir: options.agentDir,
		mode: options.mode,
		model: options.model,
	});
	logger.info("cli.options", "CLI options resolved", {
		mode: options.mode,
		toolSet: options.toolSet,
		debug: options.debug,
	});
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
	logger.debug("cli.bootstrap", "Agent directory bootstrapped");

	const startupAdapter = new PiMonoSessionAdapter({
		workingDirectory: options.workingDirectory,
		agentDir: options.agentDir,
		historyDir: options.historyDir,
		model: options.model,
		toolSet: options.toolSet,
		thinkingLevel: options.thinkingLevel,
		onAuthResolved: (report) => logAuthResolution(logger, { ...report, phase: "startup_check" }),
	});
	const startupAuth = await startupAdapter.validateStartupConfiguration();
	await startupAdapter.close();
	logger.debug("cli.startup_check", "Interactive startup checks passed", {
		model: options.model,
		agentDir: options.agentDir,
		auth: startupAuth,
	});

	const runtime = createAppRuntime({
		workingDirectory: options.workingDirectory,
		agentDir: options.agentDir,
		historyDir: options.historyDir,
		configSources: options.configSources,
		mode: options.mode,
		model: options.model,
		toolSet: options.toolSet,
		createAdapter: (model) =>
			new PiMonoSessionAdapter({
				workingDirectory: options.workingDirectory,
				agentDir: options.agentDir,
				historyDir: options.historyDir,
				model,
				toolSet: options.toolSet,
				thinkingLevel: options.thinkingLevel,
				onAuthResolved: (report) => logAuthResolution(logger, { ...report, phase: "session_init" }),
				onUpstreamEvent: (event) => logRawUpstreamEvent(logger, { phase: "session_init", event }),
				onSessionRecovered: (report) => logSessionRecovery(logger, { ...report, phase: "session_init" }),
			}),
	});
	const recentSessionPrune = await runtime.pruneRecentSessions();
	logger.debug("resume.catalog.prune", "Pruned recent-session catalog on startup", recentSessionPrune);
	return { options, runtime };
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

interface SettingsFile extends FileConfig {
	readonly env?: Readonly<Record<string, unknown>>;
}

type SourceLayer = "default" | "agent" | "user" | "project" | "local" | "env" | "cli";

class SettingsFileFormatError extends Error {
	constructor(
		readonly filePath: string,
		readonly layerLabel: string,
		message: string,
	) {
		super(`Invalid ${layerLabel} file at ${filePath}: ${message}`);
		this.name = "SettingsFileFormatError";
	}
}

interface LoadedSettingsLayers {
	readonly user: SettingsFile | null;
	readonly project: SettingsFile | null;
	readonly local: SettingsFile | null;
	readonly mergedEnv: Readonly<Record<string, string>>;
}

export async function resolveCliOptions(flags: Readonly<Record<string, string | boolean>>): Promise<CliOptions> {
	const workingDirectory = resolve(readStringFlag(flags, "cwd", process.cwd()));
	const agentDir = resolve(readStringFlag(flags, "agent-dir", resolve(".genesis-local/agent")));
	const historyDir = resolve(homedir(), ".genesis-cli", "sessions");
	const settingsPath = resolve(homedir(), ".genesis-cli", "settings.json");
	const shellEnv: NodeJS.ProcessEnv = { ...process.env };
	try {
		await ensureUserSettingsFile(settingsPath);
	} catch {}
	const settingsLayers = await loadSettingsLayers(settingsPath, workingDirectory);
	applySettingsEnv(settingsLayers.mergedEnv);

	const agentConfigPath = resolve(agentDir, "config.json");
	const agentConfig = await readOptionalSettingsFile(agentConfigPath, "agent config");
	const projectSettingsPath = resolve(workingDirectory, ".genesis/settings.json");
	const localSettingsPath = resolve(workingDirectory, ".genesis/settings.local.json");

	const mode = readModeFlag(flags, "mode", "interactive");

	const sources: Record<string, { layer: SourceLayer; detail: string }> = {};
	sources.cwd =
		typeof flags.cwd === "string" ? { layer: "cli", detail: "--cwd" } : { layer: "default", detail: "process.cwd()" };
	sources.agentDir =
		typeof flags["agent-dir"] === "string"
			? { layer: "cli", detail: "--agent-dir" }
			: { layer: "default", detail: ".genesis-local/agent" };

	const provider = pickString(
		[
			{ value: asOptionalString(flags.provider), layer: "cli", detail: "--provider" },
			{ value: shellEnv.GENESIS_MODEL_PROVIDER, layer: "env", detail: "GENESIS_MODEL_PROVIDER" },
			{
				value: settingsLayers.local?.provider,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_MODEL_PROVIDER"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_MODEL_PROVIDER`,
			},
			{
				value: settingsLayers.project?.provider,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_MODEL_PROVIDER"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_MODEL_PROVIDER`,
			},
			{
				value: settingsLayers.user?.provider,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_MODEL_PROVIDER"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_MODEL_PROVIDER`,
			},
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
			{ value: shellEnv.GENESIS_MODEL_ID, layer: "env", detail: "GENESIS_MODEL_ID" },
			{
				value: settingsLayers.local?.model,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_MODEL_ID"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_MODEL_ID`,
			},
			{
				value: settingsLayers.project?.model,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_MODEL_ID"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_MODEL_ID`,
			},
			{
				value: settingsLayers.user?.model,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_MODEL_ID"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_MODEL_ID`,
			},
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
			{
				value: settingsLayers.local?.displayName,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: settingsLayers.project?.displayName,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: settingsLayers.user?.displayName,
				layer: "user",
				detail: settingsPath,
			},
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
			{ value: shellEnv.GENESIS_TOOL_SET, layer: "env", detail: "GENESIS_TOOL_SET" },
			{
				value: settingsLayers.local?.tools,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_TOOL_SET"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_TOOL_SET`,
			},
			{
				value: settingsLayers.project?.tools,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_TOOL_SET"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_TOOL_SET`,
			},
			{
				value: settingsLayers.user?.tools,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_TOOL_SET"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_TOOL_SET`,
			},
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
	const debug = readDebugFlag(flags);

	const thinkingLevel = pickOptionalString(
		[
			{ value: asOptionalString(flags.thinking), layer: "cli", detail: "--thinking" },
			{ value: shellEnv.GENESIS_THINKING_LEVEL, layer: "env", detail: "GENESIS_THINKING_LEVEL" },
			{
				value: settingsLayers.local?.thinking,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_THINKING_LEVEL"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_THINKING_LEVEL`,
			},
			{
				value: settingsLayers.project?.thinking,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_THINKING_LEVEL"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_THINKING_LEVEL`,
			},
			{
				value: settingsLayers.user?.thinking,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_THINKING_LEVEL"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_THINKING_LEVEL`,
			},
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
			{ value: shellEnv.GENESIS_BOOTSTRAP_BASE_URL, layer: "env", detail: "GENESIS_BOOTSTRAP_BASE_URL" },
			{
				value: settingsLayers.local?.bootstrap?.baseUrl,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_BASE_URL"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_BOOTSTRAP_BASE_URL`,
			},
			{
				value: settingsLayers.project?.bootstrap?.baseUrl,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_BASE_URL"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_BOOTSTRAP_BASE_URL`,
			},
			{
				value: settingsLayers.user?.bootstrap?.baseUrl,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_BASE_URL"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_BOOTSTRAP_BASE_URL`,
			},
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
			{ value: shellEnv.GENESIS_BOOTSTRAP_API, layer: "env", detail: "GENESIS_BOOTSTRAP_API" },
			{
				value: settingsLayers.local?.bootstrap?.api,
				layer: "local",
				detail: localSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_API"),
				layer: "local",
				detail: `${localSettingsPath} env.GENESIS_BOOTSTRAP_API`,
			},
			{
				value: settingsLayers.project?.bootstrap?.api,
				layer: "project",
				detail: projectSettingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_API"),
				layer: "project",
				detail: `${projectSettingsPath} env.GENESIS_BOOTSTRAP_API`,
			},
			{
				value: settingsLayers.user?.bootstrap?.api,
				layer: "user",
				detail: settingsPath,
			},
			{
				value: readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_API"),
				layer: "user",
				detail: `${settingsPath} env.GENESIS_BOOTSTRAP_API`,
			},
			{ value: agentConfig?.bootstrap?.api, layer: "agent", detail: agentConfigPath },
		],
		(value, source) => {
			sources["bootstrap.api"] = source;
			return value;
		},
	);

	return {
		mode,
		debug,
		workingDirectory,
		agentDir,
		historyDir,
		settingsPath,
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
				shellEnv.GENESIS_BOOTSTRAP_API_KEY_ENV ??
					readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_API_KEY_ENV") ??
					readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_API_KEY_ENV") ??
					readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_API_KEY_ENV"),
			),
			authHeader: readOptionalBooleanFlag(
				flags,
				"bootstrap-auth-header",
				shellEnv.GENESIS_BOOTSTRAP_AUTH_HEADER ??
					readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_AUTH_HEADER") ??
					readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_AUTH_HEADER") ??
					readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_AUTH_HEADER"),
			),
			reasoning: readOptionalBooleanFlag(
				flags,
				"bootstrap-reasoning",
				shellEnv.GENESIS_BOOTSTRAP_REASONING ??
					readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_REASONING") ??
					readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_REASONING") ??
					readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_REASONING"),
			),
			compat: {
				supportsDeveloperRole: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-developer-role",
					shellEnv.GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE ??
						readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE") ??
						readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE") ??
						readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE"),
				),
				supportsReasoningEffort: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-reasoning-effort",
					shellEnv.GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT ??
						readSettingsEnvValue(settingsLayers.local, "GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT") ??
						readSettingsEnvValue(settingsLayers.project, "GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT") ??
						readSettingsEnvValue(settingsLayers.user, "GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT"),
				),
			},
		},
		configSources: sources,
	};
}

async function preloadSettingsEnv(flags: Readonly<Record<string, string | boolean>>): Promise<void> {
	const workingDirectory = resolve(readStringFlag(flags, "cwd", process.cwd()));
	const settingsPath = resolve(homedir(), ".genesis-cli", "settings.json");
	try {
		await ensureUserSettingsFile(settingsPath);
	} catch {}
	const settingsLayers = await loadSettingsLayers(settingsPath, workingDirectory);
	applySettingsEnv(settingsLayers.mergedEnv);
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

async function loadSettingsLayers(settingsPath: string, workingDirectory: string): Promise<LoadedSettingsLayers> {
	const projectSettingsPath = resolve(workingDirectory, ".genesis/settings.json");
	const localSettingsPath = resolve(workingDirectory, ".genesis/settings.local.json");
	const user = await readOptionalSettingsFile(settingsPath, "user");
	const project = await readOptionalSettingsFile(projectSettingsPath, "project");
	const local = await readOptionalSettingsFile(localSettingsPath, "local");
	return {
		user,
		project,
		local,
		mergedEnv: mergeSettingsEnv(user, project, local),
	};
}

async function readOptionalSettingsFile(filePath: string, layerLabel = "settings"): Promise<SettingsFile | null> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SettingsFileFormatError(filePath, layerLabel, "root value must be a JSON object");
		}
		return parsed as SettingsFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		if (error instanceof SettingsFileFormatError) {
			throw error;
		}
		const message = error instanceof Error ? error.message : "Unknown JSON parse error";
		throw new SettingsFileFormatError(filePath, layerLabel, message);
	}
}

export async function ensureUserSettingsFile(
	settingsPath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await mkdir(dirname(settingsPath), { recursive: true });
	try {
		await readFile(settingsPath, "utf8");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	try {
		await writeFile(settingsPath, `${JSON.stringify(buildDefaultSettingsFile(env), null, 2)}\n`, {
			flag: "wx",
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
}

function buildDefaultSettingsFile(env: NodeJS.ProcessEnv = process.env): SettingsFile {
	const modelId = normalizeOptionalString(env.GENESIS_MODEL_ID) ?? "glm-5.1";
	return {
		env: {
			GENESIS_API_KEY: "your_zhipu_api_key",
			GENESIS_BOOTSTRAP_BASE_URL: resolveDefaultBootstrapBaseUrl(env),
			GENESIS_BOOTSTRAP_API: normalizeOptionalString(env.GENESIS_BOOTSTRAP_API) ?? "openai-completions",
			GENESIS_MODEL_PROVIDER: normalizeOptionalString(env.GENESIS_MODEL_PROVIDER) ?? "zai",
			GENESIS_MODEL_ID: modelId,
		},
	};
}

function mergeSettingsEnv(...settingsFiles: readonly (SettingsFile | null)[]): Readonly<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const settingsFile of settingsFiles) {
		if (!settingsFile?.env) {
			continue;
		}
		for (const [key, value] of Object.entries(settingsFile.env)) {
			if (typeof value === "string") {
				const normalized = normalizeSettingsEnvEntry(key, value);
				if (normalized !== undefined) {
					env[key] = normalized;
				}
				continue;
			}
			if (typeof value === "number" || typeof value === "boolean") {
				env[key] = String(value);
			}
		}
	}
	return env;
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

function readSettingsEnvValue(settingsFile: SettingsFile | null, key: string): string | undefined {
	const value = settingsFile?.env?.[key];
	if (typeof value === "string") {
		return normalizeSettingsEnvEntry(key, value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

function normalizeSettingsEnvEntry(key: string, value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (isPlaceholderApiKeyValue(key, trimmed)) {
		return undefined;
	}
	return trimmed;
}

function isPlaceholderApiKeyValue(key: string, value: string): boolean {
	if (!key.endsWith("_API_KEY")) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "your_api_key" || /^your_[a-z0-9_]+_api_key$/.test(normalized);
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
		return parseBooleanLike(value);
	}
	if (envValue === undefined) {
		return undefined;
	}
	return parseBooleanLike(envValue);
}

function parseBooleanLike(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
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
	process.stdout.write(`  --debug, -d\n`);
	process.stdout.write(`  --tools read,bash,edit,write\n`);
	process.stdout.write(`  --thinking off|minimal|low|medium|high|xhigh\n`);
	process.stdout.write(`  --bootstrap-base-url <url>\n`);
	process.stdout.write(`  --bootstrap-api openai-completions|anthropic-messages\n`);
	process.stdout.write(`  --bootstrap-api-key-env <env-var>\n`);
	process.stdout.write(`\n`);
}

export function formatDebugSessionBanner(session: DebugLoggerSession): string {
	return `[genesis-debug] trace-id: ${session.traceId}\n[genesis-debug] logs: ${session.sessionDir}\n`;
}

function readDebugFlag(flags: Readonly<Record<string, string | boolean>>): boolean {
	return _readBooleanFlag(flags, "debug", process.env.GENESIS_DEBUG, false);
}

if (typeof require !== "undefined" && require.main === module) {
	void main().catch((error) => {
		const traceId = getLastDebugSession()?.traceId;
		const suffix = traceId ? ` [trace-id: ${traceId}]` : "";
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}${suffix}\n`);
		process.exitCode = 1;
	});
}

export function readCliPackageVersion(packageJsonPath = resolve(__dirname, "../package.json")): string {
	const raw = readFileSync(packageJsonPath, "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
}
