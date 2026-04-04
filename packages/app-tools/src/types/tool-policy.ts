/**
 * The policy dimension of the four-part tool model.
 *
 * Governs how the permission engine treats a tool: risk level,
 * concurrency constraints, confirmation requirements, and sub-agent access.
 */

import type { RiskLevel } from "./index.js";

// ---------------------------------------------------------------------------
// Confirmation mode
// ---------------------------------------------------------------------------

/**
 * When user confirmation is required before the tool executes.
 *
 * - "never"    — auto-allow (L0 tools, e.g. read, glob)
 * - "always"   — always ask the user (L3-L4 tools)
 * - "on_write" — ask when modifying existing resources (L2 tools)
 */
export type ConfirmationMode = "never" | "always" | "on_write";

// ---------------------------------------------------------------------------
// Concurrency model
// ---------------------------------------------------------------------------

/**
 * How concurrent invocations of the same tool are handled.
 *
 * - "unlimited"  — any number of parallel calls (file-read, search)
 * - "serial"     — calls are queued globally (sub-agent)
 * - "per_target" — calls to the same target (file path) are serialized
 */
export type ConcurrencyModel = "unlimited" | "serial" | "per_target";

// ---------------------------------------------------------------------------
// ToolPolicy
// ---------------------------------------------------------------------------

/**
 * The policy dimension of the four-part tool model.
 */
export interface ToolPolicy {
	/** Risk level assigned to this tool (L0-L4). */
	readonly riskLevel: RiskLevel;

	/** Whether this tool only reads data, never mutates. */
	readonly readOnly: boolean;

	/** How concurrent invocations are handled. */
	readonly concurrency: ConcurrencyModel;

	/** When user confirmation is required. */
	readonly confirmation: ConfirmationMode;

	/** Whether this tool can be invoked by sub-agents. */
	readonly subAgentAllowed: boolean;

	/** Timeout in milliseconds. 0 means no timeout. */
	readonly timeoutMs: number;
}
