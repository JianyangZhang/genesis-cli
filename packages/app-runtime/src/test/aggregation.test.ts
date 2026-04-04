import { describe, expect, it } from "vitest";
import { aggregateResults, decideRework } from "../subagent/aggregation.js";
import type { SubagentResult, TaskRisk } from "../subagent/result-types.js";
import type { SubagentTask } from "../subagent/task-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<SubagentTask>): SubagentTask {
	return {
		taskId: "task-001",
		goal: "Implement feature X",
		scope: { allowedPaths: ["packages/app-runtime/**"], forbiddenPaths: [] },
		inputs: { docs: [], files: [], assumptions: [] },
		deliverables: ["code"],
		verification: [{ name: "build", type: "command", command: "npm run build", description: "Build passes" }],
		stopConditions: [{ type: "boundary_violation", description: "Stop" }],
		...overrides,
	};
}

function makeResult(overrides?: Partial<SubagentResult>): SubagentResult {
	return {
		taskId: "task-001",
		status: "completed",
		modifiedPaths: [],
		verifications: [],
		risks: [],
		handoffNotes: [],
		completedAt: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Aggregation", () => {
	describe("aggregateResults", () => {
		it("aggregates completed and failed counts", () => {
			const results: SubagentResult[] = [
				makeResult({ taskId: "t1", status: "completed" }),
				makeResult({ taskId: "t2", status: "failed" }),
				makeResult({ taskId: "t3", status: "completed" }),
			];
			const agg = aggregateResults("plan-1", results);
			expect(agg.totalTasks).toBe(3);
			expect(agg.completedTasks).toBe(2);
			expect(agg.failedTasks).toBe(1);
		});

		it("merges all modified paths", () => {
			const results: SubagentResult[] = [
				makeResult({ taskId: "t1", modifiedPaths: ["a.ts", "b.ts"] }),
				makeResult({ taskId: "t2", modifiedPaths: ["c.ts"] }),
			];
			const agg = aggregateResults("plan-1", results);
			expect(agg.allModifiedPaths).toEqual(["a.ts", "b.ts", "c.ts"]);
		});

		it("merges all risks", () => {
			const risk1: TaskRisk = { severity: "high", description: "R1", affectedPaths: [] };
			const risk2: TaskRisk = { severity: "low", description: "R2", affectedPaths: [] };
			const results: SubagentResult[] = [
				makeResult({ taskId: "t1", risks: [risk1] }),
				makeResult({ taskId: "t2", risks: [risk2] }),
			];
			const agg = aggregateResults("plan-1", results);
			expect(agg.allRisks).toHaveLength(2);
		});

		it("returns correct planId and completedAt", () => {
			const agg = aggregateResults("plan-1", []);
			expect(agg.planId).toBe("plan-1");
			expect(agg.completedAt).toBeGreaterThan(0);
		});

		it("handles empty results", () => {
			const agg = aggregateResults("plan-1", []);
			expect(agg.totalTasks).toBe(0);
			expect(agg.completedTasks).toBe(0);
			expect(agg.allModifiedPaths).toHaveLength(0);
		});

		it("counts completion using final rework decisions when provided", () => {
			const results: SubagentResult[] = [
				makeResult({ taskId: "t1", status: "completed" }),
				makeResult({ taskId: "t2", status: "completed" }),
			];
			const decisions = new Map([
				["t1", { type: "accept" as const }],
				["t2", { type: "rework" as const, reason: "verification", focusAreas: ["build"] }],
			]);
			const agg = aggregateResults("plan-1", results, decisions);

			expect(agg.completedTasks).toBe(1);
			expect(agg.failedTasks).toBe(1);
			expect(agg.tasksRequiringRework).toBe(1);
		});
	});

	describe("decideRework", () => {
		it("accepts completed task with all verifications passed", () => {
			const task = makeTask();
			const result = makeResult({
				verifications: [{ name: "build", status: "passed", output: "ok" }],
			});
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("accept");
		});

		it("reworks completed task with failed verifications", () => {
			const task = makeTask({
				verification: [
					{ name: "build", type: "command", command: "npm run build", description: "Build" },
					{ name: "test", type: "command", command: "npm test", description: "Tests" },
				],
			});
			const result = makeResult({
				verifications: [
					{ name: "build", status: "passed", output: "ok" },
					{ name: "test", status: "failed", output: "2 failures" },
				],
			});
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("rework");
			if (decision.type === "rework") {
				expect(decision.focusAreas).toContain("test");
			}
		});

		it("abandons completed task when rework limit exceeded and verifications fail", () => {
			const task = makeTask();
			const result = makeResult({
				verifications: [{ name: "build", status: "failed", output: "error" }],
			});
			const decision = decideRework(task, result, 2, 2);
			expect(decision.type).toBe("abandon");
		});

		it("abandons on boundary violation", () => {
			const task = makeTask();
			const result = makeResult({ status: "boundary_violation" });
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("abandon");
			if (decision.type === "abandon") {
				expect(decision.reason).toContain("Boundary violation");
			}
		});

		it("reworks failed task when attempts remain", () => {
			const task = makeTask();
			const result = makeResult({ status: "failed" });
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("rework");
		});

		it("abandons failed task when rework limit exceeded", () => {
			const task = makeTask();
			const result = makeResult({ status: "failed" });
			const decision = decideRework(task, result, 2, 2);
			expect(decision.type).toBe("abandon");
			if (decision.type === "abandon") {
				expect(decision.reason).toContain("Rework limit");
			}
		});

		it("reworks on stop condition triggered with attempts remaining", () => {
			const task = makeTask();
			const result = makeResult({ status: "stop_condition_triggered" });
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("rework");
		});

		it("abandons on stop condition triggered when no attempts remain", () => {
			const task = makeTask();
			const result = makeResult({ status: "stop_condition_triggered" });
			const decision = decideRework(task, result, 2, 2);
			expect(decision.type).toBe("abandon");
		});

		// --- Boundary violation detection via modifiedPaths in completed results ---

		it("reworks completed result with modifiedPaths outside scope", () => {
			const task = makeTask();
			const result = makeResult({
				modifiedPaths: ["packages/other-lib/src/main.ts"],
				verifications: [{ name: "build", status: "passed", output: "ok" }],
			});
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("rework");
			if (decision.type === "rework") {
				expect(decision.reason).toContain("outside scope");
				expect(decision.focusAreas).toContain("scope_compliance");
			}
		});

		it("abandons completed result with out-of-scope modifiedPaths when rework exhausted", () => {
			const task = makeTask();
			const result = makeResult({
				modifiedPaths: ["packages/other-lib/src/main.ts"],
				verifications: [{ name: "build", status: "passed", output: "ok" }],
			});
			const decision = decideRework(task, result, 2, 2);
			expect(decision.type).toBe("abandon");
			if (decision.type === "abandon") {
				expect(decision.reason).toContain("Boundary violation");
			}
		});

		it("accepts completed result with in-scope modifiedPaths", () => {
			const task = makeTask();
			const result = makeResult({
				modifiedPaths: ["packages/app-runtime/src/foo.ts"],
				verifications: [{ name: "build", status: "passed", output: "ok" }],
			});
			const decision = decideRework(task, result, 2, 0);
			expect(decision.type).toBe("accept");
		});
	});
});
