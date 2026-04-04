/**
 * Smoke test scenario descriptor.
 */
export interface SmokeScenario {
	readonly id: string;
	readonly description: string;
	readonly phases: readonly string[];
}

/**
 * Verification result for a single check.
 */
export interface VerificationResult {
	readonly scenarioId: string;
	readonly passed: boolean;
	readonly message: string;
}

/**
 * Subagent delivery acceptance criteria.
 */
export interface AcceptanceCriteria {
	readonly taskId: string;
	readonly checks: readonly string[];
}
