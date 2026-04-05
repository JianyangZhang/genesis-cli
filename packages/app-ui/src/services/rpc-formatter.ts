/**
 * Event-to-RPC formatter for RPC mode.
 *
 * Converts RuntimeEvents to JSON-RPC 2.0 notifications.
 * Parses incoming JSON-RPC requests from stdin.
 * Pure functions — no I/O, no side effects.
 */

import type { RuntimeEvent } from "@genesis-cli/runtime";
import type { RpcEnvelope } from "../types/index.js";

// ---------------------------------------------------------------------------
// Public API — outgoing messages
// ---------------------------------------------------------------------------

/**
 * Convert a RuntimeEvent to a JSON-RPC 2.0 notification.
 * Notifications have no `id` field and do not expect a response.
 */
export function eventToRpcNotification(event: RuntimeEvent): RpcEnvelope {
	return {
		jsonrpc: "2.0",
		method: `event/${event.category}/${event.type}`,
		params: extractRpcParams(event),
	};
}

/**
 * Create a JSON-RPC 2.0 success response.
 */
export function createRpcResponse(id: string | number, result: unknown): RpcEnvelope {
	return { jsonrpc: "2.0", id, result };
}

/**
 * Create a JSON-RPC 2.0 error response.
 */
export function createRpcError(id: string | number | null, code: number, message: string, data?: unknown): RpcEnvelope {
	const errorObj: { code: number; message: string; data?: unknown } = { code, message };
	if (data !== undefined) {
		errorObj.data = data;
	}
	return { jsonrpc: "2.0", id, error: errorObj };
}

// ---------------------------------------------------------------------------
// Public API — incoming messages
// ---------------------------------------------------------------------------

/**
 * Parse an incoming JSON-RPC request line.
 * Returns null if the line is not valid JSON or is not a JSON-RPC request.
 */
export function parseRpcRequest(line: string): RpcEnvelope | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!isRpcEnvelope(parsed)) return null;
	return parsed;
}

// ---------------------------------------------------------------------------
// RPC method constants
// ---------------------------------------------------------------------------

/** Standard RPC method names for session management. */
export const RPC_METHODS = {
	SESSION_CREATE: "session/create",
	SESSION_PROMPT: "session/prompt",
	SESSION_ABORT: "session/abort",
	SESSION_CLOSE: "session/close",
	SESSION_LIST: "session/list",
	SESSION_SELECT: "session/select",
	PLAN_STATUS: "plan/status",
	TOOLS_LIST: "tools/list",
	PERMISSION_RESOLVE: "permission/resolve",
	EVENTS_SUBSCRIBE: "events/subscribe",
	EVENTS_UNSUBSCRIBE: "events/unsubscribe",
	EVENTS_STATUS: "events/status",
} as const;

/** Standard RPC error codes. */
export const RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	SESSION_NOT_FOUND: -32001,
	SESSION_BUSY: -32002,
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractRpcParams(event: RuntimeEvent): Readonly<Record<string, unknown>> {
	const params: Record<string, unknown> = {
		sessionId: event.sessionId.value,
		eventId: event.id,
		timestamp: event.timestamp,
	};

	// Copy stable, mode-agnostic fields (same allowlist as sanitizeForJson)
	const allowed = [
		"model",
		"toolSet",
		"toolName",
		"toolCallId",
		"parameters",
		"status",
		"result",
		"durationMs",
		"reason",
		"update",
		"planId",
		"goal",
		"stepCount",
		"stepId",
		"stepDescription",
		"success",
		"reworkScheduled",
		"reworkAttempt",
		"focusAreas",
		"summary",
		"riskLevel",
		"decision",
		"content",
		"recoveryData",
	] as const;

	for (const key of allowed) {
		if (key in event) {
			params[key] = (event as unknown as Record<string, unknown>)[key];
		}
	}

	return params;
}

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return obj.jsonrpc === "2.0";
}
