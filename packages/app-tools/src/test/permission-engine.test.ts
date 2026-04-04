import { describe, expect, it } from "vitest";
import { createPermissionEngine } from "../policy/permission-engine.js";
import type { PermissionContext, ToolPolicy } from "../types/index.js";
import type { ToolDefinition } from "../types/tool-definition.js";
import type { RiskLevel } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createPolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
	return {
		riskLevel: "L0",
		readOnly: true,
		concurrency: "unlimited",
		confirmation: "never",
		subAgentAllowed: true,
		timeoutMs: 0,
		...overrides,
	};
}

function createContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
	return {
		sessionId: "session-1",
		toolIdentity: { name: "test_tool", category: "file-read" },
		toolPolicy: createPolicy(),
		workingDirectory: "/project",
		sessionMode: "interactive",
		isSubAgent: false,
		toolCallId: "call_1",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PermissionEngine", () => {
	describe("L0 — auto-allow", () => {
		it("allows L0 tools without asking", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(createContext());

			expect(decision.verdict).toBe("allow");
			expect(decision.riskLevel).toBe("L0");
		});
	});

	describe("L1 — auto-allow with logging", () => {
		it("allows L1 tools and includes reason", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L1" }),
				}),
			);

			expect(decision.verdict).toBe("allow");
			expect(decision.riskLevel).toBe("L1");
			expect(decision.reason).toBe("Low-risk, logged");
		});
	});

	describe("L2/L3 — ask user when no cached approval", () => {
		it("asks user for L2 tools", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
				}),
			);

			expect(decision.verdict).toBe("ask_user");
			expect(decision.riskLevel).toBe("L2");
		});

		it("asks user for L3 tools", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L3" }),
				}),
			);

			expect(decision.verdict).toBe("ask_user");
		});

		it("mentions outside-cwd target in reason", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
					targetPath: "/etc/config",
					workingDirectory: "/project",
				}),
			);

			expect(decision.verdict).toBe("ask_user");
			expect(decision.reason).toContain("outside working directory");
		});
	});

	describe("L4 — default deny", () => {
		it("denies L4 tools without session approval", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L4" }),
				}),
			);

			expect(decision.verdict).toBe("deny");
			expect(decision.riskLevel).toBe("L4");
		});

		it("allows L4 tools when exact session-approved", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L4",
				targetPattern: "/project/target",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L4" }),
					targetPath: "/project/target",
				}),
			);

			expect(decision.verdict).toBe("allow");
			expect(decision.reason).toContain("Session-approved");
		});
	});

	describe("session approval cache", () => {
		it("allows L2 tool after session approval", () => {
			const engine = createPermissionEngine();

			// First call asks user
			const first = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(first.verdict).toBe("ask_user");

			// Simulate session approval
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			// Second call auto-allows
			const second = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(second.verdict).toBe("allow");
		});

		it("wildcard approval does NOT cover a specific target at L3", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L3",
				targetPattern: "*",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L3" }),
					targetPath: "/some/random/path",
				}),
			);

			// Wildcard should NOT match a specific target at L3
			expect(decision.verdict).toBe("ask_user");
		});

		it("clearApprovals resets the cache", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L2",
				targetPattern: "*",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			engine.clearApprovals();

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
				}),
			);
			expect(decision.verdict).toBe("ask_user");
		});
	});

	describe("cache key granularity", () => {
		it("L2 approval does not satisfy L3 for the same tool", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L3" }),
					targetPath: "/project/src/main.ts",
				}),
			);

			expect(decision.verdict).toBe("ask_user");
		});

		it("L3 approval for target A does not auto-allow target B", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L3",
				targetPattern: "/project/a.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L3" }),
					targetPath: "/project/b.ts",
				}),
			);

			expect(decision.verdict).toBe("ask_user");
		});

		it("commandDigest match grants approval", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "bash",
				riskLevel: "L3",
				targetPattern: "*",
				commandDigest: "sha256:abc123",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolIdentity: { name: "bash", category: "command-execution" },
					toolPolicy: createPolicy({ riskLevel: "L3" }),
					commandDigest: "sha256:abc123",
				}),
			);

			expect(decision.verdict).toBe("allow");
		});

		it("commandDigest mismatch does not grant approval", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "bash",
				riskLevel: "L3",
				targetPattern: "*",
				commandDigest: "sha256:abc123",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolIdentity: { name: "bash", category: "command-execution" },
					toolPolicy: createPolicy({ riskLevel: "L3" }),
					commandDigest: "sha256:different",
				}),
			);

			expect(decision.verdict).toBe("ask_user");
		});

		it("path normalization in cache key resolves '..' segments", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L2",
				targetPattern: "/project/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L2" }),
					targetPath: "/project/src/../main.ts",
				}),
			);

			expect(decision.verdict).toBe("allow");
		});

		it("session-scoped approval does not leak across sessions", () => {
			const engine = createPermissionEngine();
			engine.recordApproval({
				sessionId: "session-1",
				toolName: "test_tool",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			const decision = engine.evaluate(
				createContext({
					sessionId: "session-2",
					toolPolicy: createPolicy({ riskLevel: "L2" }),
					targetPath: "/project/src/main.ts",
				}),
			);

			expect(decision.verdict).toBe("ask_user");
		});
	});

	describe("sub-agent restrictions", () => {
		it("denies when sub-agent invokes a restricted tool", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L0", subAgentAllowed: false }),
					isSubAgent: true,
				}),
			);

			expect(decision.verdict).toBe("deny");
			expect(decision.reason).toContain("not allowed for sub-agents");
		});

		it("allows sub-agent when tool permits it", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L0", subAgentAllowed: true }),
					isSubAgent: true,
				}),
			);

			expect(decision.verdict).toBe("allow");
		});

		it("does not restrict non-sub-agent calls", () => {
			const engine = createPermissionEngine();
			const decision = engine.evaluate(
				createContext({
					toolPolicy: createPolicy({ riskLevel: "L0", subAgentAllowed: false }),
					isSubAgent: false,
				}),
			);

			expect(decision.verdict).toBe("allow");
		});
	});
});
