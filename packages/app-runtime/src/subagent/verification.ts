/**
 * Verification evaluation and anti-fake checks.
 *
 * Evaluates verification results against the specification and ensures
 * subagents cannot fake successful verification output.
 */

import type { VerificationResult } from "./result-types.js";
import type { Verification } from "./task-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of evaluating a set of verifications. */
export interface VerificationEvaluation {
	readonly allPassed: boolean;
	readonly failedNames: readonly string[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Evaluate verification results against their specifications. */
export function evaluateVerifications(
	specs: readonly Verification[],
	results: readonly VerificationResult[],
): VerificationEvaluation {
	const failedNames: string[] = [];

	for (const spec of specs) {
		const result = results.find((r) => r.name === spec.name);
		if (!result) {
			failedNames.push(spec.name);
			continue;
		}

		if (result.status !== "passed") {
			failedNames.push(spec.name);
			continue;
		}

		// Anti-fake: command-type verification must have non-empty output
		if (spec.type === "command" && spec.command) {
			if (!isVerificationTrustworthy(spec, result)) {
				failedNames.push(spec.name);
			}
		}
	}

	return {
		allPassed: failedNames.length === 0,
		failedNames,
	};
}

/**
 * Check if a verification result is trustworthy.
 *
 * A command-type verification that reports "passed" with empty output
 * is considered untrustworthy — the subagent may have skipped execution.
 */
export function isVerificationTrustworthy(spec: Verification, result: VerificationResult): boolean {
	if (result.status !== "passed") {
		return false;
	}

	// Command-type verifications must produce output
	if (spec.type === "command" && spec.command) {
		return typeof result.output === "string" && result.output.trim().length > 0;
	}

	return true;
}
