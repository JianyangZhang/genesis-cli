import { describe, expect, it } from "vitest";
import type { PathScope, SubagentTask } from "../subagent/task-types.js";
import { hasConsistentScope, hasRequiredFields, validateTask } from "../subagent/task-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<SubagentTask>): SubagentTask {
	return {
		taskId: "task-001",
		goal: "Implement feature X",
		scope: {
			allowedPaths: ["packages/app-runtime/**"],
			forbiddenPaths: ["packages/app-ui/**"],
		},
		inputs: { docs: [], files: [], assumptions: [] },
		deliverables: ["code"],
		verification: [{ name: "build", type: "command", command: "npm run build", description: "Build passes" }],
		stopConditions: [{ type: "boundary_violation", description: "Stop on boundary violation" }],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskValidator", () => {
	describe("validateTask", () => {
		it("accepts a valid task", () => {
			const result = validateTask(makeTask());
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("rejects task without taskId", () => {
			const result = validateTask(makeTask({ taskId: "" }));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taskId must be non-empty");
		});

		it("rejects task with whitespace-only taskId", () => {
			const result = validateTask(makeTask({ taskId: "   " }));
			expect(result.valid).toBe(false);
		});

		it("rejects task without goal", () => {
			const result = validateTask(makeTask({ goal: "" }));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("goal must be non-empty");
		});

		it("rejects task without allowedPaths", () => {
			const result = validateTask(makeTask({ scope: { allowedPaths: [], forbiddenPaths: [] } }));
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("allowedPaths"))).toBe(true);
		});

		it("rejects task without verification", () => {
			const result = validateTask(makeTask({ verification: [] }));
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("verification"))).toBe(true);
		});

		it("rejects task without stopConditions", () => {
			const result = validateTask(makeTask({ stopConditions: [] }));
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("stopConditions"))).toBe(true);
		});

		it("collects multiple errors at once", () => {
			const result = validateTask(makeTask({ taskId: "", goal: "", verification: [], stopConditions: [] }));
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThanOrEqual(4);
		});
	});

	describe("hasRequiredFields", () => {
		it("returns valid for complete task", () => {
			const result = hasRequiredFields(makeTask());
			expect(result.valid).toBe(true);
		});

		it("lists missing field names", () => {
			const result = hasRequiredFields(makeTask({ taskId: "", verification: [] }));
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("taskId");
			expect(result.errors).toContain("verification");
		});
	});

	describe("hasConsistentScope", () => {
		it("returns valid for non-overlapping scope", () => {
			const scope: PathScope = {
				allowedPaths: ["packages/a/**"],
				forbiddenPaths: ["packages/b/**"],
			};
			expect(hasConsistentScope(scope).valid).toBe(true);
		});

		it("detects overlapping scope", () => {
			const scope: PathScope = {
				allowedPaths: ["packages/a/**"],
				forbiddenPaths: ["packages/a/**"],
			};
			expect(hasConsistentScope(scope).valid).toBe(false);
		});
	});
});
