import { describe, expect, it } from "vitest";
import { createMutationQueue } from "../mutation-queue/mutation-queue.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MutationQueue", () => {
	describe("enqueue", () => {
		it("accepts a mutation for a file with no pending mutations", () => {
			const queue = createMutationQueue();
			const result = queue.enqueue({
				filePath: "/project/src/main.ts",
				toolCallId: "call_1",
			});

			expect(result.type).toBe("accepted");
			if (result.type === "accepted") {
				expect(result.position).toBe(0);
			}
		});

		it("rejects a second mutation to the same file", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/src/main.ts", toolCallId: "call_1" });

			const result = queue.enqueue({
				filePath: "/project/src/main.ts",
				toolCallId: "call_2",
			});

			expect(result.type).toBe("conflict");
			if (result.type === "conflict") {
				expect(result.filePath).toBe("/project/src/main.ts");
				expect(result.conflictingCallId).toBe("call_1");
			}
		});

		it("accepts concurrent mutations to different files", () => {
			const queue = createMutationQueue();
			const r1 = queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });
			const r2 = queue.enqueue({ filePath: "/project/b.ts", toolCallId: "call_2" });

			expect(r1.type).toBe("accepted");
			expect(r2.type).toBe("accepted");
		});
	});

	describe("complete", () => {
		it("removes a completed mutation, allowing the next one", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/main.ts", toolCallId: "call_1" });
			queue.complete("call_1");

			const result = queue.enqueue({ filePath: "/project/main.ts", toolCallId: "call_2" });
			expect(result.type).toBe("accepted");
		});

		it("does nothing for an unknown toolCallId", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });

			// Should not throw
			queue.complete("nonexistent");

			expect(queue.isPending("/project/a.ts")).toBe(true);
		});

		it("only releases the file associated with the completed call", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });
			queue.enqueue({ filePath: "/project/b.ts", toolCallId: "call_2" });

			queue.complete("call_1");

			expect(queue.isPending("/project/a.ts")).toBe(false);
			expect(queue.isPending("/project/b.ts")).toBe(true);
		});
	});

	describe("isPending", () => {
		it("returns true when a mutation is active for the file", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });

			expect(queue.isPending("/project/a.ts")).toBe(true);
		});

		it("returns false when no mutation is active", () => {
			const queue = createMutationQueue();

			expect(queue.isPending("/project/a.ts")).toBe(false);
		});

		it("returns false after the mutation is completed", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });
			queue.complete("call_1");

			expect(queue.isPending("/project/a.ts")).toBe(false);
		});
	});

	describe("getActive", () => {
		it("returns the active mutation for a file", () => {
			const queue = createMutationQueue();
			const target = { filePath: "/project/a.ts", toolCallId: "call_1" };
			queue.enqueue(target);

			expect(queue.getActive("/project/a.ts")).toEqual(target);
		});

		it("returns undefined when no mutation is active", () => {
			const queue = createMutationQueue();

			expect(queue.getActive("/project/a.ts")).toBeUndefined();
		});
	});

	describe("length", () => {
		it("tracks the number of active mutations", () => {
			const queue = createMutationQueue();

			expect(queue.length).toBe(0);

			queue.enqueue({ filePath: "/project/a.ts", toolCallId: "call_1" });
			expect(queue.length).toBe(1);

			queue.enqueue({ filePath: "/project/b.ts", toolCallId: "call_2" });
			expect(queue.length).toBe(2);

			queue.complete("call_1");
			expect(queue.length).toBe(1);
		});
	});

	describe("path normalization", () => {
		it("detects conflict when same file is referenced via '..' segment", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/main.ts", toolCallId: "call_1" });

			const result = queue.enqueue({ filePath: "/project/src/../main.ts", toolCallId: "call_2" });

			expect(result.type).toBe("conflict");
			if (result.type === "conflict") {
				expect(result.conflictingCallId).toBe("call_1");
			}
		});

		it("detects conflict when same file is referenced via '.' segment", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/src/main.ts", toolCallId: "call_1" });

			const result = queue.enqueue({ filePath: "/project/./src/./main.ts", toolCallId: "call_2" });

			expect(result.type).toBe("conflict");
		});

		it("detects conflict when same file has repeated slashes", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/src/main.ts", toolCallId: "call_1" });

			const result = queue.enqueue({ filePath: "//project//src//main.ts", toolCallId: "call_2" });

			expect(result.type).toBe("conflict");
		});

		it("isPending resolves '..' paths to the correct file", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/src/main.ts", toolCallId: "call_1" });

			expect(queue.isPending("/project/src/../src/main.ts")).toBe(true);
		});

		it("getActive resolves '..' paths to the correct entry", () => {
			const queue = createMutationQueue();
			const target = { filePath: "/project/src/main.ts", toolCallId: "call_1" };
			queue.enqueue(target);

			expect(queue.getActive("/project/src/../src/main.ts")).toEqual(target);
		});

		it("complete by toolCallId releases the file regardless of path variant", () => {
			const queue = createMutationQueue();
			queue.enqueue({ filePath: "/project/src/main.ts", toolCallId: "call_1" });

			queue.complete("call_1");

			// Should be able to enqueue via a different path representation
			const result = queue.enqueue({ filePath: "/project/src/../src/main.ts", toolCallId: "call_2" });
			expect(result.type).toBe("accepted");
		});
	});
});
