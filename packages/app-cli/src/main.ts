#!/usr/bin/env node

import { resolve } from "node:path";
import { createAppRuntime, PiMonoSessionAdapter, type CliMode, type ModelDescriptor } from "@genesis-cli/runtime";
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
	if (parsed.flags.help) {
		printHelp();
		return;
	}

	const options = resolveCliOptions(parsed.flags);
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

function resolveCliOptions(flags: Readonly<Record<string, string | boolean>>): CliOptions {
	const workingDirectory = resolve(readStringFlag(flags, "cwd", process.cwd()));
	const agentDir = resolve(readStringFlag(flags, "agent-dir", resolve(".genesis-local/pi-agent")));
	const mode = readModeFlag(flags, "mode", "interactive");
	const provider = readStringFlag(flags, "provider", process.env.GENESIS_MODEL_PROVIDER ?? "zai");
	const modelId = readStringFlag(flags, "model", process.env.GENESIS_MODEL_ID ?? "glm-5.1");
	const displayName = readOptionalStringFlag(flags, "display-name", process.env.GENESIS_MODEL_DISPLAY_NAME);
	const toolSet = splitCsv(readStringFlag(flags, "tools", process.env.GENESIS_TOOL_SET ?? "read,bash,edit,write"));
	const thinkingLevel = readOptionalStringFlag(flags, "thinking", process.env.GENESIS_THINKING_LEVEL) as
		| ThinkingLevel
		| undefined;
	const bootstrapBaseUrl = normalizeOptionalString(
		readOptionalStringFlag(flags, "bootstrap-base-url", process.env.GENESIS_BOOTSTRAP_BASE_URL),
	);
	const bootstrapApi = normalizeOptionalString(readOptionalStringFlag(flags, "bootstrap-api", process.env.GENESIS_BOOTSTRAP_API));

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
			apiKeyEnv: readOptionalStringFlag(flags, "bootstrap-api-key-env", process.env.GENESIS_BOOTSTRAP_API_KEY_ENV),
			authHeader: readOptionalBooleanFlag(flags, "bootstrap-auth-header", process.env.GENESIS_BOOTSTRAP_AUTH_HEADER),
			reasoning: readOptionalBooleanFlag(flags, "bootstrap-reasoning", process.env.GENESIS_BOOTSTRAP_REASONING),
			compat: {
				supportsDeveloperRole: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-developer-role",
					process.env.GENESIS_BOOTSTRAP_SUPPORTS_DEVELOPER_ROLE,
				),
				supportsReasoningEffort: readOptionalBooleanFlag(
					flags,
					"bootstrap-supports-reasoning-effort",
					process.env.GENESIS_BOOTSTRAP_SUPPORTS_REASONING_EFFORT,
				),
			},
		},
	};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readModeFlag(
	flags: Readonly<Record<string, string | boolean>>,
	key: string,
	fallback: CliMode,
): CliMode {
	const value = readStringFlag(flags, key, fallback);
	if (value === "interactive" || value === "print" || value === "json" || value === "rpc") {
		return value;
	}
	throw new Error(`Unsupported mode: ${value}`);
}

function readStringFlag(
	flags: Readonly<Record<string, string | boolean>>,
	key: string,
	fallback: string,
): string {
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

function readBooleanFlag(
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
