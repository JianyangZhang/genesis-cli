import { describe, expect, it } from "vitest";
import { createRuntimeContext, updateTaskState } from "../runtime-context.js";
import type { ModelDescriptor, SessionId, ToolSetDescriptor } from "../types/index.js";

const stubSessionId: SessionId = { value: "ctx-test" };
const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };
const stubToolSet: ToolSetDescriptor = new Set(["read", "edit"]);

describe("RuntimeContext", () => {
	it("creates context with all fields", () => {
		const ctx = createRuntimeContext({
			sessionId: stubSessionId,
			workingDirectory: "/tmp/test",
			mode: "print",
			model: stubModel,
			toolSet: stubToolSet,
		});

		expect(ctx.sessionId).toEqual(stubSessionId);
		expect(ctx.workingDirectory).toBe("/tmp/test");
		expect(ctx.mode).toBe("print");
		expect(ctx.model).toEqual(stubModel);
		expect(ctx.toolSet).toBe(stubToolSet);
		expect(ctx.taskState).toEqual({ status: "idle", currentTaskId: null, startedAt: null });
	});

	it("defaults task state to idle", () => {
		const ctx = createRuntimeContext({
			sessionId: stubSessionId,
			workingDirectory: "/tmp",
			mode: "interactive",
			model: stubModel,
			toolSet: stubToolSet,
		});

		expect(ctx.taskState.status).toBe("idle");
		expect(ctx.taskState.currentTaskId).toBeNull();
		expect(ctx.taskState.startedAt).toBeNull();
	});

	it("updateTaskState returns a new context instance", () => {
		const ctx = createRuntimeContext({
			sessionId: stubSessionId,
			workingDirectory: "/tmp",
			mode: "json",
			model: stubModel,
			toolSet: stubToolSet,
		});

		const updated = updateTaskState(ctx, {
			status: "running",
			currentTaskId: "task-1",
			startedAt: 1000,
		});

		expect(updated).not.toBe(ctx);
		expect(ctx.taskState.status).toBe("idle"); // original unchanged
		expect(updated.taskState.status).toBe("running");
		expect(updated.taskState.currentTaskId).toBe("task-1");
	});

	it("preserves other fields when updating task state", () => {
		const ctx = createRuntimeContext({
			sessionId: stubSessionId,
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			toolSet: stubToolSet,
		});

		const updated = updateTaskState(ctx, { status: "completed", currentTaskId: null, startedAt: null });

		expect(updated.sessionId).toBe(stubSessionId);
		expect(updated.workingDirectory).toBe("/tmp");
		expect(updated.mode).toBe("rpc");
		expect(updated.model).toBe(stubModel);
		expect(updated.toolSet).toBe(stubToolSet);
	});
});
