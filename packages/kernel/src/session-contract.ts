import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@pickle-pee/pi-ai";
import type { GenesisSessionMetadata } from "./session-metadata.js";
import type { KernelTool } from "./tools.js";

/**
 * Stable kernel-facing session contract consumed by upper layers.
 * app-runtime and adapters should rely on this contract instead of
 * implicit assumptions about createAgentSession internals.
 */
export interface KernelSessionContract {
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(input: string): Promise<void>;
	followUp(input: string): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	getSnapshot(): Promise<KernelSessionSnapshot>;
	abort(): Promise<void>;
	dispose(): void;
}

export interface KernelSessionSnapshot {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly metadata: GenesisSessionMetadata | null;
}

export interface KernelCreateSessionOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly model?: Model<any>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly tools?: readonly KernelTool[];
}
