/**
 * Audit log types for recording tool invocation outcomes.
 *
 * Every tool call is recorded as an AuditEntry with one of three statuses:
 * success, failure, or denied. The audit log is in-memory and session-scoped.
 */

import type { ToolResultStatus } from "./index.js";

// ---------------------------------------------------------------------------
// Audit entry
// ---------------------------------------------------------------------------

export interface AuditEntry {
	readonly id: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly category: string;
	readonly status: ToolResultStatus;
	readonly riskLevel: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly durationMs: number;
	readonly targetPath?: string;
	readonly error?: string;
	readonly permissionDecision?: string;
}

// ---------------------------------------------------------------------------
// Audit log interface
// ---------------------------------------------------------------------------

export interface AuditLog {
	/** Record a completed tool invocation. */
	record(entry: AuditEntry): void;

	/** Query entries by tool name. */
	getByTool(toolName: string): readonly AuditEntry[];

	/** Query entries by status (success, failure, denied). */
	getByStatus(status: ToolResultStatus): readonly AuditEntry[];

	/** Get all entries, ordered by completion time. */
	getAll(): readonly AuditEntry[];

	/** Total number of recorded entries. */
	readonly size: number;
}
