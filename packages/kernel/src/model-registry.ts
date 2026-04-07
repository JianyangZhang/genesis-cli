import { existsSync, readFileSync } from "node:fs";
import type { Model } from "@pickle-pee/pi-ai";
import type { AuthStorage } from "./auth-storage.js";

interface KernelModelConfig {
	readonly id: string;
	readonly name?: string;
	readonly api?: string;
	readonly baseUrl?: string;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly cost?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
	};
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly headers?: Record<string, string>;
	readonly compat?: Record<string, unknown>;
}

interface KernelProviderConfig {
	readonly baseUrl?: string;
	readonly api?: string;
	readonly apiKey?: string;
	readonly authHeader?: boolean;
	readonly headers?: Record<string, string>;
	readonly compat?: Record<string, unknown>;
	readonly models?: readonly KernelModelConfig[];
}

interface KernelModelsFile {
	readonly providers?: Record<string, KernelProviderConfig>;
}

type KernelModelRecord = {
	readonly model: Model<any>;
	readonly providerConfig: KernelProviderConfig;
};

export type KernelResolvedAuth =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly headers?: Record<string, string>;
			readonly source: KernelAuthSource;
	  }
	| {
			readonly ok: false;
			readonly error: string;
			readonly source: KernelAuthSource;
	  };

export interface KernelAuthSource {
	readonly kind: "auth_storage" | "env" | "literal" | "missing";
	readonly detail?: string;
	readonly placeholder?: boolean;
}

export class ModelRegistry {
	private readonly providers: Map<string, KernelProviderConfig>;
	private readonly models: Map<string, KernelModelRecord>;

	private constructor(
		private readonly authStorage: AuthStorage,
		private readonly modelsPath?: string,
	) {
		const parsed = this.load();
		this.providers = new Map(Object.entries(parsed.providers ?? {}));
		this.models = new Map();

		for (const [provider, providerConfig] of this.providers) {
			for (const modelConfig of providerConfig.models ?? []) {
				this.models.set(this.key(provider, modelConfig.id), {
					model: {
						id: modelConfig.id,
						name: modelConfig.name ?? modelConfig.id,
						api: modelConfig.api ?? providerConfig.api ?? "openai-completions",
						provider,
						baseUrl: modelConfig.baseUrl ?? providerConfig.baseUrl ?? "",
						reasoning: modelConfig.reasoning ?? false,
						input: [...(modelConfig.input ?? ["text"])],
						cost: {
							input: modelConfig.cost?.input ?? 0,
							output: modelConfig.cost?.output ?? 0,
							cacheRead: modelConfig.cost?.cacheRead ?? 0,
							cacheWrite: modelConfig.cost?.cacheWrite ?? 0,
						},
						contextWindow: modelConfig.contextWindow ?? 128_000,
						maxTokens: modelConfig.maxTokens ?? 16_384,
						headers: {
							...(providerConfig.headers ?? {}),
							...(modelConfig.headers ?? {}),
						},
						compat: {
							...(providerConfig.compat ?? {}),
							...(modelConfig.compat ?? {}),
						},
					},
					providerConfig,
				});
			}
		}
	}

	static create(authStorage: AuthStorage, modelsPath?: string): ModelRegistry {
		return new ModelRegistry(authStorage, modelsPath);
	}

	find(provider: string, modelId: string): Model<any> | undefined {
		return this.models.get(this.key(provider, modelId))?.model;
	}

	list(): Model<any>[] {
		return Array.from(this.models.values(), (entry) => entry.model);
	}

	getRequestAuth(model: Model<any>): KernelResolvedAuth {
		const record = this.models.get(this.key(model.provider, model.id));
		const providerConfig = record?.providerConfig ?? this.providers.get(model.provider);
		if (!providerConfig) {
			return {
				ok: false,
				error: `Unknown provider: ${model.provider}`,
				source: { kind: "missing", detail: "provider config not found" },
			};
		}

		const explicit = providerConfig.apiKey;
		const resolved = this.resolveApiKey(model.provider, explicit);
		const apiKey = resolved.apiKey;
		const hasPlaceholderApiKey = typeof apiKey === "string" && isPlaceholderApiKeyValue(apiKey);

		const headers = {
			...(providerConfig.headers ?? {}),
			...(model.headers ?? {}),
		};

		if (providerConfig.authHeader !== false && apiKey && !hasPlaceholderApiKey) {
			headers.authorization = `Bearer ${apiKey}`;
		}

		if ((!apiKey || hasPlaceholderApiKey) && Object.keys(headers).length === 0) {
			const envName = explicit && /^[A-Z0-9_]+$/.test(explicit) ? explicit : `${model.provider.toUpperCase()}_API_KEY`;
			return {
				ok: false,
				error: hasPlaceholderApiKey
					? `Placeholder API key configured for ${model.provider}/${model.id}. Replace ${envName} with a real API key.`
					: `No API key found for ${model.provider}/${model.id}. Set ${envName} before sending prompts.`,
				source: hasPlaceholderApiKey
					? { ...resolved.source, placeholder: true }
					: resolved.source.kind === "missing"
						? { kind: "missing", detail: envName }
						: resolved.source,
			};
		}

		return {
			ok: true,
			apiKey: hasPlaceholderApiKey ? undefined : apiKey,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			source: hasPlaceholderApiKey ? { ...resolved.source, placeholder: true } : resolved.source,
		};
	}

	hasConfiguredAuth(model: Model<any>): boolean {
		return this.getRequestAuth(model).ok;
	}

	private key(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private load(): KernelModelsFile {
		if (!this.modelsPath || !existsSync(this.modelsPath)) {
			return {};
		}

		try {
			return JSON.parse(readFileSync(this.modelsPath, "utf8")) as KernelModelsFile;
		} catch {
			return {};
		}
	}

	private resolveConfigValue(value: string): string | undefined {
		if (value.startsWith("$")) {
			return process.env[value.slice(1)];
		}
		if (/^[A-Z0-9_]+$/.test(value)) {
			return process.env[value];
		}
		return value;
	}

	private resolveApiKey(provider: string, explicit: string | undefined): { apiKey?: string; source: KernelAuthSource } {
		const stored = this.authStorage.getApiKey(provider);
		if (stored) {
			return {
				apiKey: stored,
				source: { kind: "auth_storage", detail: `${provider} auth.json` },
			};
		}
		if (!explicit) {
			return { apiKey: undefined, source: { kind: "missing" } };
		}
		if (explicit.startsWith("$")) {
			const envName = explicit.slice(1);
			return {
				apiKey: process.env[envName],
				source: process.env[envName] ? { kind: "env", detail: envName } : { kind: "missing", detail: envName },
			};
		}
		if (/^[A-Z0-9_]+$/.test(explicit)) {
			return {
				apiKey: process.env[explicit],
				source: process.env[explicit] ? { kind: "env", detail: explicit } : { kind: "missing", detail: explicit },
			};
		}
		return {
			apiKey: explicit,
			source: { kind: "literal", detail: "models.json literal apiKey" },
		};
	}
}

function isPlaceholderApiKeyValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "your_api_key" || /^your_[a-z0-9_]+_api_key$/.test(normalized);
}
