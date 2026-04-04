import { describe, expect, it } from "vitest";
import {
	planCompleted,
	planCreated,
	planRework,
	planStepCompleted,
	planStepFailed,
	planStepStarted,
} from "../planning/plan-events.js";
import type { PlanSummary } from "../planning/plan-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sessionId = { value: "sess-1" } as const;

function makeSummary(overrides?: Partial<PlanSummary>): PlanSummary {
	return {
		planId: "plan-1",
		goal: "Test goal",
		status: "completed",
		stepCount: 1,
		completedSteps: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlanEvents", () => {
	it("planCreated produces correct shape", () => {
		const event = planCreated(sessionId, "plan-1", "Goal", 3);
		expect(event.category).toBe("plan");
		expect(event.type).toBe("plan_created");
		expect(event.planId).toBe("plan-1");
		expect(event.goal).toBe("Goal");
		expect(event.stepCount).toBe(3);
	});

	it("planStepStarted produces correct shape", () => {
		const event = planStepStarted(sessionId, "plan-1", "step-1", "Do something");
		expect(event.category).toBe("plan");
		expect(event.type).toBe("plan_step_started");
		expect(event.planId).toBe("plan-1");
		expect(event.stepId).toBe("step-1");
		expect(event.stepDescription).toBe("Do something");
	});

	it("planStepCompleted with success=true", () => {
		const event = planStepCompleted(sessionId, "plan-1", "step-1", true);
		expect(event.type).toBe("plan_step_completed");
		expect(event.success).toBe(true);
	});

	it("planStepCompleted with success=false", () => {
		const event = planStepCompleted(sessionId, "plan-1", "step-1", false);
		expect(event.success).toBe(false);
	});

	it("planStepFailed produces correct shape", () => {
		const event = planStepFailed(sessionId, "plan-1", "step-1", "Verification failed", true);
		expect(event.type).toBe("plan_step_failed");
		expect(event.reason).toBe("Verification failed");
		expect(event.reworkScheduled).toBe(true);
	});

	it("planRework produces correct shape", () => {
		const event = planRework(sessionId, "plan-1", "step-1", 2, ["verification"]);
		expect(event.type).toBe("plan_rework");
		expect(event.reworkAttempt).toBe(2);
		expect(event.focusAreas).toEqual(["verification"]);
	});

	it("planCompleted produces correct shape with summary", () => {
		const summary = makeSummary();
		const event = planCompleted(sessionId, "plan-1", "Goal", true, summary);
		expect(event.type).toBe("plan_completed");
		expect(event.success).toBe(true);
		expect(event.summary).toBe(summary);
	});

	it("all events have unique IDs", () => {
		const e1 = planCreated(sessionId, "p1", "G", 1);
		const e2 = planCreated(sessionId, "p1", "G", 1);
		expect(e1.id).not.toBe(e2.id);
	});

	it("all events reference the correct session", () => {
		const event = planCreated(sessionId, "plan-1", "Goal", 1);
		expect(event.sessionId).toBe(sessionId);
	});

	it("all events have timestamps > 0", () => {
		const event = planCreated(sessionId, "plan-1", "Goal", 1);
		expect(event.timestamp).toBeGreaterThan(0);
	});
});
