/**
 * RuntimeContext factory and helpers.
 *
 * RuntimeContext is an immutable value object that holds the execution context
 * available to all runtime consumers. State changes produce new instances.
 */

import type {
	CliMode,
	ModelDescriptor,
	RuntimeContext,
	SessionId,
	TaskState,
	ToolSetDescriptor,
} from "./types/index.js";

// ---------------------------------------------------------------------------
// Factory input
// ---------------------------------------------------------------------------

export interface RuntimeContextParams {
	readonly sessionId: SessionId;
	readonly workingDirectory: string;
	readonly agentDir?: string;
	readonly mode: CliMode;
	readonly model: ModelDescriptor;
	readonly toolSet: ToolSetDescriptor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const IDLE_TASK: TaskState = {
	status: "idle",
	currentTaskId: null,
	startedAt: null,
} as const;

export function createRuntimeContext(params: RuntimeContextParams): RuntimeContext {
	return {
		sessionId: params.sessionId,
		workingDirectory: params.workingDirectory,
		agentDir: params.agentDir,
		mode: params.mode,
		model: params.model,
		toolSet: params.toolSet,
		taskState: IDLE_TASK,
	};
}

// ---------------------------------------------------------------------------
// Updaters — return new instances
// ---------------------------------------------------------------------------

export function updateTaskState(context: RuntimeContext, taskState: TaskState): RuntimeContext {
	return { ...context, taskState };
}
