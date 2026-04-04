/**
 * SessionState management — pure functions for creating, updating,
 * serializing, and recovering session state.
 *
 * All functions return new objects; SessionState is treated as immutable.
 */

import type {
	CompactionSummary,
	ModelDescriptor,
	PlanSummary,
	SessionId,
	SessionRecoveryData,
	SessionState,
	SessionStatus,
	TaskState,
	ToolSetDescriptor,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function createInitialSessionState(
	id: SessionId,
	model: ModelDescriptor,
	toolSet: ToolSetDescriptor,
): SessionState {
	const now = Date.now();
	return {
		id,
		status: "creating",
		createdAt: now,
		updatedAt: now,
		model,
		toolSet,
		planSummary: null,
		compactionSummary: null,
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
	};
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export function recoverSessionState(data: SessionRecoveryData): SessionState {
	const now = Date.now();
	return {
		id: data.sessionId,
		status: "recovering",
		createdAt: now,
		updatedAt: now,
		model: data.model,
		toolSet: new Set(data.toolSet),
		planSummary: data.planSummary,
		compactionSummary: data.compactionSummary,
		taskState: data.taskState,
	};
}

export function serializeForRecovery(state: SessionState): SessionRecoveryData {
	return {
		sessionId: state.id,
		model: state.model,
		toolSet: [...state.toolSet],
		planSummary: state.planSummary,
		compactionSummary: state.compactionSummary,
		taskState: state.taskState,
	};
}

// ---------------------------------------------------------------------------
// Updaters — return new state objects
// ---------------------------------------------------------------------------

export function updateSessionStatus(state: SessionState, status: SessionStatus): SessionState {
	return { ...state, status, updatedAt: Date.now() };
}

export function updateCompactionSummary(state: SessionState, summary: CompactionSummary): SessionState {
	return { ...state, compactionSummary: summary, updatedAt: Date.now() };
}

export function updateTaskState(state: SessionState, taskState: TaskState): SessionState {
	return { ...state, taskState, updatedAt: Date.now() };
}

export function updatePlanSummary(state: SessionState, planSummary: PlanSummary | null): SessionState {
	return { ...state, planSummary, updatedAt: Date.now() };
}
