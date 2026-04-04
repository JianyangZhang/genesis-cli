/**
 * Factory functions for session lifecycle events.
 *
 * Auto-fills `id` and `timestamp` so callers don't repeat boilerplate.
 */

import type { SessionClosedEvent, SessionCreatedEvent, SessionResumedEvent } from "../events/runtime-event.js";
import type { ModelDescriptor, SessionId, SessionRecoveryData } from "../types/index.js";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateEventId(): string {
	return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

export function sessionCreated(
	sessionId: SessionId,
	model: ModelDescriptor,
	toolSet: readonly string[],
): SessionCreatedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "session",
		type: "session_created",
		model,
		toolSet,
	};
}

export function sessionResumed(sessionId: SessionId, recoveryData: SessionRecoveryData): SessionResumedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "session",
		type: "session_resumed",
		recoveryData,
	};
}

export function sessionClosed(sessionId: SessionId): SessionClosedEvent {
	return {
		id: generateEventId(),
		timestamp: Date.now(),
		sessionId,
		category: "session",
		type: "session_closed",
	};
}
