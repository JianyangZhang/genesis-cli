/**
 * Interaction state reducer — pure function state machine.
 *
 * Derives the current InteractionPhase from RuntimeEvents.
 * No side effects, no I/O.
 */

import type { RuntimeEvent } from "@pickle-pee/runtime";
import type { InteractionPhase, InteractionState } from "../types/index.js";

/** Create the initial interaction state (idle, no active tool/plan). */
export function initialInteractionState(): InteractionState {
	return {
		phase: "idle",
		activeToolName: null,
		activeToolCallId: null,
		activePlanStepId: null,
		activePlanId: null,
	};
}

/**
 * Derive the next InteractionState from the current state and an incoming event.
 *
 * Phase transitions:
 *   text_delta / thinking_delta        → streaming (if idle or thinking)
 *   tool_started                       → tool_executing
 *   tool_completed / tool_denied       → idle
 *   permission_requested               → waiting_permission
 *   permission_resolved                → previous phase (idle)
 *   compaction_started                 → compacting
 *   compaction_completed               → idle
 *   plan_step_started                  → updates activePlanStepId
 */
export function reduceInteractionState(current: InteractionState, event: RuntimeEvent): InteractionState {
	switch (event.category) {
		case "text": {
			if (current.phase === "idle" || current.phase === "thinking") {
				return { ...current, phase: "streaming" };
			}
			return current;
		}

		case "tool": {
			switch (event.type) {
				case "tool_started":
					return {
						...current,
						phase: "tool_executing",
						activeToolName: event.toolName,
						activeToolCallId: event.toolCallId,
					};
				case "tool_completed":
				case "tool_denied":
					return {
						...current,
						phase: "idle",
						activeToolName: null,
						activeToolCallId: null,
					};
				case "tool_update":
					// Stay in current phase; update events are informational only.
					return current;
				default:
					return current;
			}
		}

		case "plan": {
			switch (event.type) {
				case "plan_created":
					return { ...current, activePlanId: event.planId };
				case "plan_step_started":
					return {
						...current,
						activePlanStepId: event.stepId,
						activePlanId: event.planId,
					};
				case "plan_step_completed":
				case "plan_step_failed":
					return { ...current, activePlanStepId: null };
				case "plan_completed":
					return { ...current, activePlanId: null, activePlanStepId: null };
				case "plan_rework":
					return {
						...current,
						activePlanStepId: event.stepId,
						activePlanId: event.planId,
					};
				default:
					return current;
			}
		}

		case "permission": {
			switch (event.type) {
				case "permission_requested":
					return {
						...current,
						phase: "waiting_permission",
						activeToolName: event.toolName,
						activeToolCallId: event.toolCallId,
					};
				case "permission_resolved":
					return {
						...current,
						phase: "idle" as InteractionPhase,
						activeToolName: null,
						activeToolCallId: null,
					};
				default:
					return current;
			}
		}

		case "compaction": {
			switch (event.type) {
				case "compaction_started":
					return { ...current, phase: "compacting" };
				case "compaction_completed":
					return { ...current, phase: "idle" };
				default:
					return current;
			}
		}

		case "session": {
			// Session events do not change interaction phase.
			return current;
		}

		default:
			return current;
	}
}
