/**
 * Event-to-JSON formatter for JSON mode.
 *
 * Converts RuntimeEvents to JsonEnvelope objects.
 * Pure functions — no I/O, no side effects.
 *
 * Invariant: the output NEVER contains TUI-specific fields
 * (InteractionPhase, layout coordinates, ANSI strings, cursor positions).
 */

import type { RuntimeEvent } from "@pickle-pee/runtime";
import type { JsonEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a RuntimeEvent to a JSON-mode envelope.
 * Each envelope is a self-contained JSON object suitable for line-delimited output.
 */
export function eventToJsonEnvelope(event: RuntimeEvent): JsonEnvelope {
	return {
		event: event.type,
		category: event.category,
		timestamp: event.timestamp,
		sessionId: event.sessionId.value,
		data: sanitizeForJson(event),
	};
}

/**
 * Extract mode-agnostic data from a RuntimeEvent.
 *
 * Explicitly projects only the fields that make sense across all four modes.
 * TUI-specific concepts (InteractionPhase, layout, ANSI) are never included.
 */
export function sanitizeForJson(event: RuntimeEvent): Readonly<Record<string, unknown>> {
	const base: Record<string, unknown> = {};

	// All events have these
	base.id = event.id;

	// Category-specific fields — only stable, mode-agnostic data
	switch (event.category) {
		case "session": {
			if ("model" in event) base.model = event.model;
			if ("toolSet" in event) base.toolSet = event.toolSet;
			if ("recoveryData" in event) base.recoveryData = event.recoveryData;
			if ("message" in event) base.message = event.message;
			if ("source" in event) base.source = event.source;
			if ("fatal" in event) base.fatal = event.fatal;
			break;
		}
		case "tool": {
			if ("toolName" in event) base.toolName = event.toolName;
			if ("toolCallId" in event) base.toolCallId = event.toolCallId;
			if ("parameters" in event) base.parameters = event.parameters;
			if ("status" in event) base.status = event.status;
			if ("result" in event) base.result = event.result;
			if ("durationMs" in event) base.durationMs = event.durationMs;
			if ("reason" in event) base.reason = event.reason;
			if ("update" in event) base.update = event.update;
			break;
		}
		case "plan": {
			if ("planId" in event) base.planId = event.planId;
			if ("goal" in event) base.goal = event.goal;
			if ("stepCount" in event) base.stepCount = event.stepCount;
			if ("stepId" in event) base.stepId = event.stepId;
			if ("stepDescription" in event) base.stepDescription = event.stepDescription;
			if ("success" in event) base.success = event.success;
			if ("reason" in event) base.reason = event.reason;
			if ("reworkScheduled" in event) base.reworkScheduled = event.reworkScheduled;
			if ("reworkAttempt" in event) base.reworkAttempt = event.reworkAttempt;
			if ("focusAreas" in event) base.focusAreas = event.focusAreas;
			if ("summary" in event) base.summary = event.summary;
			break;
		}
		case "compaction": {
			if ("summary" in event) base.summary = event.summary;
			break;
		}
		case "permission": {
			if ("toolName" in event) base.toolName = event.toolName;
			if ("toolCallId" in event) base.toolCallId = event.toolCallId;
			if ("riskLevel" in event) base.riskLevel = event.riskLevel;
			if ("decision" in event) base.decision = event.decision;
			break;
		}
		case "text": {
			if ("content" in event) base.content = event.content;
			break;
		}
		case "usage": {
			if ("usage" in event) base.usage = event.usage;
			if ("isFinal" in event) base.isFinal = event.isFinal;
			break;
		}
	}

	return base;
}
