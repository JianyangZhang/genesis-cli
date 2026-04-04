// subagent/ — Subagent task contract, result delivery, validation, and aggregation.

// Aggregation
export { aggregateResults, decideRework } from "./aggregation.js";
// Path scope
export {
	isPathAllowed,
	isPathForbidden,
	scopesOverlap,
	wouldViolateBoundary,
} from "./path-scope.js";
// Types — result
export type {
	AggregationResult,
	ReworkDecision,
	SubagentResult,
	SubagentResultStatus,
	TaskRisk,
	VerificationResult,
} from "./result-types.js";
// Stop conditions
export type { StopConditionEvaluation, SubagentRuntimeState } from "./stop-condition.js";
export {
	createInitialRuntimeState,
	evaluateStopConditions,
	recordBoundaryViolation,
	recordError,
	recordModification,
	updateElapsedTime,
} from "./stop-condition.js";
// Types — task
export type {
	PathScope,
	StopCondition,
	StopConditionType,
	SubagentTask,
	TaskInputs,
	Verification,
	VerificationType,
} from "./task-types.js";
// Validation
export type { ValidationResult } from "./task-validator.js";
export { hasConsistentScope, hasRequiredFields, validateTask } from "./task-validator.js";
// Verification
export type { VerificationEvaluation } from "./verification.js";
export { evaluateVerifications, isVerificationTrustworthy } from "./verification.js";
