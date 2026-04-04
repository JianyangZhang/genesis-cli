/**
 * Stop condition evaluation.
 *
 * Tracks runtime state for a subagent and evaluates whether any stop condition
 * has been triggered. All state updates are immutable.
 */

import type { StopCondition } from "./task-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime tracking state for evaluating stop conditions. */
export interface SubagentRuntimeState {
	readonly modifiedPaths: readonly string[];
	readonly elapsedMs: number;
	readonly errorCount: number;
	readonly boundaryViolations: number;
}

/** Result of evaluating stop conditions against current state. */
export interface StopConditionEvaluation {
	readonly triggered: boolean;
	readonly triggeredCondition?: StopCondition;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an initial runtime state with zero values. */
export function createInitialRuntimeState(): SubagentRuntimeState {
	return { modifiedPaths: [], elapsedMs: 0, errorCount: 0, boundaryViolations: 0 };
}

// ---------------------------------------------------------------------------
// State updaters — return new instances
// ---------------------------------------------------------------------------

/** Record a file modification immutably. */
export function recordModification(state: SubagentRuntimeState, path: string): SubagentRuntimeState {
	return { ...state, modifiedPaths: [...state.modifiedPaths, path] };
}

/** Record an error immutably. */
export function recordError(state: SubagentRuntimeState): SubagentRuntimeState {
	return { ...state, errorCount: state.errorCount + 1 };
}

/** Record a boundary violation immutably. */
export function recordBoundaryViolation(state: SubagentRuntimeState): SubagentRuntimeState {
	return { ...state, boundaryViolations: state.boundaryViolations + 1 };
}

/** Update elapsed time immutably. */
export function updateElapsedTime(state: SubagentRuntimeState, elapsedMs: number): SubagentRuntimeState {
	return { ...state, elapsedMs };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether any stop condition has been triggered.
 * Returns on the first triggered condition (first-match semantics).
 */
export function evaluateStopConditions(
	conditions: readonly StopCondition[],
	state: SubagentRuntimeState,
): StopConditionEvaluation {
	for (const condition of conditions) {
		if (isTriggered(condition, state)) {
			return { triggered: true, triggeredCondition: condition };
		}
	}
	return NOT_TRIGGERED;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function isTriggered(condition: StopCondition, state: SubagentRuntimeState): boolean {
	switch (condition.type) {
		case "boundary_violation":
			return state.boundaryViolations > 0;
		case "max_duration_ms":
			return typeof condition.value === "number" && state.elapsedMs >= condition.value;
		case "max_file_count":
		case "max_mutations":
			return typeof condition.value === "number" && state.modifiedPaths.length >= condition.value;
		case "error_threshold":
			return typeof condition.value === "number" && state.errorCount >= condition.value;
		case "custom":
			// Reserved for P5+ — custom conditions require runtime hooks not yet available
			return false;
	}
}

const NOT_TRIGGERED: StopConditionEvaluation = Object.freeze({ triggered: false });
