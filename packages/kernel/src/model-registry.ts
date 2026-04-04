import { existsSync, readFileSync } from "node:fs";
import type { Model } from "@mariozechner/pi-ai";
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
	  }
	| {
			readonly ok: false;
			readonly error: string;
	  };

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
			return { ok: false, error: `Unknown provider: ${model.provider}` };
		}

		const explicit = providerConfig.apiKey;
		const apiKey =
			this.authStorage.getApiKey(model.provider) ??
			(explicit ? this.resolveConfigValue(explicit) : undefined) ??
			this.resolveProviderEnvFallback(model.provider);

		const headers = {
			...(providerConfig.headers ?? {}),
			...(model.headers ?? {}),
		};

		if (providerConfig.authHeader !== false && apiKey) {
			headers.authorization = `Bearer ${apiKey}`;
		}

		if (!apiKey && Object.keys(headers).length === 0) {
			return { ok: false, error: `No API key found for ${model.provider}/${model.id}` };
		}

		return {
			ok: true,
			apiKey,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
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
			return process.env[value] ?? value;
		}
		return value;
	}

	private resolveProviderEnvFallback(provider: string): string | undefined {
		const normalized = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
		return process.env[`${normalized}_API_KEY`];
	}
}
