/**
 * Permission decision types for the tool governance system.
 *
 * The permission engine evaluates a PermissionContext and produces a
 * PermissionDecision. The verdict determines whether the tool call
 * proceeds, is blocked, or requires user interaction.
 */

import type { RiskLevel, ToolIdentity } from "./index.js";
import type { ToolPolicy } from "./tool-policy.js";

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The outcome of a permission evaluation.
 *
 * - "allow"             — proceed without asking
 * - "deny"              — blocked, do not execute
 * - "ask_user"          — defer to user for this call
 * - "allow_once"        — user approved for this single call only
 * - "allow_for_session" — user approved for the rest of the session
 */
export type PermissionVerdict = "allow" | "deny" | "ask_user" | "allow_once" | "allow_for_session";

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface PermissionDecision {
	readonly verdict: PermissionVerdict;
	readonly riskLevel: RiskLevel;
	readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Context (inputs to the engine)
// ---------------------------------------------------------------------------

export interface PermissionContext {
	/** The tool being invoked. */
	readonly toolIdentity: ToolIdentity;

	/** The tool's policy. */
	readonly toolPolicy: ToolPolicy;

	/** Target path the tool operates on (file path, URL, etc.). */
	readonly targetPath?: string;

	/** Current working directory. */
	readonly workingDirectory: string;

	/** Session mode (interactive, print, json, rpc). */
	readonly sessionMode: string;

	/** Whether this invocation originates from a sub-agent. */
	readonly isSubAgent: boolean;

	/** Tool call ID for tracing. */
	readonly toolCallId: string;
}

// ---------------------------------------------------------------------------
// Approval cache
// ---------------------------------------------------------------------------

export interface ApprovalCacheEntry {
	readonly toolName: string;
	readonly targetPattern: string;
	readonly verdict: "allow_for_session";
	readonly grantedAt: number;
}
