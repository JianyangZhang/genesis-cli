/**
 * Subagent result and aggregation types.
 *
 * Defines the structured schema for results delivered by subagents,
 * rework decisions made by the reviewer, and aggregation of multi-task outcomes.
 */

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Status of a completed subagent task. */
export type SubagentResultStatus = "completed" | "failed" | "boundary_violation" | "stop_condition_triggered";

/** Result of a single verification check. */
export interface VerificationResult {
	readonly name: string;
	readonly status: "passed" | "failed" | "error" | "skipped";
	readonly output?: string;
	readonly durationMs?: number;
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

/** A risk identified by the subagent or reviewer. */
export interface TaskRisk {
	readonly severity: "low" | "medium" | "high";
	readonly description: string;
	readonly affectedPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Subagent result
// ---------------------------------------------------------------------------

/** The structured result delivered by a subagent upon task completion. */
export interface SubagentResult {
	readonly taskId: string;
	readonly status: SubagentResultStatus;
	readonly modifiedPaths: readonly string[];
	readonly verifications: readonly VerificationResult[];
	readonly risks: readonly TaskRisk[];
	readonly handoffNotes: readonly string[];
	readonly completedAt: number;
}

// ---------------------------------------------------------------------------
// Rework decision
// ---------------------------------------------------------------------------

/** The rework decision made by the reviewer / main agent. */
export type ReworkDecision =
	| { readonly type: "accept" }
	| { readonly type: "rework"; readonly reason: string; readonly focusAreas: readonly string[] }
	| { readonly type: "abandon"; readonly reason: string };

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** The overall aggregation of multiple subagent task results. */
export interface AggregationResult {
	readonly planId: string;
	readonly totalTasks: number;
	readonly completedTasks: number;
	readonly failedTasks: number;
	readonly tasksRequiringRework: number;
	readonly allModifiedPaths: readonly string[];
	readonly allRisks: readonly TaskRisk[];
	readonly reworkDecisions: ReadonlyMap<string, ReworkDecision>;
	readonly completedAt: number;
}
