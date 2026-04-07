import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelDescriptor, SessionRecoveryData } from "../types/index.js";
import type { KernelSessionAdapter, RawUpstreamEvent, ToolExecutionGate } from "./kernel-session-adapter.js";
import { bridgePiMonoEvent, createInitialBridgeState, type PiMonoBridgeState } from "./pi-mono-event-bridge.js";

type PermissionDecision = "allow" | "allow_for_session" | "allow_once" | "deny";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type PiMonoModel = Record<string, unknown>;

export interface PiMonoResolvedAuthReport {
	readonly provider: string;
	readonly modelId: string;
	readonly sourceKind: "auth_storage" | "env" | "literal" | "missing";
	readonly sourceDetail?: string;
	readonly placeholder: boolean;
	readonly authorized: boolean;
}

interface AgentSession {
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(input: string): Promise<void>;
	followUp(input: string): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	getSnapshot(): Promise<AgentSessionSnapshot>;
	dispose(): void;
}

interface AgentSessionSnapshot {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly metadata: SessionRecoveryData["metadata"];
}

interface PiMonoTool {
	readonly name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: ((partialResult: unknown) => void) | undefined,
	): Promise<unknown>;
}

interface CreateAgentSessionOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly model?: PiMonoModel;
	readonly thinkingLevel?: ThinkingLevel;
	readonly tools?: readonly PiMonoTool[];
	readonly authStorage?: unknown;
	readonly modelRegistry?: unknown;
	readonly sessionManager?: unknown;
}

interface PiMonoSdk {
	AuthStorage: {
		create(filePath?: string): unknown;
	};
	ModelRegistry: {
		create(
			authStorage: unknown,
			modelsPath?: string,
		): {
			find(provider: string, modelId: string): PiMonoModel | undefined;
			getRequestAuth?(model: PiMonoModel):
				| {
						ok: true;
						source?: {
							kind: PiMonoResolvedAuthReport["sourceKind"];
							detail?: string;
							placeholder?: boolean;
						};
				  }
				| {
						ok: false;
						error: string;
						source?: {
							kind: PiMonoResolvedAuthReport["sourceKind"];
							detail?: string;
							placeholder?: boolean;
						};
				  };
		};
	};
	SessionManager: {
		create(cwd: string): unknown;
		open(sessionPath: string): unknown;
	};
	createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: AgentSession }>;
	createBashTool(cwd: string): PiMonoTool;
	createEditTool(cwd: string): PiMonoTool;
	createFindTool(cwd: string): PiMonoTool;
	createGrepTool(cwd: string): PiMonoTool;
	createLsTool(cwd: string): PiMonoTool;
	createReadTool(cwd: string): PiMonoTool;
	createWriteTool(cwd: string): PiMonoTool;
}

interface Deferred<T> {
	resolve(value: T): void;
	reject(reason?: unknown): void;
	promise: Promise<T>;
}

interface LoadPiMonoSdkOptions {
	readonly importModule?: (specifier: string) => Promise<unknown>;
	readonly fileCandidates?: readonly string[];
}

interface ExtendedRecoveryData extends SessionRecoveryData {
	readonly workingDirectory?: string;
	readonly sessionFile?: string;
	readonly agentDir?: string;
}

export interface PiMonoSessionAdapterOptions {
	readonly workingDirectory: string;
	readonly agentDir?: string;
	readonly historyDir?: string;
	readonly model: ModelDescriptor;
	readonly toolSet?: readonly string[];
	readonly thinkingLevel?: ThinkingLevel;
	readonly createTools?: (cwd: string, toolSet: readonly string[]) => PiMonoTool[];
	readonly createSession?: (options: CreateAgentSessionOptions) => Promise<AgentSession>;
	readonly onAuthResolved?: (report: PiMonoResolvedAuthReport) => void;
	readonly onUpstreamEvent?: (event: unknown) => void;
	readonly onSessionRecovered?: (report: {
		readonly mode: "resume" | "new";
		readonly sessionFile?: string;
	}) => void;
}

export class PiMonoSessionAdapter implements KernelSessionAdapter {
	private session: AgentSession | null = null;
	private toolExecutionGate: ToolExecutionGate | null = null;
	private activeQueue: AsyncPushQueue<RawUpstreamEvent> | null = null;
	private readonly pendingToolStartEvents = new Map<string, RawUpstreamEvent>();
	private readonly approvedToolCalls = new Set<string>();
	private readonly deniedToolCalls = new Set<string>();
	private readonly pendingPermissionResolvers = new Map<string, Deferred<PermissionDecision>>();
	private pendingRecoveryData: ExtendedRecoveryData | null = null;
	private closed = false;
	private bridgeState: PiMonoBridgeState;
	private currentModel: ModelDescriptor;

	constructor(private readonly options: PiMonoSessionAdapterOptions) {
		this.currentModel = options.model;
		this.bridgeState = createInitialBridgeState({
			model: this.currentModel,
			toolSet: options.toolSet ?? defaultToolSet(),
		});
	}

	setToolExecutionGate(gate: ToolExecutionGate): void {
		this.toolExecutionGate = gate;
	}

	async *sendPrompt(input: string): AsyncIterable<RawUpstreamEvent> {
		yield* this.runPromptLikeOperation(input, "prompt");
	}

	async *sendContinue(input: string): AsyncIterable<RawUpstreamEvent> {
		yield* this.runPromptLikeOperation(input, "continue");
	}

	async *sendCompact(customInstructions?: string): AsyncIterable<RawUpstreamEvent> {
		yield* this.runCompactOperation(customInstructions);
	}

	async resolveToolPermission(callId: string, decision: PermissionDecision): Promise<void> {
		const deferred = this.pendingPermissionResolvers.get(callId);
		if (!deferred) {
			return;
		}
		this.pendingPermissionResolvers.delete(callId);
		deferred.resolve(decision);
	}

	abort(): void {
		void this.session?.abort();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const [callId, deferred] of this.pendingPermissionResolvers) {
			deferred.resolve("deny");
			this.pendingPermissionResolvers.delete(callId);
		}
		this.session?.dispose();
		this.session = null;
		this.activeQueue?.close();
		this.activeQueue = null;
	}

	async getRecoveryData(): Promise<SessionRecoveryData> {
		const snapshot = await this.getActiveSnapshot();
		return {
			sessionId: { value: snapshot?.sessionId ?? "unknown-session" },
			model: this.currentModel,
			toolSet: [...this.bridgeState.toolSet],
			planSummary: null,
			compactionSummary: null,
			metadata: snapshot?.metadata ?? null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
			workingDirectory: this.pendingRecoveryData?.workingDirectory ?? this.options.workingDirectory,
			sessionFile: this.pendingRecoveryData?.sessionFile ?? snapshot?.sessionFile,
			agentDir: this.pendingRecoveryData?.agentDir ?? this.options.agentDir,
		};
	}

	resume(data: SessionRecoveryData): void {
		this.pendingRecoveryData = data;
	}

	async setModel(model: ModelDescriptor): Promise<void> {
		const recoveryData = await this.getRecoveryData();
		this.currentModel = model;
		this.bridgeState = createInitialBridgeState({
			model,
			toolSet: this.bridgeState.toolSet,
		});
		if (this.session) {
			this.session.dispose();
			this.session = null;
		}
		this.pendingRecoveryData = {
			...recoveryData,
			model,
		};
	}

	async validateStartupConfiguration(): Promise<PiMonoResolvedAuthReport> {
		if (this.options.createSession) {
			return {
				provider: this.currentModel.provider,
				modelId: this.currentModel.id,
				sourceKind: "missing",
				authorized: true,
				placeholder: false,
			};
		}
		const report = await this.resolveAuthReport();
		this.options.onAuthResolved?.(report);
		if (!report.authorized) {
			throw new Error(
				report.placeholder
					? `Placeholder API key configured for ${report.provider}/${report.modelId}. Replace ${
							report.sourceDetail ?? "the configured api key"
						} with a real API key.`
					: `No API key found for ${report.provider}/${report.modelId}. Set ${
							report.sourceDetail ?? "the configured api key"
						} before sending prompts.`,
			);
		}
		return report;
	}

	private async resolveAuthReport(): Promise<PiMonoResolvedAuthReport> {
		const recovery = this.pendingRecoveryData;
		const agentDir = recovery?.agentDir ?? this.options.agentDir;
		const sdk = await loadPiMonoSdk();
		const authStorage = sdk.AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
		const modelRegistry = sdk.ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
		const model = modelRegistry.find(this.currentModel.provider, this.currentModel.id) as PiMonoModel | undefined;
		if (!model) {
			throw new Error(
				`Model ${this.currentModel.provider}/${this.currentModel.id} is not configured in ${
					agentDir ?? ".genesis-local/agent"
				}/models.json`,
			);
		}
		const auth = modelRegistry.getRequestAuth?.(model);
		return {
			provider: this.currentModel.provider,
			modelId: this.currentModel.id,
			sourceKind: auth?.source?.kind ?? "missing",
			sourceDetail: auth?.source?.detail,
			placeholder: auth?.source?.placeholder === true,
			authorized: auth?.ok ?? true,
		};
	}

	private async *runPromptLikeOperation(input: string, mode: "prompt" | "continue"): AsyncIterable<RawUpstreamEvent> {
		if (this.closed) {
			throw new Error("Session adapter is closed");
		}

		await this.initialize();
		if (!this.session) {
			throw new Error("Underlying Genesis kernel session is unavailable");
		}

		this.pendingToolStartEvents.clear();
		this.approvedToolCalls.clear();
		this.deniedToolCalls.clear();

		const queue = new AsyncPushQueue<RawUpstreamEvent>();
		this.activeQueue = queue;
		let promptCompleted = false;

		const unsubscribe = this.session.subscribe((event) => {
			this.options.onUpstreamEvent?.(event);
			const bridged = bridgePiMonoEvent(event as never, this.bridgeState);
			this.bridgeState = bridged.nextState;

			for (const rawEvent of bridged.rawEvents) {
				this.handleRawEvent(rawEvent);
				if (promptCompleted && rawEvent.type === "agent_end") {
					queue.close();
				}
			}
		});

		const promptPromise = (async () => {
			try {
				if (mode === "continue" && this.session!.isStreaming) {
					await this.session!.followUp(input);
				} else {
					await this.session!.prompt(input);
				}
			} finally {
				promptCompleted = true;
				setTimeout(() => {
					if (this.activeQueue === queue) {
						queue.close();
					}
				}, 100);
			}
		})();

		try {
			while (true) {
				const next = await queue.next();
				if (next === null) {
					break;
				}
				yield next;
			}
			await promptPromise;
		} finally {
			unsubscribe();
			if (this.activeQueue === queue) {
				this.activeQueue = null;
			}
		}
	}

	private async *runCompactOperation(customInstructions?: string): AsyncIterable<RawUpstreamEvent> {
		if (this.closed) {
			throw new Error("Session adapter is closed");
		}

		await this.initialize();
		if (!this.session) {
			throw new Error("Underlying Genesis kernel session is unavailable");
		}

		this.pendingToolStartEvents.clear();
		this.approvedToolCalls.clear();
		this.deniedToolCalls.clear();

		const queue = new AsyncPushQueue<RawUpstreamEvent>();
		this.activeQueue = queue;
		let compactCompleted = false;

		const unsubscribe = this.session.subscribe((event) => {
			this.options.onUpstreamEvent?.(event);
			const bridged = bridgePiMonoEvent(event as never, this.bridgeState);
			this.bridgeState = bridged.nextState;

			for (const rawEvent of bridged.rawEvents) {
				this.handleRawEvent(rawEvent);
				if (compactCompleted && rawEvent.type === "compaction_end") {
					queue.close();
				}
			}
		});

		const compactPromise = (async () => {
			try {
				await this.session!.compact(customInstructions);
			} finally {
				compactCompleted = true;
				setTimeout(() => {
					if (this.activeQueue === queue) {
						queue.close();
					}
				}, 100);
			}
		})();

		try {
			while (true) {
				const next = await queue.next();
				if (next === null) {
					break;
				}
				yield next;
			}
			await compactPromise;
		} finally {
			unsubscribe();
			if (this.activeQueue === queue) {
				this.activeQueue = null;
			}
		}
	}

	private handleRawEvent(rawEvent: RawUpstreamEvent): void {
		if (rawEvent.type === "tool_execution_start" && this.toolExecutionGate) {
			const toolCallId = getToolCallId(rawEvent);
			if (toolCallId && this.deniedToolCalls.has(toolCallId)) {
				return;
			}
			if (toolCallId && this.approvedToolCalls.has(toolCallId)) {
				this.emitRawEvent(rawEvent);
				return;
			}
			if (toolCallId) {
				this.pendingToolStartEvents.set(toolCallId, rawEvent);
				return;
			}
		}

		const toolCallId = getToolCallId(rawEvent);
		if (
			toolCallId &&
			this.deniedToolCalls.has(toolCallId) &&
			(rawEvent.type === "tool_execution_update" || rawEvent.type === "tool_execution_end")
		) {
			if (rawEvent.type === "tool_execution_end") {
				this.cleanupToolCall(toolCallId);
			}
			return;
		}

		if (toolCallId && rawEvent.type === "tool_execution_end") {
			this.cleanupToolCall(toolCallId);
		}

		this.emitRawEvent(rawEvent);
	}

	private emitRawEvent(rawEvent: RawUpstreamEvent): void {
		this.activeQueue?.push(rawEvent);
	}

	private cleanupToolCall(toolCallId: string): void {
		this.pendingToolStartEvents.delete(toolCallId);
		this.approvedToolCalls.delete(toolCallId);
		this.deniedToolCalls.delete(toolCallId);
	}

	private approveToolCall(toolCallId: string): void {
		this.deniedToolCalls.delete(toolCallId);
		this.approvedToolCalls.add(toolCallId);
		const pendingStart = this.pendingToolStartEvents.get(toolCallId);
		if (pendingStart) {
			this.pendingToolStartEvents.delete(toolCallId);
			this.emitRawEvent(pendingStart);
		}
	}

	private denyToolCall(toolName: string, toolCallId: string, reason: string): void {
		this.pendingToolStartEvents.delete(toolCallId);
		this.approvedToolCalls.delete(toolCallId);
		this.deniedToolCalls.add(toolCallId);
		this.emitRawEvent({
			type: "tool_execution_denied",
			timestamp: Date.now(),
			payload: { toolName, toolCallId, reason },
		});
	}

	private async initialize(): Promise<void> {
		if (this.session) {
			return;
		}
		if (!this.options.createSession) {
			this.options.onAuthResolved?.(await this.resolveAuthReport());
		}
		this.session = await this.createUnderlyingSession();
	}

	private async getActiveSnapshot(): Promise<AgentSessionSnapshot | null> {
		if (!this.session) return null;
		try {
			return await this.session.getSnapshot();
		} catch {
			return null;
		}
	}

	private async createUnderlyingSession(): Promise<AgentSession> {
		const recovery = this.pendingRecoveryData;
		const workingDirectory = recovery?.workingDirectory ?? this.options.workingDirectory;
		const agentDir = recovery?.agentDir ?? this.options.agentDir;
		const toolSet = this.options.toolSet ?? defaultToolSet();

		if (this.options.createSession) {
			const tools = this.wrapTools(this.options.createTools?.(workingDirectory, toolSet) ?? []);
			const session = await this.options.createSession({
				cwd: workingDirectory,
				agentDir,
				model: {} as PiMonoModel,
				thinkingLevel: this.options.thinkingLevel,
				tools,
			});
			this.bridgeState = createInitialBridgeState({
				model: {
					id: this.currentModel.id,
					provider: this.currentModel.provider,
					displayName: this.currentModel.displayName,
				},
				toolSet: tools.map((tool) => tool.name),
			});
			this.pendingRecoveryData = null;
			return session;
		}

		const sdk = await loadPiMonoSdk();
		const authStorage = sdk.AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
		const modelRegistry = sdk.ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
		const model = modelRegistry.find(this.currentModel.provider, this.currentModel.id) as PiMonoModel | undefined;
		if (!model) {
			throw new Error(
				`Model ${this.currentModel.provider}/${this.currentModel.id} is not configured in ${
					agentDir ?? ".genesis-local/agent"
				}/models.json`,
			);
		}

		const tools = this.wrapTools(createToolsForSet(workingDirectory, toolSet, sdk));
		const sessionManager =
			recovery?.sessionFile && recovery.sessionFile.length > 0
				? sdk.SessionManager.open(recovery.sessionFile)
				: sdk.SessionManager.create(workingDirectory);
		this.options.onSessionRecovered?.({
			mode: recovery?.sessionFile && recovery.sessionFile.length > 0 ? "resume" : "new",
			sessionFile: recovery?.sessionFile,
		});

		const session = await defaultCreateSession({
			cwd: workingDirectory,
			agentDir,
			model,
			thinkingLevel: this.options.thinkingLevel,
			tools,
			authStorage,
			modelRegistry,
			sessionManager,
		});

		this.bridgeState = createInitialBridgeState({
			model: {
				id: this.currentModel.id,
				provider: this.currentModel.provider,
				displayName: this.currentModel.displayName,
			},
			toolSet: tools.map((tool) => tool.name),
		});
		this.pendingRecoveryData = null;
		return session;
	}

	private wrapTools(tools: readonly PiMonoTool[]): PiMonoTool[] {
		return tools.map((tool) => {
			return {
				...tool,
				execute: async (
					toolCallId: string,
					params: Parameters<PiMonoTool["execute"]>[1],
					signal?: AbortSignal,
					onUpdate?: Parameters<PiMonoTool["execute"]>[3],
				) => {
					return await this.executeGuardedTool(
						tool,
						toolCallId,
						params as Record<string, unknown>,
						signal,
						onUpdate,
					);
				},
			};
		});
	}

	private async executeGuardedTool(
		tool: PiMonoTool,
		toolCallId: string,
		parameters: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: Parameters<PiMonoTool["execute"]>[3],
	): Promise<ReturnType<PiMonoTool["execute"]> extends Promise<infer TResult> ? TResult : never> {
		const decision = this.toolExecutionGate?.beforeToolExecution({
			toolName: tool.name,
			toolCallId,
			parameters,
		}) ?? { type: "allow" as const };

		if (decision.type === "allow") {
			this.approveToolCall(toolCallId);
			return await tool.execute(toolCallId, parameters as never, signal, onUpdate as never);
		}

		if (decision.type === "deny") {
			this.denyToolCall(tool.name, toolCallId, decision.reason);
			throw new Error(decision.reason);
		}

		this.emitRawEvent({
			type: "permission_request",
			timestamp: Date.now(),
			payload: {
				toolName: tool.name,
				toolCallId,
				riskLevel: decision.riskLevel,
				reason: decision.reason,
				targetPath: extractTargetPath(parameters),
			},
		});

		const resolution = await this.waitForPermissionResolution(toolCallId, signal);
		if (resolution === "deny") {
			this.denyToolCall(tool.name, toolCallId, "Permission denied by user");
			throw new Error("Permission denied by user");
		}

		this.approveToolCall(toolCallId);
		return await tool.execute(toolCallId, parameters as never, signal, onUpdate as never);
	}

	private waitForPermissionResolution(toolCallId: string, signal?: AbortSignal): Promise<PermissionDecision> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Tool execution aborted while awaiting permission"));
		}

		const deferred = createDeferred<PermissionDecision>();
		const onAbort = () => {
			this.pendingPermissionResolvers.delete(toolCallId);
			deferred.reject(new Error("Tool execution aborted while awaiting permission"));
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.pendingPermissionResolvers.set(toolCallId, deferred);
		return deferred.promise.finally(() => {
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		});
	}
}

async function defaultCreateSession(options: CreateAgentSessionOptions): Promise<AgentSession> {
	const sdk = await loadPiMonoSdk();
	const result = await sdk.createAgentSession(options);
	return result.session;
}

function createToolsForSet(cwd: string, toolSet: readonly string[], sdk: PiMonoSdk): PiMonoTool[] {
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

function defaultToolSet(): readonly string[] {
	return ["read", "bash", "edit", "write"];
}

function getToolCallId(rawEvent: RawUpstreamEvent): string | undefined {
	return typeof rawEvent.payload?.toolCallId === "string" ? rawEvent.payload.toolCallId : undefined;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

function extractTargetPath(parameters: Readonly<Record<string, unknown>> | undefined): string | undefined {
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

class AsyncPushQueue<T> {
	private readonly items: T[] = [];
	private readonly waiters = new Set<(value: T | null) => void>();
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		const waiter = this.waiters.values().next().value as ((value: T | null) => void) | undefined;
		if (waiter) {
			this.waiters.delete(waiter);
			waiter(value);
			return;
		}
		this.items.push(value);
	}

	next(): Promise<T | null> {
		if (this.items.length > 0) {
			return Promise.resolve(this.items.shift() ?? null);
		}
		if (this.closed) {
			return Promise.resolve(null);
		}
		return new Promise<T | null>((resolve) => {
			this.waiters.add(resolve);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters) {
			waiter(null);
		}
		this.waiters.clear();
	}
}
