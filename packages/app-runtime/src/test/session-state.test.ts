import { describe, expect, it } from "vitest";
import {
	createInitialSessionState,
	recoverSessionState,
	serializeForRecovery,
	updateCompactionSummary,
	updatePlanSummary,
	updateSessionStatus,
	updateTaskState,
} from "../session/session-state.js";
import type { CompactionSummary, ModelDescriptor, PlanSummary, SessionId, TaskState } from "../types/index.js";

const stubId: SessionId = { value: "state-test" };
const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

describe("SessionState", () => {
	describe("createInitialSessionState", () => {
		it("creates state with creating status", () => {
			const state = createInitialSessionState(stubId, stubModel, new Set(["read"]));

			expect(state.id).toBe(stubId);
			expect(state.status).toBe("creating");
			expect(state.model).toBe(stubModel);
			expect(state.toolSet).toEqual(new Set(["read"]));
			expect(state.planSummary).toBeNull();
			expect(state.compactionSummary).toBeNull();
			expect(state.taskState.status).toBe("idle");
			expect(state.createdAt).toBeGreaterThan(0);
			expect(state.updatedAt).toBe(state.createdAt);
		});
	});

	describe("updateSessionStatus", () => {
		it("returns new state with updated status", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set());
			const updated = updateSessionStatus(original, "active");

			expect(updated.status).toBe("active");
			expect(original.status).toBe("creating"); // original unchanged
			expect(updated.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
		});
	});

	describe("updateCompactionSummary", () => {
		it("returns new state with compaction summary", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set());
			const summary: CompactionSummary = {
				compressedAt: Date.now(),
				originalMessageCount: 20,
				retainedMessageCount: 5,
				estimatedTokensSaved: 10000,
			};
			const updated = updateCompactionSummary(original, summary);

			expect(updated.compactionSummary).toEqual(summary);
			expect(original.compactionSummary).toBeNull(); // original unchanged
		});
	});

	describe("updateTaskState", () => {
		it("returns new state with updated task", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set());
			const task: TaskState = { status: "running", currentTaskId: "t-1", startedAt: 1000 };
			const updated = updateTaskState(original, task);

			expect(updated.taskState).toEqual(task);
			expect(original.taskState.status).toBe("idle"); // original unchanged
		});
	});

	describe("recovery roundtrip", () => {
		it("serialize → recover produces equivalent state", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set(["read", "edit"]));
			const active = updateSessionStatus(original, "active");
			const summary: CompactionSummary = {
				compressedAt: Date.now(),
				originalMessageCount: 10,
				retainedMessageCount: 3,
				estimatedTokensSaved: 5000,
			};
			const withCompaction = updateCompactionSummary(active, summary);

			// Serialize
			const data = serializeForRecovery(withCompaction);

			// Verify serializable fields
			expect(data.sessionId).toBe(stubId);
			expect(data.model).toBe(stubModel);
			expect(data.toolSet).toEqual(["read", "edit"]);
			expect(data.compactionSummary).toEqual(summary);

			// Recover
			const recovered = recoverSessionState(data);

			expect(recovered.id).toEqual(stubId);
			expect(recovered.model).toEqual(stubModel);
			expect(recovered.toolSet).toEqual(new Set(["read", "edit"]));
			expect(recovered.compactionSummary).toEqual(summary);
			expect(recovered.taskState).toEqual(withCompaction.taskState);
		});

		it("toolSet roundtrips through array serialization", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set(["a", "b", "c"]));
			const data = serializeForRecovery(original);
			const recovered = recoverSessionState(data);

			expect(recovered.toolSet).toEqual(new Set(["a", "b", "c"]));
		});
	});

	describe("updatePlanSummary", () => {
		it("returns new state with plan summary set", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set());
			const summary: PlanSummary = {
				planId: "p1",
				goal: "Implement X",
				status: "active",
				stepCount: 3,
				completedSteps: 1,
			};
			const updated = updatePlanSummary(original, summary);

			expect(updated.planSummary).toEqual(summary);
			expect(original.planSummary).toBeNull(); // original unchanged
			expect(updated.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
		});

		it("clears plan summary when set to null", () => {
			const original = createInitialSessionState(stubId, stubModel, new Set());
			const summary: PlanSummary = {
				planId: "p1",
				goal: "Goal",
				status: "completed",
				stepCount: 1,
				completedSteps: 1,
			};
			const withPlan = updatePlanSummary(original, summary);
			expect(withPlan.planSummary).toEqual(summary);

			const cleared = updatePlanSummary(withPlan, null);
			expect(cleared.planSummary).toBeNull();
		});
	});
});
