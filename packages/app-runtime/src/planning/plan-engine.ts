/**
 * Plan state machine and lifecycle management.
 *
 * Provides immutable state transitions for plan objects. Every method returns
 * a new Plan instance — the input is never mutated. Invalid transitions throw
 * descriptive errors so that bugs surface early during development.
 *
 * Lifecycle:
 *   draft → active → completed | failed | abandoned
 *   draft → abandoned
 *
 * Step lifecycle:
 *   pending → in_progress → completed | failed
 *   pending → skipped
 *   failed  → in_progress (rework, if under limit)
 */

import type { SubagentResult } from "../subagent/result-types.js";
import type { PlanOutcomeReason, PlanStatus, PlanStepDetail, PlanStepStatus, PlanSummary } from "./plan-types.js";

// ---------------------------------------------------------------------------
// Plan object
// ---------------------------------------------------------------------------

export interface Plan {
	readonly planId: string;
	readonly goal: string;
	readonly status: PlanStatus;
	readonly steps: readonly PlanStepDetail[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly outcomeReason?: PlanOutcomeReason;
	readonly maxReworkAttempts: number;
}

// ---------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------

export interface PlanEngine {
	/** Create a new plan in "draft" status with the given step descriptions. */
	createDraft(planId: string, goal: string, stepDescriptions: readonly string[]): Plan;

	/** Transition plan from "draft" to "active". */
	activate(plan: Plan): Plan;

	/** Start a step: transitions to "in_progress" and links a subagent taskId. */
	startStep(plan: Plan, stepIndex: number, taskId: string): Plan;

	/** Complete a step successfully with the subagent result. */
	completeStep(plan: Plan, stepIndex: number, result: SubagentResult): Plan;

	/** Fail a step with the subagent result. */
	failStep(plan: Plan, stepIndex: number, result: SubagentResult): Plan;

	/** Skip a pending step. */
	skipStep(plan: Plan, stepIndex: number): Plan;

	/** Abandon the plan with a reason. */
	abandon(plan: Plan, reason: PlanOutcomeReason): Plan;

	/** Derive a lightweight PlanSummary from the current plan state. */
	summarize(plan: Plan): PlanSummary;

	/** Get the index of the next pending step, or null if none. */
	nextPendingStep(plan: Plan): number | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlanEngine(maxReworkAttempts = 2): PlanEngine {
	function assertStatus(plan: Plan, ...expected: PlanStatus[]): void {
		if (!expected.includes(plan.status)) {
			throw new Error(`Plan "${plan.planId}" is ${plan.status}, expected ${expected.join(" or ")}`);
		}
	}

	function assertStepStatus(step: PlanStepDetail, index: number, ...expected: PlanStepStatus[]): void {
		if (!expected.includes(step.status)) {
			throw new Error(`Step ${index} ("${step.stepId}") is ${step.status}, expected ${expected.join(" or ")}`);
		}
	}

	function assertIndex(plan: Plan, stepIndex: number): void {
		if (stepIndex < 0 || stepIndex >= plan.steps.length) {
			throw new Error(`Step index ${stepIndex} out of range [0, ${plan.steps.length})`);
		}
	}

	function updateSteps(plan: Plan, stepIndex: number, patcher: (step: PlanStepDetail) => PlanStepDetail): Plan {
		const steps = plan.steps.map((s, i) => (i === stepIndex ? patcher(s) : s));
		return { ...plan, steps, updatedAt: Date.now() };
	}

	function isTerminal(plan: Plan): boolean {
		return plan.status === "completed" || plan.status === "failed" || plan.status === "abandoned";
	}

	function checkAutoComplete(plan: Plan): Plan {
		const allDone = plan.steps.every((s) => s.status === "completed" || s.status === "skipped");
		if (allDone) {
			return {
				...plan,
				status: "completed",
				outcomeReason: "all_steps_completed",
				updatedAt: Date.now(),
			};
		}
		return plan;
	}

	return {
		createDraft(planId: string, goal: string, stepDescriptions: readonly string[]): Plan {
			if (!stepDescriptions || stepDescriptions.length === 0) {
				throw new Error("Plan must have at least one step");
			}

			const now = Date.now();
			const steps: PlanStepDetail[] = stepDescriptions.map((desc, i) => ({
				stepId: `${planId}-step-${i + 1}`,
				description: desc,
				status: "pending" as const,
				reworkCount: 0,
			}));

			return {
				planId,
				goal,
				status: "draft",
				steps,
				createdAt: now,
				updatedAt: now,
				maxReworkAttempts,
			};
		},

		activate(plan: Plan): Plan {
			assertStatus(plan, "draft");
			return { ...plan, status: "active", updatedAt: Date.now() };
		},

		startStep(plan: Plan, stepIndex: number, taskId: string): Plan {
			assertStatus(plan, "active");
			assertIndex(plan, stepIndex);
			assertStepStatus(plan.steps[stepIndex], stepIndex, "pending", "failed");

			const step = plan.steps[stepIndex];
			// If reworking a failed step, increment rework count
			const reworkCount = step.status === "failed" ? step.reworkCount + 1 : step.reworkCount;

			if (step.status === "failed" && reworkCount > plan.maxReworkAttempts) {
				throw new Error(
					`Step ${stepIndex} ("${step.stepId}") has exceeded max rework attempts (${plan.maxReworkAttempts})`,
				);
			}

			return updateSteps(plan, stepIndex, (s) => ({
				...s,
				status: "in_progress",
				taskId,
				reworkCount,
				result: undefined,
			}));
		},

		completeStep(plan: Plan, stepIndex: number, result: SubagentResult): Plan {
			assertStatus(plan, "active");
			assertIndex(plan, stepIndex);
			assertStepStatus(plan.steps[stepIndex], stepIndex, "in_progress");

			if (result.status !== "completed") {
				throw new Error(
					`completeStep requires result.status "completed", got "${result.status}". Use failStep for non-completed results.`,
				);
			}

			const updated = updateSteps(plan, stepIndex, (s) => ({
				...s,
				status: "completed" as const,
				result,
			}));

			return checkAutoComplete(updated);
		},

		failStep(plan: Plan, stepIndex: number, result: SubagentResult): Plan {
			assertStatus(plan, "active");
			assertIndex(plan, stepIndex);
			assertStepStatus(plan.steps[stepIndex], stepIndex, "in_progress");

			const updated = updateSteps(plan, stepIndex, (s) => ({
				...s,
				status: "failed" as const,
				result,
			}));

			// If this step has exhausted rework attempts, fail the whole plan
			const step = updated.steps[stepIndex];
			if (step.reworkCount >= plan.maxReworkAttempts) {
				return {
					...updated,
					status: "failed",
					outcomeReason: "rework_limit_exceeded",
					updatedAt: Date.now(),
				};
			}

			return updated;
		},

		skipStep(plan: Plan, stepIndex: number): Plan {
			assertStatus(plan, "active");
			assertIndex(plan, stepIndex);
			assertStepStatus(plan.steps[stepIndex], stepIndex, "pending");

			const updated = updateSteps(plan, stepIndex, (s) => ({
				...s,
				status: "skipped" as const,
			}));

			return checkAutoComplete(updated);
		},

		abandon(plan: Plan, reason: PlanOutcomeReason): Plan {
			if (isTerminal(plan)) {
				throw new Error(`Plan "${plan.planId}" is already ${plan.status} and cannot be abandoned`);
			}
			return {
				...plan,
				status: "abandoned",
				outcomeReason: reason,
				updatedAt: Date.now(),
			};
		},

		summarize(plan: Plan): PlanSummary {
			const completedSteps = plan.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;

			return {
				planId: plan.planId,
				goal: plan.goal,
				status: plan.status,
				stepCount: plan.steps.length,
				completedSteps,
			};
		},

		nextPendingStep(plan: Plan): number | null {
			const index = plan.steps.findIndex((s) => s.status === "pending");
			return index === -1 ? null : index;
		},
	};
}
