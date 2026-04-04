/**
 * Factory functions for plan lifecycle events.
 *
 * Follows the same pattern as session-events.ts: auto-fills id and timestamp
 * so callers don't repeat boilerplate.
 */

import type {
	PlanCompletedEvent,
	PlanCreatedEvent,
	PlanReworkEvent,
	PlanStepCompletedEvent,
	PlanStepFailedEvent,
	PlanStepStartedEvent,
} from "../events/runtime-event.js";
import { generateEventId } from "../session/session-events.js";
import type { PlanSummary, SessionId } from "../types/index.js";

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

export function planCreated(sessionId: SessionId, planId: string, goal: string, stepCount: number): PlanCreatedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_created",
		planId,
		goal,
		stepCount,
	};
}

export function planStepStarted(
	sessionId: SessionId,
	planId: string,
	stepId: string,
	stepDescription: string,
): PlanStepStartedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_step_started",
		planId,
		stepId,
		stepDescription,
	};
}

export function planStepCompleted(
	sessionId: SessionId,
	planId: string,
	stepId: string,
	success: boolean,
): PlanStepCompletedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_step_completed",
		planId,
		stepId,
		success,
	};
}

export function planStepFailed(
	sessionId: SessionId,
	planId: string,
	stepId: string,
	reason: string,
	reworkScheduled: boolean,
): PlanStepFailedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_step_failed",
		planId,
		stepId,
		reason,
		reworkScheduled,
	};
}

export function planRework(
	sessionId: SessionId,
	planId: string,
	stepId: string,
	reworkAttempt: number,
	focusAreas: readonly string[],
): PlanReworkEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_rework",
		planId,
		stepId,
		reworkAttempt,
		focusAreas,
	};
}

export function planCompleted(
	sessionId: SessionId,
	planId: string,
	goal: string,
	success: boolean,
	summary: PlanSummary,
): PlanCompletedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "plan",
		type: "plan_completed",
		planId,
		goal,
		success,
		summary,
	};
}
