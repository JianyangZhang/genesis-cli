/**
 * Adapter interface for bridging to pi-mono's AgentSession.
 *
 * Since pi-mono is not installed as a dependency yet, this file defines the
 * contract that the real adapter will implement when integration begins.
 * For P2, StubKernelSessionAdapter (in test/) provides a test double.
 */

import type { SessionRecoveryData } from "../types/index.js";

// ---------------------------------------------------------------------------
// Raw upstream event — a generic envelope from pi-mono
// ---------------------------------------------------------------------------

/**
 * Minimal representation of an event emitted by the upstream kernel.
 *
 * The EventNormalizer interprets these and maps them to product-layer
 * RuntimeEvent instances. Unrecognized events are silently dropped.
 */
export interface RawUpstreamEvent {
	readonly type: string;
	readonly timestamp: number;
	readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionGateContext {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}

export type ToolExecutionGateDecision =
	| { readonly type: "allow" }
	| { readonly type: "deny"; readonly reason: string; readonly riskLevel: string }
	| { readonly type: "ask_user"; readonly reason: string; readonly riskLevel: string };

export interface ToolExecutionGate {
	beforeToolExecution(context: ToolExecutionGateContext): ToolExecutionGateDecision;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Bridge between the product layer and the upstream pi-coding-agent session.
 *
 * When pi-mono is integrated, a PiMonoSessionAdapter class will implement
 * this interface by wrapping AgentSession. Only the adapter and normalizer
 * need updating — nothing else in app-runtime changes.
 */
export interface KernelSessionAdapter {
	/**
	 * Optional pre-execution governance hook.
	 *
	 * Adapters that support real tool interception should call this before
	 * dispatching a tool to the upstream executor.
	 */
	setToolExecutionGate?(gate: ToolExecutionGate): void;

	/** Send a user prompt and receive raw upstream events as a stream. */
	sendPrompt(input: string): AsyncIterable<RawUpstreamEvent>;

	/** Continue an existing conversation turn. */
	sendContinue(input: string): AsyncIterable<RawUpstreamEvent>;

	/**
	 * Optional permission-resolution callback for adapters that can suspend a
	 * tool until the product layer collects a user decision.
	 */
	resolveToolPermission?(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
	): void | Promise<void>;

	/** Abort the current streaming response. */
	abort(): void;

	/** Close the underlying session and release resources. */
	close(): Promise<void>;

	/** Extract serializable recovery data from the current session state. */
	getRecoveryData(): SessionRecoveryData;

	/** Resume a previously serialized session. Called before any prompt/continue. */
	resume(data: SessionRecoveryData): void;
}
