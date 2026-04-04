/**
 * AuditLog — in-memory, append-only record of all tool invocations.
 *
 * Every tool call is recorded with its outcome (success, failure, or denied).
 * The log supports querying by tool name, status, and full enumeration.
 * Entries are never removed; the log is session-scoped and in-memory.
 */

import type { AuditEntry, AuditLog, ToolResultStatus } from "../types/index.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuditLog(): AuditLog {
	const entries: AuditEntry[] = [];

	return {
		record(entry: AuditEntry): void {
			entries.push(entry);
		},

		getByTool(toolName: string): readonly AuditEntry[] {
			return entries.filter((e) => e.toolName === toolName);
		},

		getByStatus(status: ToolResultStatus): readonly AuditEntry[] {
			return entries.filter((e) => e.status === status);
		},

		getAll(): readonly AuditEntry[] {
			return [...entries];
		},

		get size(): number {
			return entries.length;
		},
	};
}
