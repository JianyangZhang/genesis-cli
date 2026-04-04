/**
 * Main agent result aggregation and rework decision logic.
 *
 * Collects results from multiple subagent tasks, evaluates verification
 * outcomes, and decides whether each task should be accepted, reworked,
 * or abandoned.
 */

import type { AggregationResult, ReworkDecision, SubagentResult, TaskRisk } from "./result-types.js";
import type { SubagentTask } from "./task-types.js";
import { evaluateVerifications } from "./verification.js";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Aggregate results from multiple completed subagent tasks. */
export function aggregateResults(planId: string, results: readonly SubagentResult[]): AggregationResult {
	const allModifiedPaths: string[] = [];
	const allRisks: TaskRisk[] = [];
	let completedTasks = 0;
	let failedTasks = 0;
	const tasksRequiringRework = 0;
	const reworkDecisions = new Map<string, ReworkDecision>();

	for (const result of results) {
		// Merge paths
		allModifiedPaths.push(...result.modifiedPaths);

		// Merge risks
		allRisks.push(...result.risks);

		// Count by status
		if (result.status === "completed") {
			completedTasks++;
		} else {
			failedTasks++;
		}
	}

	return {
		planId,
		totalTasks: results.length,
		completedTasks,
		failedTasks,
		tasksRequiringRework,
		allModifiedPaths,
		allRisks,
		reworkDecisions,
		completedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Rework decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a task result needs rework, should be accepted, or abandoned.
 *
 * Decision matrix:
 *   completed + all verifications passed         → accept
 *   completed + verification failures + rework    → rework (focus: failed names)
 *   completed + verification failures + no rework → abandon
 *   boundary_violation                            → abandon
 *   failed + rework available                     → rework
 *   failed + no rework                            → abandon
 *   stop_condition_triggered + rework             → rework
 *   stop_condition_triggered + no rework          → abandon
 */
export function decideRework(
	task: SubagentTask,
	result: SubagentResult,
	maxReworkAttempts: number,
	currentReworkCount: number,
): ReworkDecision {
	const canRework = currentReworkCount < maxReworkAttempts;

	switch (result.status) {
		case "completed": {
			const evaluation = evaluateVerifications(task.verification, result.verifications);
			if (evaluation.allPassed) {
				return { type: "accept" };
			}
			if (canRework) {
				return {
					type: "rework",
					reason: `Verification failures: ${evaluation.failedNames.join(", ")}`,
					focusAreas: [...evaluation.failedNames],
				};
			}
			return { type: "abandon", reason: "Rework limit exceeded — verification failures persist" };
		}

		case "boundary_violation":
			return { type: "abandon", reason: "Boundary violation detected — subagent modified paths outside its scope" };

		case "failed": {
			if (canRework) {
				return {
					type: "rework",
					reason: "Task execution failed",
					focusAreas: [],
				};
			}
			return { type: "abandon", reason: "Rework limit exceeded — task keeps failing" };
		}

		case "stop_condition_triggered": {
			if (canRework) {
				return {
					type: "rework",
					reason: "Stop condition was triggered",
					focusAreas: [],
				};
			}
			return { type: "abandon", reason: "Rework limit exceeded — stop conditions keep triggering" };
		}
	}
}
