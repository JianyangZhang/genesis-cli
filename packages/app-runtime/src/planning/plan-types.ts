/**
 * Plan domain types.
 *
 * Foundation types for the plan state machine and subagent task orchestration.
 * The plan engine itself is in plan-engine.ts; event factories are in plan-events.ts.
 */

import type { SubagentResult } from "../subagent/result-types.js";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Status of a plan in its lifecycle. */
export type PlanStatus = "draft" | "active" | "completed" | "failed" | "abandoned";

/** The reason a plan reached a terminal state, if applicable. */
export type PlanOutcomeReason =
	| "all_steps_completed"
	| "step_failed"
	| "user_abandoned"
	| "boundary_violation"
	| "stop_condition_triggered"
	| "rework_limit_exceeded";

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/** Status of a single plan step. */
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** A step in a plan — minimal representation for summaries. */
export interface PlanStep {
	readonly stepId: string;
	readonly description: string;
	readonly status: PlanStepStatus;
}

/** Rich plan step with subagent task linkage. */
export interface PlanStepDetail extends PlanStep {
	/** The subagent task this step corresponds to, if dispatched. */
	readonly taskId?: string;
	/** The result returned by the subagent, if completed. */
	readonly result?: SubagentResult;
	/** Number of rework attempts for this step. */
	readonly reworkCount: number;
}

// ---------------------------------------------------------------------------
// Summary (used in SessionState)
// ---------------------------------------------------------------------------

/** Lightweight plan summary for embedding in session state. */
export interface PlanSummary {
	readonly planId: string;
	readonly goal: string;
	readonly status: PlanStatus;
	readonly stepCount: number;
	readonly completedSteps: number;
}
