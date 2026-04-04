/**
 * Core type definitions for the UI layer.
 *
 * OutputMode and RenderContext are consumed by all formatters.
 * InteractionState, envelope types, slash command types, and OutputSink
 * are the building blocks for the four CLI modes.
 */

import type { AppRuntime, SessionFacade } from "@genesis-cli/runtime";

// ---------------------------------------------------------------------------
// Output mode — canonical definition shared by all formatters
// ---------------------------------------------------------------------------

/** Determines how events are rendered. Each mode consumes the same runtime events. */
export type OutputMode = "interactive" | "print" | "json" | "rpc";

/** Minimal render context for any output mode. */
export interface RenderContext {
	readonly mode: OutputMode;
}

// ---------------------------------------------------------------------------
// Interaction state machine
// ---------------------------------------------------------------------------

/** The phase of the main interaction loop. */
export type InteractionPhase =
	| "idle"
	| "thinking"
	| "streaming"
	| "tool_executing"
	| "waiting_permission"
	| "compacting";

/** Snapshot of the interaction state visible to renderers. */
export interface InteractionState {
	readonly phase: InteractionPhase;
	readonly activeToolName: string | null;
	readonly activeToolCallId: string | null;
	readonly activePlanStepId: string | null;
	readonly activePlanId: string | null;
}

// ---------------------------------------------------------------------------
// JSON mode envelope
// ---------------------------------------------------------------------------

/**
 * Versioned envelope for JSON mode output.
 *
 * Invariants:
 * - Never contains `jsonrpc` or `id` fields (those belong to RPC mode).
 * - `data` only contains mode-agnostic fields from RuntimeEvent,
 *   never TUI-specific values like InteractionPhase or layout coordinates.
 */
export interface JsonEnvelope {
	readonly event: string;
	readonly category: string;
	readonly timestamp: number;
	readonly sessionId: string;
	readonly data: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// RPC mode envelope (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 envelope for RPC mode. */
export interface RpcEnvelope {
	readonly jsonrpc: "2.0";
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/** Command execution type, following the three-type pattern. */
export type SlashCommandType = "prompt" | "local" | "ui";

/** A registered slash command. */
export interface SlashCommand {
	/** Command name without the leading `/`. */
	readonly name: string;
	readonly description: string;
	readonly type: SlashCommandType;
	execute?(ctx: SlashCommandContext): Promise<SlashCommandResult | undefined>;
}

/** Context passed to slash command execute(). */
export interface SlashCommandContext {
	/** Raw arguments after the command name (e.g. "sonnet" for /model sonnet). */
	readonly args: string;
	readonly runtime: AppRuntime;
	readonly session: SessionFacade;
	readonly output: OutputSink;
}

/** Result from a slash command execution. */
export interface SlashCommandResult {
	/** Text to inject back into the conversation (for prompt-type commands). */
	readonly injectedText?: string;
}

// ---------------------------------------------------------------------------
// Output abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction over output so formatters and commands never directly
 * write to process.stdout. The mode handler provides the concrete sink.
 */
export interface OutputSink {
	write(text: string): void;
	writeLine(text: string): void;
	writeError(text: string): void;
}
