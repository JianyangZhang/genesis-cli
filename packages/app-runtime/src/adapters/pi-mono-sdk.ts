import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export type PiMonoAuthSourceKind = "auth_storage" | "env" | "literal" | "missing";

export interface PiMonoTool {
	readonly name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: ((partialResult: unknown) => void) | undefined,
	): Promise<unknown>;
}

export interface CreateAgentSessionOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly model?: Record<string, unknown>;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly tools?: readonly PiMonoTool[];
	readonly authStorage?: unknown;
	readonly modelRegistry?: unknown;
	readonly sessionManager?: unknown;
}

interface KernelSessionContract {
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(input: string): Promise<void>;
	followUp(input: string): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	getSnapshot(): Promise<{
		readonly sessionId: string;
		readonly sessionFile?: string;
		readonly metadata: unknown;
	}>;
	dispose(): void;
}

export interface PiMonoSdk {
	AuthStorage: {
		create(filePath?: string): unknown;
	};
	ModelRegistry: {
		create(
			authStorage: unknown,
			modelsPath?: string,
		): {
			find(provider: string, modelId: string): Record<string, unknown> | undefined;
			getRequestAuth?(model: Record<string, unknown>):
				| {
						ok: true;
						source?: { kind: PiMonoAuthSourceKind; detail?: string; placeholder?: boolean };
				  }
				| {
						ok: false;
						error: string;
						source?: { kind: PiMonoAuthSourceKind; detail?: string; placeholder?: boolean };
				  };
		};
	};
	SessionManager: {
		create(cwd: string): unknown;
		open(sessionPath: string): unknown;
	};
	createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: KernelSessionContract }>;
	createBashTool(cwd: string): PiMonoTool;
	createEditTool(cwd: string): PiMonoTool;
	createFindTool(cwd: string): PiMonoTool;
	createGrepTool(cwd: string): PiMonoTool;
	createLsTool(cwd: string): PiMonoTool;
	createReadTool(cwd: string): PiMonoTool;
	createWriteTool(cwd: string): PiMonoTool;
}

export interface LoadPiMonoSdkOptions {
	readonly importModule?: (specifier: string) => Promise<unknown>;
	readonly fileCandidates?: readonly string[];
}

export async function loadPiMonoSdk(options: LoadPiMonoSdkOptions = {}): Promise<PiMonoSdk> {
	const importModule = options.importModule ?? defaultImportModule;
	try {
		return (await importModule("@pickle-pee/kernel")) as PiMonoSdk;
	} catch {}

	const candidates = options.fileCandidates ?? resolvePiMonoSdkCandidates();
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return (await importModule(pathToFileURL(candidate).href)) as PiMonoSdk;
		}
	}
	throw new Error("Unable to resolve the vendored Genesis kernel module");
}

export async function defaultCreateSession(options: CreateAgentSessionOptions): Promise<KernelSessionContract> {
	const sdk = await loadPiMonoSdk();
	const result = await sdk.createAgentSession(options);
	return result.session;
}

export function createToolsForSet(cwd: string, toolSet: readonly string[], sdk: PiMonoSdk): PiMonoTool[] {
	const tools: PiMonoTool[] = [];
	for (const toolName of toolSet) {
		switch (toolName) {
			case "read":
				tools.push(sdk.createReadTool(cwd));
				break;
			case "bash":
				tools.push(sdk.createBashTool(cwd));
				break;
			case "edit":
				tools.push(sdk.createEditTool(cwd));
				break;
			case "write":
				tools.push(sdk.createWriteTool(cwd));
				break;
			case "grep":
				tools.push(sdk.createGrepTool(cwd));
				break;
			case "find":
				tools.push(sdk.createFindTool(cwd));
				break;
			case "ls":
				tools.push(sdk.createLsTool(cwd));
				break;
			default:
				break;
		}
	}
	return tools.length > 0 ? tools : createToolsForSet(cwd, defaultToolSet(), sdk);
}

export function defaultToolSet(): readonly string[] {
	return ["read", "bash", "edit", "write"];
}

export function extractTargetPath(parameters: Readonly<Record<string, unknown>> | undefined): string | undefined {
	if (!parameters) {
		return undefined;
	}
	if (typeof parameters.file_path === "string") {
		return parameters.file_path;
	}
	if (typeof parameters.path === "string") {
		return parameters.path;
	}
	if (Array.isArray(parameters.file_paths)) {
		const first = parameters.file_paths.find((p) => typeof p === "string" && p.length > 0);
		return typeof first === "string" ? first : undefined;
	}
	return undefined;
}

async function defaultImportModule(specifier: string): Promise<unknown> {
	return await import(specifier);
}

function resolvePiMonoSdkCandidates(): readonly string[] {
	return [
		resolvePath(__dirname, "../../../kernel/dist/index.js"),
		resolvePath(__dirname, "../../../kernel/src/index.ts"),
		resolvePath(process.cwd(), "packages/kernel/dist/index.js"),
		resolvePath(process.cwd(), "packages/kernel/src/index.ts"),
	];
}
