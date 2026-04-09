import type { ModelDescriptor, PiMonoResolvedAuthReport } from "@pickle-pee/runtime";
import { resolvePiMonoAuthReport } from "@pickle-pee/runtime";

export interface InteractiveStartupOptions {
	readonly bootstrapOverrides?: {
		readonly baseUrl?: string;
		readonly api?: string;
		readonly apiKeyEnv?: string;
	};
	readonly model: ModelDescriptor;
	readonly agentDir?: string;
}

export interface InteractiveStartupInput {
	readonly options: InteractiveStartupOptions;
	readonly env?: NodeJS.ProcessEnv;
	readonly resolveAuthReport?: (input: {
		readonly agentDir?: string;
		readonly model: ModelDescriptor;
	}) => Promise<PiMonoResolvedAuthReport>;
}

export interface InteractiveStartupResult {
	readonly authReport: PiMonoResolvedAuthReport;
}

export function validateInteractiveModelConfiguration(
	options: InteractiveStartupOptions,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const requiredApiKeyEnv = options.bootstrapOverrides?.apiKeyEnv?.trim() || "GENESIS_API_KEY";
	const requiredApiKeyValue = env[requiredApiKeyEnv]?.trim();
	if (!requiredApiKeyValue || requiredApiKeyValue === "your_zhipu_api_key") {
		throw new Error(`${requiredApiKeyEnv} is required for interactive mode.`);
	}
	if (!options.bootstrapOverrides?.baseUrl?.trim()) {
		throw new Error("GENESIS_BOOTSTRAP_BASE_URL is required for interactive mode.");
	}
	if (!options.bootstrapOverrides?.api?.trim()) {
		throw new Error("GENESIS_BOOTSTRAP_API is required for interactive mode.");
	}
	if (!options.model.provider.trim()) {
		throw new Error("GENESIS_MODEL_PROVIDER is required for interactive mode.");
	}
	if (!options.model.id.trim()) {
		throw new Error("GENESIS_MODEL_ID is required for interactive mode.");
	}
}

export async function runInteractiveStartupDiagnostics(
	input: InteractiveStartupInput,
): Promise<InteractiveStartupResult> {
	validateInteractiveModelConfiguration(input.options, input.env);
	const resolver = input.resolveAuthReport ?? resolvePiMonoAuthReport;
	const authReport = await resolver({
		agentDir: input.options.agentDir,
		model: input.options.model,
	});
	if (!authReport.authorized || authReport.placeholder || authReport.sourceKind === "missing") {
		throw new Error(
			`Model ${input.options.model.provider}/${input.options.model.id} is not authenticated. ` +
				`Run settings and set a valid API key before retrying.`,
		);
	}
	return { authReport };
}
