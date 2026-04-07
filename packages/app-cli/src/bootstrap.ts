import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface EnsureBootstrapOptions {
	readonly agentDir: string;
	readonly provider: string;
	readonly modelId: string;
	readonly displayName?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly bootstrapBaseUrl?: string;
	readonly bootstrapApi?: string;
	readonly bootstrapApiKeyEnv?: string;
	readonly bootstrapAuthHeader?: boolean;
	readonly bootstrapReasoning?: boolean;
	readonly supportsDeveloperRole?: boolean;
	readonly supportsReasoningEffort?: boolean;
}

export function resolveDefaultBootstrapBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const pick = (value: string | undefined): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	};
	return (
		pick(env.GENESIS_BOOTSTRAP_BASE_URL) ??
		"https://open.bigmodel.cn/api/coding/paas/v4/"
	);
}

export async function ensureAgentDirBootstrapped(options: EnsureBootstrapOptions): Promise<void> {
	const explicitBaseUrl =
		typeof options.bootstrapBaseUrl === "string" && options.bootstrapBaseUrl.trim().length > 0
			? options.bootstrapBaseUrl.trim()
			: undefined;
	if (!explicitBaseUrl) {
		throw new Error("GENESIS_BOOTSTRAP_BASE_URL is required for bootstrap.");
	}
	const api = typeof options.bootstrapApi === "string" && options.bootstrapApi.trim().length > 0 ? options.bootstrapApi : undefined;
	if (!api) {
		throw new Error("GENESIS_BOOTSTRAP_API is required for bootstrap.");
	}
	const baseUrl = explicitBaseUrl;
	const apiKeyEnv = options.bootstrapApiKeyEnv ?? "GENESIS_API_KEY";
	const authHeader = options.bootstrapAuthHeader ?? api !== "anthropic-messages";
	const reasoning =
		options.bootstrapReasoning ?? (options.thinkingLevel !== undefined ? options.thinkingLevel !== "off" : false);

	await mkdir(options.agentDir, { recursive: true });
	const modelsPath = resolve(options.agentDir, "models.json");
	const existing = await readJsonFile(modelsPath);
	const providers = existing?.providers && typeof existing.providers === "object" ? existing.providers : {};

	const providerKey = options.provider;
	const existingProvider = providers[providerKey];
	const providerRecord =
		existingProvider && typeof existingProvider === "object" ? (existingProvider as Record<string, unknown>) : {};

	const existingModels = Array.isArray(providerRecord.models)
		? (providerRecord.models as Array<Record<string, unknown>>)
		: [];

	const providerHasConfig =
		typeof providerRecord.baseUrl === "string" &&
		providerRecord.baseUrl.length > 0 &&
		typeof providerRecord.api === "string" &&
		providerRecord.api.length > 0 &&
		typeof providerRecord.apiKey === "string" &&
		providerRecord.apiKey.length > 0 &&
		typeof providerRecord.authHeader === "boolean";
	const modelAlreadyConfigured = existingModels.some((model) => model.id === options.modelId);
	if (providerHasConfig && modelAlreadyConfigured) {
		return;
	}

	const compat: Record<string, boolean> = {};
	if (options.supportsDeveloperRole !== undefined) {
		compat.supportsDeveloperRole = options.supportsDeveloperRole;
	}
	if (options.supportsReasoningEffort !== undefined) {
		compat.supportsReasoningEffort = options.supportsReasoningEffort;
	}

	const nextModel: Record<string, unknown> = {
		id: options.modelId,
		name: options.displayName ?? options.modelId,
		reasoning,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(Object.keys(compat).length > 0 ? { compat } : {}),
	};

	const nextModels = [...existingModels.filter((model) => model.id !== options.modelId), nextModel];

	providers[providerKey] = {
		...providerRecord,
		baseUrl:
			typeof providerRecord.baseUrl === "string" && providerRecord.baseUrl.length > 0
				? providerRecord.baseUrl
				: baseUrl,
		api: typeof providerRecord.api === "string" && providerRecord.api.length > 0 ? providerRecord.api : api,
		apiKey:
			typeof providerRecord.apiKey === "string" && providerRecord.apiKey.length > 0
				? providerRecord.apiKey
				: apiKeyEnv,
		authHeader: typeof providerRecord.authHeader === "boolean" ? providerRecord.authHeader : authHeader,
		models: nextModels,
	};

	await writeFile(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

async function readJsonFile(filePath: string): Promise<{ providers?: Record<string, unknown> } | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as { providers?: Record<string, unknown> };
	} catch {
		return null;
	}
}
