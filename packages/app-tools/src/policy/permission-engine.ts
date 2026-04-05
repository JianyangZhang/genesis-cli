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
 * Session approvals are scoped by tool + risk level, then matched against either:
 *   - an exact command digest for command-execution tools, or
 *   - an exact path / directory pattern for filesystem tools.
 * This prevents cross-risk-level escalation while still allowing session-scoped
 * directory approvals for file mutations.
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

			// --- Check session approval cache ---
			const cached = [...approvals.values()].find((entry) =>
				matchesApproval(entry, sessionId, toolIdentity.name, riskLevel, targetPath, commandDigest),
			);
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

function matchesApproval(
	entry: ApprovalCacheEntry,
	sessionId: string,
	toolName: string,
	riskLevel: RiskLevel,
	targetPath: string | undefined,
	commandDigest: string | undefined,
): boolean {
	return (
		entry.sessionId === sessionId &&
		entry.toolName === toolName &&
		entry.riskLevel === riskLevel &&
		matchesTargetPattern(entry.targetPattern, targetPath) &&
		matchesCommandDigest(entry.commandDigest, commandDigest)
	);
}

function matchesTargetPattern(targetPattern: string, targetPath: string | undefined): boolean {
	if (targetPath === undefined) {
		return targetPattern === "*";
	}
	if (targetPattern === "*") {
		return false;
	}
	const normalizedTarget = nodeNormalize(targetPath);
	if (targetPattern.endsWith("/**")) {
		const normalizedPrefix = nodeNormalize(targetPattern.slice(0, -3));
		return normalizedTarget === normalizedPrefix || normalizedTarget.startsWith(`${normalizedPrefix}/`);
	}
	return normalizedTarget === nodeNormalize(targetPattern);
}

function matchesCommandDigest(expected: string | undefined, actual: string | undefined): boolean {
	if (expected === undefined) {
		return actual === undefined;
	}
	return expected === actual;
}
