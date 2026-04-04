/**
 * Task contract validation.
 *
 * Enforces the three mandatory rules from the subagent protocol:
 *   1. No task without allowed_paths can be dispatched
 *   2. No task without verification can be dispatched
 *   3. No task without stop_conditions is considered safe
 *
 * Plus consistency checks: taskId/goal non-empty, no scope overlap.
 */

import { isScopeConsistent } from "./path-scope.js";
import type { PathScope, SubagentTask } from "./task-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a validation check. */
export interface ValidationResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate that a task contract is complete and dispatchable. */
export function validateTask(task: SubagentTask): ValidationResult {
	const errors: string[] = [];

	// Required fields
	if (!task.taskId || task.taskId.trim().length === 0) {
		errors.push("taskId must be non-empty");
	}
	if (!task.goal || task.goal.trim().length === 0) {
		errors.push("goal must be non-empty");
	}

	// Scope
	if (!task.scope.allowedPaths || task.scope.allowedPaths.length === 0) {
		errors.push("scope.allowedPaths must contain at least one path");
	}

	// Protocol rules
	if (!task.verification || task.verification.length === 0) {
		errors.push("verification must contain at least one check — tasks without verification cannot be dispatched");
	}
	if (!task.stopConditions || task.stopConditions.length === 0) {
		errors.push("stopConditions must contain at least one condition — tasks without stop conditions are unsafe");
	}

	// Scope consistency
	if (task.scope.allowedPaths.length > 0) {
		const scopeResult = hasConsistentScope(task.scope);
		if (!scopeResult.valid) {
			errors.push(...scopeResult.errors);
		}
	}

	return { valid: errors.length === 0, errors };
}

/** Check that allowedPaths and forbiddenPaths do not overlap. */
export function hasConsistentScope(scope: PathScope): ValidationResult {
	if (!isScopeConsistent(scope)) {
		return {
			valid: false,
			errors: ["scope.allowedPaths and scope.forbiddenPaths must not overlap"],
		};
	}
	return VALID;
}

/** Check required fields only (no scope consistency check). */
export function hasRequiredFields(task: SubagentTask): ValidationResult {
	const errors: string[] = [];
	if (!task.taskId || task.taskId.trim().length === 0) errors.push("taskId");
	if (!task.goal || task.goal.trim().length === 0) errors.push("goal");
	if (!task.scope.allowedPaths || task.scope.allowedPaths.length === 0) errors.push("allowedPaths");
	if (!task.verification || task.verification.length === 0) errors.push("verification");
	if (!task.stopConditions || task.stopConditions.length === 0) errors.push("stopConditions");

	return errors.length === 0 ? VALID : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const VALID: ValidationResult = Object.freeze({ valid: true, errors: [] });
