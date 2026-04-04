import { describe, expect, it } from "vitest";
import {
	createInitialRuntimeState,
	evaluateStopConditions,
	recordBoundaryViolation,
	recordError,
	recordModification,
	updateElapsedTime,
} from "../subagent/stop-condition.js";
import type { StopCondition } from "../subagent/task-types.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StopCondition", () => {
	describe("createInitialRuntimeState", () => {
		it("returns zero values", () => {
			const state = createInitialRuntimeState();
			expect(state.modifiedPaths).toHaveLength(0);
			expect(state.elapsedMs).toBe(0);
			expect(state.errorCount).toBe(0);
			expect(state.boundaryViolations).toBe(0);
		});
	});

	describe("state tracking", () => {
		it("recordModification adds path immutably", () => {
			const s0 = createInitialRuntimeState();
			const s1 = recordModification(s0, "/foo.ts");
			expect(s1.modifiedPaths).toEqual(["/foo.ts"]);
			expect(s0.modifiedPaths).toHaveLength(0); // original unchanged
		});

		it("recordError increments errorCount immutably", () => {
			const s0 = createInitialRuntimeState();
			const s1 = recordError(s0);
			expect(s1.errorCount).toBe(1);
			expect(s0.errorCount).toBe(0);
		});

		it("recordBoundaryViolation increments boundaryViolations", () => {
			const s0 = createInitialRuntimeState();
			const s1 = recordBoundaryViolation(s0);
			expect(s1.boundaryViolations).toBe(1);
		});

		it("updateElapsedTime sets elapsedMs", () => {
			const s0 = createInitialRuntimeState();
			const s1 = updateElapsedTime(s0, 5000);
			expect(s1.elapsedMs).toBe(5000);
		});
	});

	describe("evaluateStopConditions", () => {
		it("returns not triggered for fresh state", () => {
			const conditions: StopCondition[] = [{ type: "boundary_violation", description: "Stop" }];
			const result = evaluateStopConditions(conditions, createInitialRuntimeState());
			expect(result.triggered).toBe(false);
			expect(result.triggeredCondition).toBeUndefined();
		});

		it("triggers on boundary_violation", () => {
			const conditions: StopCondition[] = [{ type: "boundary_violation", description: "Stop" }];
			const state = recordBoundaryViolation(createInitialRuntimeState());
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
			expect(result.triggeredCondition?.type).toBe("boundary_violation");
		});

		it("triggers on max_duration_ms exceeded", () => {
			const conditions: StopCondition[] = [{ type: "max_duration_ms", value: 5000, description: "Timeout" }];
			const state = updateElapsedTime(createInitialRuntimeState(), 6000);
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
			expect(result.triggeredCondition?.type).toBe("max_duration_ms");
		});

		it("triggers on max_file_count exceeded", () => {
			const conditions: StopCondition[] = [{ type: "max_file_count", value: 3, description: "Too many files" }];
			let state = createInitialRuntimeState();
			state = recordModification(state, "a.ts");
			state = recordModification(state, "b.ts");
			state = recordModification(state, "c.ts");
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
		});

		it("triggers on error_threshold exceeded", () => {
			const conditions: StopCondition[] = [{ type: "error_threshold", value: 2, description: "Too many errors" }];
			let state = createInitialRuntimeState();
			state = recordError(state);
			state = recordError(state);
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
		});

		it("triggers on max_mutations (alias for max_file_count)", () => {
			const conditions: StopCondition[] = [{ type: "max_mutations", value: 1, description: "Too many mutations" }];
			const state = recordModification(createInitialRuntimeState(), "a.ts");
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
		});

		it("returns first-match when multiple conditions could trigger", () => {
			const conditions: StopCondition[] = [
				{ type: "boundary_violation", description: "Boundary" },
				{ type: "error_threshold", value: 1, description: "Errors" },
			];
			let state = createInitialRuntimeState();
			state = recordBoundaryViolation(state);
			state = recordError(state);
			const result = evaluateStopConditions(conditions, state);
			expect(result.triggered).toBe(true);
			expect(result.triggeredCondition?.type).toBe("boundary_violation");
		});

		it("custom type never triggers (reserved for future)", () => {
			const conditions: StopCondition[] = [{ type: "custom", description: "Custom check" }];
			const result = evaluateStopConditions(conditions, createInitialRuntimeState());
			expect(result.triggered).toBe(false);
		});
	});
});
