/**
 * PermissionEngine — evaluates whether a tool invocation is permitted.
 *
 * The engine is the single authority for permission decisions.
 * It considers:
 *   1. Tool risk level (L0 auto-allow → L4 default-deny)
 *   2. Session-scoped approval cache (prior allow_for_session decisions)
 *   3. Sub-agent access restrictions
 *   4. Target path analysis (writes outside cwd are riskier)
 *
 * The engine does NOT interact with the user — it returns "ask_user"
 * when user input is needed. The runtime layer handles the actual prompt.
 */

import type { ApprovalCacheEntry, PermissionContext, PermissionDecision, RiskLevel } from "../types/index.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PermissionEngine {
	/** Evaluate whether a tool invocation is permitted. */
	evaluate(context: PermissionContext): PermissionDecision;

	/** Record a user approval in the session cache. */
	recordApproval(entry: ApprovalCacheEntry): void;

	/** Clear all session-scoped approvals. */
	clearApprovals(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPermissionEngine(): PermissionEngine {
	/**
	 * Session-scoped approval cache keyed by "toolName:targetPattern".
	 * Once a user approves a pattern for the session, subsequent matches
	 * are auto-allowed.
	 */
	const approvals = new Map<string, ApprovalCacheEntry>();

	function cacheKey(toolName: string, targetPattern: string): string {
		return `${toolName}:${targetPattern}`;
	}

	return {
		evaluate(context: PermissionContext): PermissionDecision {
			const { toolPolicy, toolIdentity, isSubAgent, targetPath, workingDirectory } = context;
			const riskLevel = toolPolicy.riskLevel;

			// --- Sub-agent restriction ---
			if (isSubAgent && !toolPolicy.subAgentAllowed) {
				return {
					verdict: "deny",
					riskLevel,
					reason: `Tool "${toolIdentity.name}" is not allowed for sub-agents`,
				};
			}

			// --- L0: auto-allow ---
			if (riskLevel === "L0") {
				return { verdict: "allow", riskLevel };
			}

			// --- L1: auto-allow with logging ---
			if (riskLevel === "L1") {
				return { verdict: "allow", riskLevel, reason: "Low-risk, logged" };
			}

			// --- Check session approval cache ---
			const pattern = targetPath ?? "*";
			const cached = approvals.get(cacheKey(toolIdentity.name, pattern));
			if (cached) {
				return { verdict: "allow", riskLevel, reason: "Session-approved" };
			}

			// Also check wildcard approvals for this tool
			const wildcard = approvals.get(cacheKey(toolIdentity.name, "*"));
			if (wildcard) {
				return { verdict: "allow", riskLevel, reason: "Session-approved (wildcard)" };
			}

			// --- L4: default deny ---
			if (riskLevel === "L4") {
				return {
					verdict: "deny",
					riskLevel,
					reason: "High-risk operation requires explicit session approval",
				};
			}

			// --- L2/L3: ask user ---
			// Target path outside cwd escalates to explicit mention in reason.
			const outsideCwd =
				targetPath && workingDirectory && !targetPath.startsWith(workingDirectory);

			return {
				verdict: "ask_user",
				riskLevel,
				reason: outsideCwd
					? `Tool "${toolIdentity.name}" targets path outside working directory`
					: `Tool "${toolIdentity.name}" requires confirmation (risk level ${riskLevel})`,
			};
		},

		recordApproval(entry: ApprovalCacheEntry): void {
			approvals.set(cacheKey(entry.toolName, entry.targetPattern), entry);
		},

		clearApprovals(): void {
			approvals.clear();
		},
	};
}
