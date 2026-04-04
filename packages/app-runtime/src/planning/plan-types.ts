/**
 * Plan domain types.
 *
 * These types define the data model for task planning. The plan execution
 * engine itself is P4 scope — P2 only establishes the types so that
 * SessionState and events can reference them.
 */

export type PlanStatus = "draft" | "active" | "completed" | "failed" | "abandoned";

export interface PlanSummary {
	readonly planId: string;
	readonly goal: string;
	readonly status: PlanStatus;
	readonly stepCount: number;
	readonly completedSteps: number;
}

export interface PlanStep {
	readonly stepId: string;
	readonly description: string;
	readonly status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}
