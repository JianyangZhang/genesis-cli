import { describe, expect, it } from "vitest";
import { classifyRisk, isDestructiveCommand } from "../policy/risk-classifier.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import type { RiskLevel } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestTool(category: string, riskLevel: RiskLevel = "L0"): ToolDefinition {
	return {
		identity: { name: `test_${category}`, category },
		contract: {
			parameterSchema: { type: "object", properties: {} },
			output: { type: "text" },
			errorTypes: [],
		},
		policy: {
			riskLevel,
			readOnly: true,
			concurrency: "unlimited",
			confirmation: "never",
			subAgentAllowed: true,
			timeoutMs: 0,
		},
		executorTag: `test_${category}`,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyRisk", () => {
	describe("category-based defaults", () => {
		it("classifies file-read as L0", () => {
			expect(classifyRisk(createTestTool("file-read"))).toBe("L0");
		});

		it("classifies search as L0", () => {
			expect(classifyRisk(createTestTool("search"))).toBe("L0");
		});

		it("classifies diagnostics as L1", () => {
			expect(classifyRisk(createTestTool("diagnostics"))).toBe("L1");
		});

		it("classifies file-mutation as L2", () => {
			expect(classifyRisk(createTestTool("file-mutation"))).toBe("L2");
		});

		it("classifies network as L3", () => {
			expect(classifyRisk(createTestTool("network"))).toBe("L3");
		});

		it("classifies command-execution as L3", () => {
			expect(classifyRisk(createTestTool("command-execution"))).toBe("L3");
		});

		it("classifies mcp as L3", () => {
			expect(classifyRisk(createTestTool("mcp"))).toBe("L3");
		});

		it("classifies sub-agent as L3", () => {
			expect(classifyRisk(createTestTool("sub-agent"))).toBe("L3");
		});
	});

	describe("policy override", () => {
		it("uses the policy risk level when explicitly set", () => {
			const tool = createTestTool("file-read", "L3");
			expect(classifyRisk(tool)).toBe("L3");
		});
	});

	describe("destructive command escalation", () => {
		it("escalates rm -rf to L4", () => {
			const tool = createTestTool("command-execution");
			expect(classifyRisk(tool, { command: "rm -rf /tmp/data" })).toBe("L4");
		});

		it("escalates git push --force to L4", () => {
			const tool = createTestTool("command-execution");
			expect(classifyRisk(tool, { command: "git push origin main --force" })).toBe("L4");
		});

		it("does not escalate non-destructive commands", () => {
			const tool = createTestTool("command-execution");
			expect(classifyRisk(tool, { command: "ls -la" })).toBe("L3");
		});

		it("does not escalate non-command-execution tools", () => {
			const tool = createTestTool("file-read");
			expect(classifyRisk(tool, { command: "rm -rf /" })).toBe("L0");
		});
	});
});

describe("isDestructiveCommand", () => {
	it("detects rm -rf", () => {
		expect(isDestructiveCommand("rm -rf /")).toBe(true);
	});

	it("detects git push --force", () => {
		expect(isDestructiveCommand("git push --force origin main")).toBe(true);
	});

	it("detects git reset --hard", () => {
		expect(isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
	});

	it("does not flag safe commands", () => {
		expect(isDestructiveCommand("echo hello")).toBe(false);
		expect(isDestructiveCommand("npm test")).toBe(false);
	});
});
