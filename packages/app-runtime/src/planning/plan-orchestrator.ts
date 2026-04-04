/**
 * Plan orchestration runtime integration.
 *
 * Connects the plan engine, path scope checking, stop condition evaluation,
 * and result aggregation into a single service that enforces all P4 safety
 * guarantees. This is the runtime integration point — external callers
 * (CLI commands, plan execution drivers) interact with plans through this.
 *
 * Safety guarantees enforced by submitResult():
 *   1. Boundary check: modifiedPaths are validated against the assigned task's scope
 *   2. Stop condition check: runtime state is evaluated against stop conditions
 *   3. Both checks cause auto-fail before completeStep is called
 *   4. Rework decisions are made automatically for failed steps
 */

import type { EventBus } from "../events/event-bus.js";
import { decideRework } from "../subagent/aggregation.js";
import { wouldViolateBoundary } from "../subagent/path-scope.js";
import type { SubagentResult } from "../subagent/result-types.js";
import { createInitialRuntimeState, evaluateStopConditions, recordModification } from "../subagent/stop-condition.js";
import type { SubagentTask } from "../subagent/task-types.js";
import { validateTask } from "../subagent/task-validator.js";
import type { SessionId } from "../types/index.js";
import type { Plan, PlanEngine } from "./plan-engine.js";
import {
	planCompleted,
	planCreated,
	planRework,
	planStepCompleted,
	planStepFailed,
	planStepStarted,
} from "./plan-events.js";
import type { PlanSummary } from "./plan-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface PlanOrchestrator {
	/** Underlying plan engine. */
	readonly engine: PlanEngine;

	/** Current active plan, or null if no plan has been created yet. */
	readonly activePlan: Plan | null;

	/**
	 * Create a draft plan and immediately activate it.
	 * Emits `plan_created` to both event buses.
	 */
	createAndActivate(planId: string, goal: string, steps: string[]): Plan;

	/**
	 * Assign a SubagentTask to a step, validate it, and start the step.
	 * Emits `plan_step_started` to both event buses.
	 */
	assignTask(stepIndex: number, task: SubagentTask): Plan;

	/**
	 * Submit a result for a step. This is the main safety gate:
	 *
	 * 1. If result.status === "completed":
	 *    a. Check boundary violations on modifiedPaths
	 *    b. Evaluate stop conditions
	 *    c. If violations or stop conditions → auto-fail (never calls completeStep)
	 *    d. Otherwise → complete step
	 * 2. If result.status !== "completed" → fail step
	 * 3. For failures: decideRework, emit plan_rework if scheduled
	 * 4. If plan auto-completes: emit plan_completed
	 */
	submitResult(stepIndex: number, result: SubagentResult): Plan;

	/** Skip a pending step. */
	skipStep(stepIndex: number): Plan;

	/** Abandon the plan. Emits `plan_completed` with success=false. */
	abandonPlan(reason: string): Plan;

	/** Get current plan summary, or null if no active plan. */
	summarize(): PlanSummary | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlanOrchestrator(
	engine: PlanEngine,
	sessionBus: EventBus,
	globalBus: EventBus,
	sessionId: SessionId,
): PlanOrchestrator {
	let activePlan: Plan | null = null;
	const assignedTasks = new Map<number, SubagentTask>();
	const runtimeStates = new Map<number, ReturnType<typeof createInitialRuntimeState>>();

	function emit(event: Parameters<EventBus["emit"]>[0]): void {
		sessionBus.emit(event);
		globalBus.emit(event);
	}

	function handleStepFailure(
		plan: Plan,
		stepIndex: number,
		reason: string,
		result: SubagentResult,
		task: SubagentTask,
	): Plan {
		const step = plan.steps[stepIndex];
		const failed = engine.failStep(plan, stepIndex, result);

		emit(planStepFailed(sessionId, plan.planId, step.stepId, reason, false));

		// Decide rework
		const decision = decideRework(task, result, plan.maxReworkAttempts, step.reworkCount);
		if (decision.type === "rework") {
			emit(planRework(sessionId, plan.planId, step.stepId, step.reworkCount + 1, decision.focusAreas));
		}

		// If plan failed entirely, emit plan_completed
		if (failed.status === "failed") {
			emit(planCompleted(sessionId, failed.planId, failed.goal, false, engine.summarize(failed)));
		}

		activePlan = failed;
		return failed;
	}

	return {
		get engine() {
			return engine;
		},

		get activePlan() {
			return activePlan;
		},

		createAndActivate(planId: string, goal: string, steps: string[]): Plan {
			const draft = engine.createDraft(planId, goal, steps);
			activePlan = engine.activate(draft);

			emit(planCreated(sessionId, planId, goal, steps.length));

			return activePlan;
		},

		assignTask(stepIndex: number, task: SubagentTask): Plan {
			if (!activePlan || activePlan.status !== "active") {
				throw new Error("No active plan to assign task to");
			}

			// Validate the task contract
			const validation = validateTask(task);
			if (!validation.valid) {
				throw new Error(`Invalid task: ${validation.errors.join("; ")}`);
			}

			const step = activePlan.steps[stepIndex];
			if (!step) {
				throw new Error(`Step index ${stepIndex} out of range`);
			}

			// Start the step
			activePlan = engine.startStep(activePlan, stepIndex, task.taskId);

			// Track task and runtime state
			assignedTasks.set(stepIndex, task);
			runtimeStates.set(stepIndex, createInitialRuntimeState());

			emit(planStepStarted(sessionId, activePlan.planId, step.stepId, step.description));

			return activePlan;
		},

		submitResult(stepIndex: number, result: SubagentResult): Plan {
			if (!activePlan || activePlan.status !== "active") {
				throw new Error("No active plan to submit result to");
			}

			const task = assignedTasks.get(stepIndex);
			if (!task) {
				throw new Error(`No task assigned to step ${stepIndex}. Call assignTask first.`);
			}

			const step = activePlan.steps[stepIndex];
			if (step.status !== "in_progress") {
				throw new Error(`Step ${stepIndex} is ${step.status}, expected in_progress`);
			}

			// --- Safety Gate ---

			if (result.status === "completed") {
				// 1. Boundary check
				const boundaryViolations = result.modifiedPaths.filter((p) => wouldViolateBoundary(task.scope, p));

				if (boundaryViolations.length > 0) {
					const violationResult: SubagentResult = {
						...result,
						status: "boundary_violation",
					};
					return handleStepFailure(activePlan, stepIndex, "boundary_violation", violationResult, task);
				}

				// 2. Stop condition check
				let rtState = runtimeStates.get(stepIndex) ?? createInitialRuntimeState();
				for (const p of result.modifiedPaths) {
					rtState = recordModification(rtState, p);
				}
				runtimeStates.set(stepIndex, rtState);

				const stopEval = evaluateStopConditions(task.stopConditions, rtState);
				if (stopEval.triggered) {
					const stopResult: SubagentResult = {
						...result,
						status: "stop_condition_triggered",
					};
					return handleStepFailure(
						activePlan,
						stepIndex,
						`stop_condition: ${stopEval.triggeredCondition?.type ?? "unknown"}`,
						stopResult,
						task,
					);
				}

				// 3. All checks passed — complete the step
				activePlan = engine.completeStep(activePlan, stepIndex, result);
				emit(planStepCompleted(sessionId, activePlan.planId, step.stepId, true));

				// 4. Check plan completion
				if (activePlan.status === "completed") {
					emit(planCompleted(sessionId, activePlan.planId, activePlan.goal, true, engine.summarize(activePlan)));
				}

				return activePlan;
			}

			// Non-completed result → fail
			return handleStepFailure(activePlan, stepIndex, result.status, result, task);
		},

		skipStep(stepIndex: number): Plan {
			if (!activePlan) {
				throw new Error("No active plan");
			}

			activePlan = engine.skipStep(activePlan, stepIndex);

			// Check plan completion after skip
			if (activePlan.status === "completed") {
				emit(planCompleted(sessionId, activePlan.planId, activePlan.goal, true, engine.summarize(activePlan)));
			}

			return activePlan;
		},

		abandonPlan(_reason: string): Plan {
			if (!activePlan) {
				throw new Error("No active plan");
			}

			activePlan = engine.abandon(activePlan, "user_abandoned");

			emit(planCompleted(sessionId, activePlan.planId, activePlan.goal, false, engine.summarize(activePlan)));

			return activePlan;
		},

		summarize(): PlanSummary | null {
			if (!activePlan) return null;
			return engine.summarize(activePlan);
		},
	};
}
