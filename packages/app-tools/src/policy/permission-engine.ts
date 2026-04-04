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
 *
 * Cache key is a 4-tuple: toolName:riskLevel:normalizedTargetPath:commandDigest.
 * For L2+, only an exact match on all four components grants auto-allow.
 * This prevents cross-risk-level escalation and cross-command wildcard approval.
 */

import { normalize as nodeNormalize } from "node:path";
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
	const approvals = new Map<string, ApprovalCacheEntry>();

	function cacheKey(
		sessionId: string,
		toolName: string,
		riskLevel: RiskLevel,
		targetPath: string | undefined,
		commandDigest: string | undefined,
	): string {
		const normalizedTarget = targetPath ? nodeNormalize(targetPath) : "*";
		const digest = commandDigest ?? "*";
		return `${sessionId}:${toolName}:${riskLevel}:${normalizedTarget}:${digest}`;
	}

	return {
		evaluate(context: PermissionContext): PermissionDecision {
			const { sessionId, toolPolicy, toolIdentity, isSubAgent, targetPath, commandDigest, workingDirectory } =
				context;
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

			// --- Check session approval cache (exact match only for L2+) ---
			const key = cacheKey(sessionId, toolIdentity.name, riskLevel, targetPath, commandDigest);
			const cached = approvals.get(key);
			if (cached) {
				return { verdict: "allow", riskLevel, reason: "Session-approved" };
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
			const outsideCwd = targetPath && workingDirectory && !nodeNormalize(targetPath).startsWith(workingDirectory);

			return {
				verdict: "ask_user",
				riskLevel,
				reason: outsideCwd
					? `Tool "${toolIdentity.name}" targets path outside working directory`
					: `Tool "${toolIdentity.name}" requires confirmation (risk level ${riskLevel})`,
			};
		},

		recordApproval(entry: ApprovalCacheEntry): void {
			const key = cacheKey(
				entry.sessionId,
				entry.toolName,
				entry.riskLevel,
				entry.targetPattern,
				entry.commandDigest,
			);
			approvals.set(key, entry);
		},

		clearApprovals(): void {
			approvals.clear();
		},
	};
}
