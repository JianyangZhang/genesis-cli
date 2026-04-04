import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { streamAnthropicMessages } from "./providers/anthropic.js";
import { streamOpenAiCompletions } from "./providers/openai.js";
import { SessionManager } from "./session-manager.js";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type KernelTool,
} from "./tools.js";

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
	abort(): Promise<void>;
	dispose(): void;
}

export interface CreateAgentSessionResult {
	readonly session: GenesisAgentSession;
}

class GenesisAgentSessionImpl implements GenesisAgentSession {
	constructor(
		private readonly agent: Agent,
		private readonly sessionManager: SessionManager,
	) {}

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
		return this.agent.subscribe((event) => {
			listener(event);
		});
	}

	async prompt(input: string): Promise<void> {
		await this.agent.prompt(input);
	}

	async followUp(input: string): Promise<void> {
		this.agent.followUp({
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: Date.now(),
		});
		await this.agent.waitForIdle();
	}

	async abort(): Promise<void> {
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	dispose(): void {
		this.agent.reset();
	}
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const authStorage = options.authStorage ?? AuthStorage.create(options.agentDir ? join(options.agentDir, "auth.json") : undefined);
	const modelRegistry =
		options.modelRegistry ?? ModelRegistry.create(authStorage, options.agentDir ? join(options.agentDir, "models.json") : undefined);
	const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd);
	const model = options.model ?? modelRegistry.list()[0];

	if (!model) {
		throw new Error("No model configured for the Genesis kernel session.");
	}

	const tools = options.tools?.length ? [...options.tools] : createDefaultTools(options.cwd);
	const toolDescriptions = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
	const agent = new Agent({
		initialState: {
			systemPrompt: buildSystemPrompt(options.cwd, toolDescriptions),
			model,
			thinkingLevel: options.thinkingLevel ?? (model.reasoning ? "minimal" : "off"),
			tools,
		},
		streamFn: async (activeModel, context, streamOptions) => {
			const auth = modelRegistry.getRequestAuth(activeModel);
			if (!auth.ok) {
				throw new Error(auth.error);
			}

			const mergedOptions = {
				...streamOptions,
				apiKey: auth.apiKey,
				headers: auth.headers ? { ...(auth.headers ?? {}), ...(streamOptions?.headers ?? {}) } : streamOptions?.headers,
			};

			if (activeModel.api === "openai-completions") {
				return streamOpenAiCompletions(
					activeModel as Model<"openai-completions">,
					context,
					mergedOptions,
				) as unknown as ReturnType<typeof streamSimple>;
			}

			if (activeModel.api === "anthropic-messages") {
				return streamAnthropicMessages(
					activeModel as Model<"anthropic-messages">,
					context,
					mergedOptions,
				) as unknown as ReturnType<typeof streamSimple>;
			}

			return streamSimple(activeModel, context, mergedOptions);
		},
		sessionId: sessionManager.getSessionId(),
		toolExecution: "parallel",
	});

	return {
		session: new GenesisAgentSessionImpl(agent, sessionManager),
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
