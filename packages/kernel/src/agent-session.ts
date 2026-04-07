import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentMessage, type StreamFn, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, Model, UserMessage } from "@pickle-pee/pi-ai";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { streamWithKernelProvider } from "./provider-registry.js";
import { SessionManager } from "./session-manager.js";
import {
	type GenesisSessionMetadata,
	loadSessionMessagesFromSessionFile,
	loadSessionMetadataFromSessionFile,
} from "./session-metadata.js";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type KernelTool } from "./tools.js";

export interface CreateAgentSessionOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly model?: Model<any>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly tools?: readonly KernelTool[];
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	readonly sessionManager?: SessionManager;
}

export interface GenesisAgentSession {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(input: string): Promise<void>;
	followUp(input: string): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	getSnapshot(): Promise<GenesisSessionSnapshot>;
	abort(): Promise<void>;
	dispose(): void;
}

export interface GenesisSessionSnapshot {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly metadata: GenesisSessionMetadata | null;
}

export interface CreateAgentSessionResult {
	readonly session: GenesisAgentSession;
}

class GenesisAgentSessionImpl implements GenesisAgentSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	private persistedMessageCount: number;

	constructor(
		private readonly agent: Agent,
		private readonly sessionManager: SessionManager,
		private readonly modelRegistry: ModelRegistry,
		initialMessageCount = 0,
	) {
		this.persistedMessageCount = initialMessageCount;
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		const unsubscribeAgent = this.agent.subscribe((event) => {
			listener(event);
		});
		return () => {
			this.listeners.delete(listener);
			unsubscribeAgent();
		};
	}

	async prompt(input: string): Promise<void> {
		await this.agent.prompt(input);
		await this.persistNewMessages();
	}

	async followUp(input: string): Promise<void> {
		this.agent.followUp({
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: Date.now(),
		});
		await this.agent.waitForIdle();
		await this.persistNewMessages();
	}

	async compact(customInstructions?: string): Promise<void> {
		const tokensBefore = estimateMessageTokens(this.agent.state.messages);
		if (countCompactableMessages(this.agent.state.messages) < 2) {
			throw new Error("Nothing to compact (session too small)");
		}

		this.emit({
			type: "compaction_start",
			reason: "manual",
		});

		try {
			await this.agent.waitForIdle();
			const summary = await this.generateCompactionSummary(customInstructions);
			this.agent.state.messages = createCompactedContextMessage(summary);
			this.persistedMessageCount = 0;
			await this.appendSessionEntry({ type: "compaction", summary });
			await this.persistNewMessages();
			this.emit({
				type: "compaction_end",
				reason: "manual",
				aborted: false,
				willRetry: false,
				result: {
					summary,
					tokensBefore,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit({
				type: "compaction_end",
				reason: "manual",
				aborted: false,
				willRetry: false,
				result: undefined,
				errorMessage: `Compaction failed: ${message}`,
			});
			throw error;
		}
	}

	private loadMetadata(): Promise<GenesisSessionMetadata | null> {
		return loadSessionMetadataFromSessionFile(this.sessionFile);
	}

	async getSnapshot(): Promise<GenesisSessionSnapshot> {
		return {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			metadata: await this.loadMetadata(),
		};
	}

	async abort(): Promise<void> {
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	dispose(): void {
		this.agent.reset();
	}

	private emit(event: unknown): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private async persistNewMessages(): Promise<void> {
		const pending = this.agent.state.messages.slice(this.persistedMessageCount);
		if (pending.length === 0) {
			return;
		}
		for (const message of pending) {
			const serialized = serializeSessionMessage(message);
			if (!serialized) {
				continue;
			}
			await this.appendSessionEntry({ type: "message", message: serialized });
		}
		this.persistedMessageCount = this.agent.state.messages.length;
	}

	private async appendSessionEntry(entry: Record<string, unknown>): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) {
			return;
		}
		await appendFile(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
	}

	private async generateCompactionSummary(customInstructions?: string): Promise<string> {
		const model = this.agent.state.model;
		const auth = this.modelRegistry.getRequestAuth(model);
		if (!auth.ok) {
			throw new Error(auth.error);
		}

		const context = {
			systemPrompt:
				"You are compacting a coding session. Produce a concise continuation summary that preserves goals, current state, files touched, commands run, errors, decisions, and next steps.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildCompactionPrompt(this.agent.state.messages, customInstructions),
						},
					],
					timestamp: Date.now(),
				} satisfies UserMessage,
			],
		};

		const result = await streamWithKernelProvider(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		}).result();
		const summary = extractAssistantText(result);
		if (!summary) {
			throw new Error(result.errorMessage || "Compaction summary was empty");
		}
		return summary;
	}
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const authStorage =
		options.authStorage ?? AuthStorage.create(options.agentDir ? join(options.agentDir, "auth.json") : undefined);
	const modelRegistry =
		options.modelRegistry ??
		ModelRegistry.create(authStorage, options.agentDir ? join(options.agentDir, "models.json") : undefined);
	const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd);
	const model = options.model ?? modelRegistry.list()[0];

	if (!model) {
		throw new Error("No model configured for the Genesis kernel session.");
	}

	const tools = options.tools?.length ? [...options.tools] : createDefaultTools(options.cwd);
	const toolDescriptions = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
	const recoveredMessages = await loadSessionMessagesFromSessionFile(sessionManager.getSessionFile(), model);
	const streamFn: StreamFn = async (activeModel, context, streamOptions) => {
		const auth = modelRegistry.getRequestAuth(activeModel);
		if (!auth.ok) {
			throw new Error(auth.error);
		}

		const mergedOptions = {
			...streamOptions,
			apiKey: auth.apiKey,
			headers: auth.headers
				? { ...(auth.headers ?? {}), ...(streamOptions?.headers ?? {}) }
				: streamOptions?.headers,
		};
		return streamWithKernelProvider(activeModel, context, mergedOptions) as unknown as Awaited<ReturnType<StreamFn>>;
	};
	const agent = new Agent({
		initialState: {
			systemPrompt: buildSystemPrompt(options.cwd, toolDescriptions),
			messages: recoveredMessages,
			model,
			thinkingLevel: options.thinkingLevel ?? (model.reasoning ? "minimal" : "off"),
			tools,
		},
		streamFn,
		sessionId: sessionManager.getSessionId(),
		toolExecution: "parallel",
	});

	return {
		session: new GenesisAgentSessionImpl(agent, sessionManager, modelRegistry, recoveredMessages.length),
	};
}

function createDefaultTools(cwd: string): KernelTool[] {
	return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}

function buildSystemPrompt(cwd: string, toolDescriptions: string): string {
	return [
		"You are Genesis CLI, a coding agent focused on inspecting code, making precise edits, and running local commands.",
		`Working directory: ${cwd}`,
		"Use tools when they reduce guesswork. Read files before editing them, prefer exact edits over full rewrites, and keep user-facing answers concise.",
		"When a task requires filesystem or shell interaction, prefer the provided tools instead of describing hypothetical commands.",
		"Available tools:",
		toolDescriptions,
	].join("\n\n");
}

function buildCompactionPrompt(messages: readonly AgentMessage[], customInstructions?: string): string {
	const transcript = serializeTranscriptForCompaction(messages, 60_000);
	const customBlock =
		customInstructions && customInstructions.trim().length > 0
			? `\n\nAdditional instructions:\n${customInstructions.trim()}`
			: "";
	return [
		"Summarize this coding conversation so a coding agent can continue seamlessly after context compaction.",
		"Focus on current objective, repository state, files touched, decisions, commands/results, errors, unresolved questions, and the next best step.",
		"Use short bullets. Preserve exact literals only when they matter.",
		customBlock,
		"",
		"Transcript:",
		transcript,
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

function serializeTranscriptForCompaction(messages: readonly AgentMessage[], maxChars: number): string {
	const lines = messages
		.map((message) => formatAgentMessage(message))
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
	if (lines.length <= maxChars) {
		return lines;
	}
	const head = lines.slice(0, 12_000);
	const tail = lines.slice(-(maxChars - 12_000));
	return `${head}\n\n[Earlier transcript truncated for compaction]\n\n${tail}`;
}

function formatAgentMessage(message: AgentMessage): string | undefined {
	if (!message || typeof message !== "object" || !("role" in message)) {
		return undefined;
	}
	const role = (message as { role?: unknown }).role;
	if (role === "user" || role === "assistant") {
		const text = extractTextContent((message as Message).content);
		return text ? `${capitalizeRole(role)}:\n${text}` : undefined;
	}
	if (role === "toolResult") {
		const result = message as Extract<Message, { role: "toolResult" }>;
		const text = extractTextContent(result.content);
		return text ? `Tool (${result.toolName ?? result.toolCallId}):\n${text}` : undefined;
	}
	return undefined;
}

function extractTextContent(content: readonly { type: string }[]): string | undefined {
	const text = content
		.flatMap((part) => {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				return [part.text.trim()];
			}
			if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
				return [part.thinking.trim()];
			}
			return [];
		})
		.filter((part) => part.length > 0)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

function extractAssistantText(message: AssistantMessage): string | undefined {
	return extractTextContent(message.content as readonly { type: string }[]);
}

function serializeSessionMessage(message: AgentMessage): { role: "user" | "assistant"; content: string } | null {
	if (!message || typeof message !== "object" || !("role" in message)) {
		return null;
	}
	const role = (message as { role?: unknown }).role;
	if (role !== "user" && role !== "assistant") {
		return null;
	}
	const content = "content" in message ? extractTextContent((message as Message).content) : undefined;
	if (!content) {
		return null;
	}
	return { role, content };
}

function createCompactedContextMessage(summary: string): Message[] {
	return [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"Compacted session summary:",
						summary,
						"Continue from this summary and ask follow-up questions only if critical context is missing.",
					].join("\n\n"),
				},
			],
			timestamp: Date.now(),
		} satisfies UserMessage,
	];
}

function countCompactableMessages(messages: readonly AgentMessage[]): number {
	return messages.filter((message) => formatAgentMessage(message)?.length).length;
}

function estimateMessageTokens(messages: readonly AgentMessage[]): number {
	const text = serializeTranscriptForCompaction(messages, Number.MAX_SAFE_INTEGER);
	return Math.max(1, Math.ceil(text.length / 4));
}

function capitalizeRole(role: string): string {
	return role.slice(0, 1).toUpperCase() + role.slice(1);
}
