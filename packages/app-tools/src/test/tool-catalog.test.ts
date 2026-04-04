import { describe, expect, it } from "vitest";
import { createToolCatalog } from "../catalog/tool-catalog.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import type { RiskLevel } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestTool(overrides?: {
	name?: string;
	category?: string;
	riskLevel?: RiskLevel;
}): ToolDefinition {
	const name = overrides?.name ?? "test_tool";
	return {
		identity: { name, category: overrides?.category ?? "file-read" },
		contract: {
			parameterSchema: { type: "object", properties: {} },
			output: { type: "text" },
			errorTypes: [],
		},
		policy: {
			riskLevel: overrides?.riskLevel ?? "L0",
			readOnly: true,
			concurrency: "unlimited",
			confirmation: "never",
			subAgentAllowed: true,
			timeoutMs: 0,
		},
		executorTag: name,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolCatalog", () => {
	describe("register and get", () => {
		it("registers a tool and retrieves it by name", () => {
			const catalog = createToolCatalog();
			const tool = createTestTool({ name: "read" });

			catalog.register(tool);

			expect(catalog.get("read")).toBe(tool);
		});

		it("returns undefined for an unregistered tool", () => {
			const catalog = createToolCatalog();

			expect(catalog.get("nonexistent")).toBeUndefined();
		});

		it("throws when registering a duplicate name", () => {
			const catalog = createToolCatalog();
			catalog.register(createTestTool({ name: "read" }));

			expect(() => catalog.register(createTestTool({ name: "read" }))).toThrow(
				"Tool already registered: read",
			);
		});
	});

	describe("has", () => {
		it("returns true for a registered tool", () => {
			const catalog = createToolCatalog();
			catalog.register(createTestTool({ name: "glob" }));

			expect(catalog.has("glob")).toBe(true);
		});

		it("returns false for an unregistered tool", () => {
			const catalog = createToolCatalog();

			expect(catalog.has("missing")).toBe(false);
		});
	});

	describe("size", () => {
		it("returns 0 for an empty catalog", () => {
			const catalog = createToolCatalog();

			expect(catalog.size).toBe(0);
		});

		it("tracks the number of registered tools", () => {
			const catalog = createToolCatalog();
			catalog.register(createTestTool({ name: "read" }));
			catalog.register(createTestTool({ name: "edit" }));
			catalog.register(createTestTool({ name: "bash" }));

			expect(catalog.size).toBe(3);
		});
	});

	describe("getByCategory", () => {
		it("returns tools matching the category", () => {
			const catalog = createToolCatalog();
			const readTool = createTestTool({ name: "read", category: "file-read" });
			const globTool = createTestTool({ name: "glob", category: "file-read" });
			const editTool = createTestTool({ name: "edit", category: "file-mutation" });

			catalog.register(readTool);
			catalog.register(globTool);
			catalog.register(editTool);

			const result = catalog.getByCategory("file-read");

			expect(result).toHaveLength(2);
			expect(result).toContain(readTool);
			expect(result).toContain(globTool);
		});

		it("returns empty array for a category with no tools", () => {
			const catalog = createToolCatalog();

			expect(catalog.getByCategory("network")).toEqual([]);
		});
	});

	describe("listAll", () => {
		it("returns all registered tools", () => {
			const catalog = createToolCatalog();
			const t1 = createTestTool({ name: "a" });
			const t2 = createTestTool({ name: "b" });

			catalog.register(t1);
			catalog.register(t2);

			expect(catalog.listAll()).toHaveLength(2);
		});

		it("returns a snapshot — later registration does not mutate the result", () => {
			const catalog = createToolCatalog();
			catalog.register(createTestTool({ name: "a" }));

			const all = catalog.listAll();
			catalog.register(createTestTool({ name: "b" }));

			expect(all).toHaveLength(1);
		});
	});
});
