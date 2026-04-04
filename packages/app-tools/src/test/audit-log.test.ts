import { describe, expect, it } from "vitest";
import { createAuditLog } from "../audit/audit-log.js";
import type { AuditEntry } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let nextId = 1;

function createEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
	return {
		id: `audit_${nextId++}`,
		toolCallId: overrides.toolCallId ?? "call_1",
		toolName: overrides.toolName ?? "read",
		category: overrides.category ?? "file-read",
		status: overrides.status ?? "success",
		riskLevel: overrides.riskLevel ?? "L0",
		startedAt: overrides.startedAt ?? 1000,
		completedAt: overrides.completedAt ?? 1100,
		durationMs: overrides.durationMs ?? 100,
		targetPath: overrides.targetPath,
		error: overrides.error,
		permissionDecision: overrides.permissionDecision,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditLog", () => {
	describe("record", () => {
		it("records a successful tool invocation", () => {
			const log = createAuditLog();
			const entry = createEntry({ toolName: "read", status: "success" });

			log.record(entry);

			expect(log.size).toBe(1);
			expect(log.getAll()).toContain(entry);
		});

		it("records a failed tool invocation", () => {
			const log = createAuditLog();
			const entry = createEntry({
				toolName: "edit",
				status: "failure",
				error: "File not found",
			});

			log.record(entry);

			expect(log.size).toBe(1);
		});

		it("records a denied tool invocation", () => {
			const log = createAuditLog();
			const entry = createEntry({
				toolName: "bash",
				status: "denied",
				permissionDecision: "deny",
			});

			log.record(entry);

			expect(log.size).toBe(1);
		});

		it("appends multiple entries in order", () => {
			const log = createAuditLog();
			const e1 = createEntry({ toolCallId: "c1", completedAt: 1000 });
			const e2 = createEntry({ toolCallId: "c2", completedAt: 2000 });
			const e3 = createEntry({ toolCallId: "c3", completedAt: 3000 });

			log.record(e1);
			log.record(e2);
			log.record(e3);

			const all = log.getAll();
			expect(all).toHaveLength(3);
			expect(all[0]).toBe(e1);
			expect(all[1]).toBe(e2);
			expect(all[2]).toBe(e3);
		});
	});

	describe("getByTool", () => {
		it("filters entries by tool name", () => {
			const log = createAuditLog();
			log.record(createEntry({ toolName: "read" }));
			log.record(createEntry({ toolName: "edit" }));
			log.record(createEntry({ toolName: "read" }));

			const reads = log.getByTool("read");

			expect(reads).toHaveLength(2);
			expect(reads.every((e) => e.toolName === "read")).toBe(true);
		});

		it("returns empty array for unknown tool", () => {
			const log = createAuditLog();

			expect(log.getByTool("nonexistent")).toEqual([]);
		});
	});

	describe("getByStatus", () => {
		it("filters entries by status", () => {
			const log = createAuditLog();
			log.record(createEntry({ status: "success" }));
			log.record(createEntry({ status: "failure" }));
			log.record(createEntry({ status: "denied" }));
			log.record(createEntry({ status: "success" }));

			const successes = log.getByStatus("success");
			const failures = log.getByStatus("failure");
			const denials = log.getByStatus("denied");

			expect(successes).toHaveLength(2);
			expect(failures).toHaveLength(1);
			expect(denials).toHaveLength(1);
		});

		it("returns empty array when no entries match", () => {
			const log = createAuditLog();
			log.record(createEntry({ status: "success" }));

			expect(log.getByStatus("denied")).toEqual([]);
		});
	});

	describe("getAll", () => {
		it("returns a snapshot that is not affected by later records", () => {
			const log = createAuditLog();
			log.record(createEntry());

			const snapshot = log.getAll();
			log.record(createEntry());

			expect(snapshot).toHaveLength(1);
			expect(log.getAll()).toHaveLength(2);
		});
	});

	describe("size", () => {
		it("returns 0 for an empty log", () => {
			const log = createAuditLog();

			expect(log.size).toBe(0);
		});
	});
});
