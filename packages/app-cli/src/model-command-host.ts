import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppRuntime, ModelDescriptor, SessionFacade } from "@pickle-pee/runtime";
import type { ModelOption, SlashCommandHost } from "@pickle-pee/ui";
import { ensureAgentDirBootstrapped } from "./bootstrap.js";

interface SettingsFile {
	readonly provider?: string;
	readonly model?: string;
	readonly env?: Readonly<Record<string, unknown>>;
}

interface BootstrapDefaults {
	readonly baseUrl?: string;
	readonly api?: string;
}

export interface ModelCommandHostOptions {
	readonly agentDir?: string;
	readonly settingsPath?: string;
	readonly bootstrapDefaults?: BootstrapDefaults;
}

interface ModelsFile {
	readonly providers?: Record<string, { readonly models?: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>>;
}

export function createModelCommandHost(options: ModelCommandHostOptions): SlashCommandHost {
	return {
		async listAvailableModels(current: ModelDescriptor): Promise<readonly ModelOption[]> {
			const catalog = await readConfiguredModels(options.agentDir, current.provider);
			const currentEntry = catalog.find((entry) => entry.id === current.id);
			if (currentEntry) {
				return catalog;
			}
			return [
				{ id: current.id, provider: current.provider, displayName: current.displayName },
				...catalog,
			];
		},

		async switchModel(params): Promise<{ readonly model: ModelDescriptor; readonly persistedTo?: string }> {
			const current = params.session.state.model;
			const nextModel: ModelDescriptor = {
				id: params.modelId,
				provider: current.provider,
				displayName: params.modelId,
			};

			await ensureModelConfigured(options, current.provider, params.modelId);
			await params.session.switchModel(nextModel);
			params.runtime.setDefaultModel(nextModel);
			const persistedTo = await persistDefaultModel(options.settingsPath, nextModel);

			return {
				model: nextModel,
				persistedTo,
			};
		},
	};
}

async function readConfiguredModels(agentDir: string | undefined, provider: string): Promise<readonly ModelOption[]> {
	if (!agentDir) {
		return [];
	}
	const parsed = await readModelsFile(join(agentDir, "models.json"));
	const providerRecord = parsed.providers?.[provider];
	const models = Array.isArray(providerRecord?.models) ? providerRecord.models : [];
	return models
		.map((entry) => ({
			id: typeof entry.id === "string" ? entry.id : "",
			provider,
			displayName: typeof entry.name === "string" ? entry.name : undefined,
			reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
		}))
		.filter((entry) => entry.id.length > 0)
		.sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureModelConfigured(
	options: ModelCommandHostOptions,
	provider: string,
	modelId: string,
): Promise<void> {
	if (!options.agentDir) {
		throw new Error("Model switching requires an agent directory.");
	}
	await ensureAgentDirBootstrapped({
		agentDir: options.agentDir,
		provider,
		modelId,
		bootstrapBaseUrl: options.bootstrapDefaults?.baseUrl,
		bootstrapApi: options.bootstrapDefaults?.api,
	});
}

async function persistDefaultModel(
	settingsPath: string | undefined,
	model: ModelDescriptor,
): Promise<string | undefined> {
	if (!settingsPath) {
		return undefined;
	}
	await mkdir(dirname(settingsPath), { recursive: true });
	const current = await readSettingsFile(settingsPath);
	const next: SettingsFile = {
		...current,
		provider: model.provider,
		model: model.id,
	};
	await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return settingsPath;
}

async function readModelsFile(filePath: string): Promise<ModelsFile> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as ModelsFile;
	} catch {
		return {};
	}
}

async function readSettingsFile(filePath: string): Promise<SettingsFile> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as SettingsFile;
	} catch {
		return {};
	}
}
