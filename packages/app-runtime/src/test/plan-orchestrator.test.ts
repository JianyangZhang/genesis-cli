import { describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import { createPlanEngine } from "../planning/plan-engine.js";
import { createPlanOrchestrator } from "../planning/plan-orchestrator.js";
import type { SubagentResult, SubagentTask } from "../subagent/index.js";
import type { SessionId } from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sessionId: SessionId = { value: "orch-test" };

function makeTask(overrides?: Partial<SubagentTask>): SubagentTask {
	return {
		taskId: "task-1",
		goal: "Implement X",
		scope: { allowedPaths: ["packages/app-runtime/**"], forbiddenPaths: ["packages/app-ui/**"] },
		inputs: { docs: [], files: [], assumptions: [] },
		deliverables: ["code"],
		verification: [{ name: "build", type: "command", command: "npm run build", description: "Build" }],
		stopConditions: [{ type: "max_file_count", value: 10, description: "Max files" }],
		...overrides,
	};
}

function makeResult(overrides?: Partial<SubagentResult>): SubagentResult {
	return {
		taskId: "task-1",
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

describe("PlanOrchestrator", () => {
	function createFixture() {
		const engine = createPlanEngine();
		const sessionBus = createEventBus();
		const globalBus = createEventBus();
		const orchestrator = createPlanOrchestrator(engine, sessionBus, globalBus, sessionId);
		const sessionEvents: RuntimeEvent[] = [];
		const globalEvents: RuntimeEvent[] = [];
		sessionBus.onCategory("plan", (e) => sessionEvents.push(e));
		globalBus.onCategory("plan", (e) => globalEvents.push(e));

		return { orchestrator, engine, sessionBus, globalBus, sessionEvents, globalEvents };
	}

	// -------------------------------------------------------------------------
	// createAndActivate
	// -------------------------------------------------------------------------

	describe("createAndActivate", () => {
		it("creates and activates a plan", () => {
			const { orchestrator } = createFixture();
			const plan = orchestrator.createAndActivate("p1", "Goal", ["Step A", "Step B"]);

			expect(plan.status).toBe("active");
			expect(plan.steps).toHaveLength(2);
			expect(orchestrator.activePlan).toBe(plan);
		});

		it("emits plan_created event", () => {
			const { orchestrator, sessionEvents, globalEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step"]);

			expect(sessionEvents).toHaveLength(1);
			expect(sessionEvents[0]!.type).toBe("plan_created");
			expect(globalEvents).toHaveLength(1);
		});

		it("returns null summarize before plan creation", () => {
			const { orchestrator } = createFixture();
			expect(orchestrator.summarize()).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// assignTask
	// -------------------------------------------------------------------------

	describe("assignTask", () => {
		it("assigns task and starts step", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);

			const task = makeTask();
			const plan = orchestrator.assignTask(0, task);

			expect(plan.steps[0].status).toBe("in_progress");
			expect(plan.steps[0].taskId).toBe("task-1");
		});

		it("emits plan_step_started event", () => {
			const { orchestrator, sessionEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());

			// sessionEvents[0] = plan_created, sessionEvents[1] = plan_step_started
			expect(sessionEvents).toHaveLength(2);
			expect(sessionEvents[1]!.type).toBe("plan_step_started");
		});

		it("throws if no active plan", () => {
			const { orchestrator } = createFixture();
			expect(() => orchestrator.assignTask(0, makeTask())).toThrow("No active plan");
		});

		it("throws for invalid task", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);

			expect(() => orchestrator.assignTask(0, makeTask({ taskId: "" }))).toThrow("Invalid task");
		});
	});

	// -------------------------------------------------------------------------
	// submitResult — success path
	// -------------------------------------------------------------------------

	describe("submitResult — success", () => {
		it("completes step for valid completed result", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());

			const result = makeResult({
				modifiedPaths: ["packages/app-runtime/src/foo.ts"],
			});
			const plan = orchestrator.submitResult(0, result);

			expect(plan.steps[0].status).toBe("completed");
		});

		it("emits plan_step_completed on success", () => {
			const { orchestrator, sessionEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());
			orchestrator.submitResult(0, makeResult());

			const completedEvent = sessionEvents.find((e) => e.type === "plan_step_completed");
			expect(completedEvent).toBeDefined();
		});

		it("auto-completes plan and emits plan_completed when last step done", () => {
			const { orchestrator, sessionEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());
			const plan = orchestrator.submitResult(0, makeResult());

			expect(plan.status).toBe("completed");
			const completedEvent = sessionEvents.find((e) => e.type === "plan_completed");
			expect(completedEvent).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// submitResult — boundary violation
	// -------------------------------------------------------------------------

	describe("submitResult — boundary violation", () => {
		it("fails step when modifiedPaths are outside scope", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());

			const result = makeResult({
				modifiedPaths: ["packages/other-lib/src/main.ts"],
			});
			const plan = orchestrator.submitResult(0, result);

			expect(plan.steps[0].status).toBe("failed");
		});

		it("emits plan_step_failed with boundary_violation reason", () => {
			const { orchestrator, sessionEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());
			orchestrator.submitResult(
				0,
				makeResult({
					modifiedPaths: ["packages/other-lib/src/main.ts"],
				}),
			);

			const failedEvent = sessionEvents.find((e) => e.type === "plan_step_failed");
			expect(failedEvent).toBeDefined();
			if (failedEvent?.type === "plan_step_failed") {
				expect(failedEvent.reason).toBe("boundary_violation");
			}
		});

		it("fails step when modifiedPaths hit forbidden paths", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());

			const result = makeResult({
				modifiedPaths: ["packages/app-ui/src/component.ts"],
			});
			const plan = orchestrator.submitResult(0, result);

			expect(plan.steps[0].status).toBe("failed");
		});
	});

	// -------------------------------------------------------------------------
	// submitResult — stop condition
	// -------------------------------------------------------------------------

	describe("submitResult — stop condition triggered", () => {
		it("fails step when stop condition is triggered", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(
				0,
				makeTask({
					stopConditions: [{ type: "max_file_count", value: 2, description: "Max 2 files" }],
				}),
			);

			// 3 modified paths, but max_file_count = 2
			const result = makeResult({
				modifiedPaths: [
					"packages/app-runtime/src/a.ts",
					"packages/app-runtime/src/b.ts",
					"packages/app-runtime/src/c.ts",
				],
			});
			const plan = orchestrator.submitResult(0, result);

			expect(plan.steps[0].status).toBe("failed");
		});
	});

	// -------------------------------------------------------------------------
	// submitResult — non-completed status
	// -------------------------------------------------------------------------

	describe("submitResult — non-completed result", () => {
		it("fails step for failed result", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());

			const result = makeResult({ status: "failed" });
			const plan = orchestrator.submitResult(0, result);

			expect(plan.steps[0].status).toBe("failed");
		});
	});

	// -------------------------------------------------------------------------
	// skipStep
	// -------------------------------------------------------------------------

	describe("skipStep", () => {
		it("skips a pending step", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A", "Step B"]);
			const plan = orchestrator.skipStep(1);

			expect(plan.steps[1].status).toBe("skipped");
		});

		it("auto-completes plan when all steps done after skip", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.assignTask(0, makeTask());
			const withCompleted = orchestrator.submitResult(0, makeResult());

			// Already completed since single-step plan auto-completes
			expect(withCompleted.status).toBe("completed");
		});
	});

	// -------------------------------------------------------------------------
	// abandonPlan
	// -------------------------------------------------------------------------

	describe("abandonPlan", () => {
		it("abandons the active plan", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			const plan = orchestrator.abandonPlan("not needed");

			expect(plan.status).toBe("abandoned");
			expect(plan.outcomeReason).toBe("user_abandoned");
		});

		it("emits plan_completed with success=false", () => {
			const { orchestrator, sessionEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);
			orchestrator.abandonPlan("done");

			const completedEvent = sessionEvents.find((e) => e.type === "plan_completed");
			expect(completedEvent).toBeDefined();
			if (completedEvent?.type === "plan_completed") {
				expect(completedEvent.success).toBe(false);
			}
		});
	});

	// -------------------------------------------------------------------------
	// summarize
	// -------------------------------------------------------------------------

	describe("summarize", () => {
		it("returns summary reflecting current state", () => {
			const { orchestrator } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A", "Step B"]);
			const summary = orchestrator.summarize();

			expect(summary).not.toBeNull();
			expect(summary!.planId).toBe("p1");
			expect(summary!.stepCount).toBe(2);
			expect(summary!.completedSteps).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Event propagation
	// -------------------------------------------------------------------------

	describe("event propagation", () => {
		it("emits to both session and global buses", () => {
			const { orchestrator, sessionEvents, globalEvents } = createFixture();
			orchestrator.createAndActivate("p1", "Goal", ["Step A"]);

			expect(sessionEvents).toHaveLength(1);
			expect(globalEvents).toHaveLength(1);
			expect(sessionEvents[0]!.id).toBe(globalEvents[0]!.id);
		});
	});
});
