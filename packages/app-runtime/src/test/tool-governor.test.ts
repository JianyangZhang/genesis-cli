import type { ToolDefinition } from "@genesis-cli/tools";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../governance/tool-governor.js";
import { createToolGovernor } from "../governance/tool-governor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeToolDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		identity: {
			name: "test_tool",
			category: "file-read",
		},
		contract: {
			parameterSchema: { type: "object", properties: {} },
			output: { type: "text" },
			errorTypes: [],
		},
		policy: {
			riskLevel: "L0",
			readOnly: true,
			concurrency: "unlimited",
			confirmation: "never",
			subAgentAllowed: true,
			timeoutMs: 0,
		},
		executorTag: "test_tool",
		...overrides,
	};
}

const L0_READ = makeToolDef();
const L2_EDIT = makeToolDef({
	identity: { name: "edit", category: "file-mutation" },
	policy: {
		riskLevel: "L2",
		readOnly: false,
		concurrency: "per_target",
		confirmation: "on_write",
		subAgentAllowed: true,
		timeoutMs: 30_000,
	},
	executorTag: "edit",
});
const L3_BASH = makeToolDef({
	identity: { name: "bash", category: "command-execution" },
	policy: {
		riskLevel: "L3",
		readOnly: false,
		concurrency: "unlimited",
		confirmation: "always",
		subAgentAllowed: false,
		timeoutMs: 120_000,
	},
	executorTag: "bash",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolGovernor", () => {
	function executionContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
		return {
			sessionId: "session-1",
			toolName: "test_tool",
			toolCallId: "call_1",
			workingDirectory: "/project",
			sessionMode: "interactive",
			isSubAgent: false,
			...overrides,
		};
	}

	describe("beforeExecution", () => {
		it("allows a registered L0 tool", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L0_READ);

			const decision = governor.beforeExecution(executionContext());

			expect(decision.type).toBe("allow");
		});

		it("denies an unregistered tool", () => {
			const governor = createToolGovernor();

			const decision = governor.beforeExecution(executionContext({ toolName: "unknown_tool" }));

			expect(decision.type).toBe("deny");
			if (decision.type === "deny") {
				expect(decision.reason).toContain("not registered");
			}
		});

		it("returns ask_user for L2 tool without prior approval", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L2_EDIT);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					targetPath: "/project/src/main.ts",
				}),
			);

			expect(decision.type).toBe("ask_user");
			if (decision.type === "ask_user") {
				expect(decision.riskLevel).toBe("L2");
			}
		});

		it("denies when mutation queue has conflict for per_target tool", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L2_EDIT);

			// First call: approve via session approval
			governor.recordSessionApproval({
				sessionId: "session-1",
				toolName: "edit",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			// First execution: accepted
			const first = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					toolCallId: "call_1",
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(first.type).toBe("allow");

			// Second execution to same file: conflict
			const second = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					toolCallId: "call_2",
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(second.type).toBe("deny");
			if (second.type === "deny") {
				expect(second.reason).toContain("already being mutated");
			}
		});

		it("denies sub-agent restricted tool", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "bash",
					isSubAgent: true,
				}),
			);

			expect(decision.type).toBe("deny");
		});

		it("mentions outside-cwd paths using the real working directory", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L2_EDIT);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					targetPath: "/etc/passwd",
				}),
			);

			expect(decision.type).toBe("ask_user");
			if (decision.type === "ask_user") {
				expect(decision.reason).toContain("outside working directory");
			}
		});

		it("escalates destructive commands to L4 before permission evaluation", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "bash",
					parameters: { command: "rm -rf /tmp/danger" },
				}),
			);

			expect(decision.type).toBe("deny");
			if (decision.type === "deny") {
				expect(decision.riskLevel).toBe("L4");
			}
		});

		it("auto-allows read-only pwd commands for bash", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "bash",
					parameters: { command: "pwd -P" },
				}),
			);

			expect(decision.type).toBe("allow");
		});

		it("auto-allows read-only ls commands for bash", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "bash",
					parameters: { command: "ls -lah src" },
				}),
			);

			expect(decision.type).toBe("allow");
		});

		it("auto-allows common readonly bash commands", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const commands = [
				"cat README.md",
				"head -n 10 README.md",
				'tail -f "logs/app.log"',
				"wc -l src/index.ts",
				'grep -n "Genesis CLI" README.md',
				'rg -n --glob "*.ts" "createToolGovernor" packages',
			];

			for (const command of commands) {
				const decision = governor.beforeExecution(
					executionContext({
						toolName: "bash",
						toolCallId: `call_${command}`,
						parameters: { command },
					}),
				);
				expect(decision.type).toBe("allow");
			}
		});

		it("still asks for non-allowlisted bash commands", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const decision = governor.beforeExecution(
				executionContext({
					toolName: "bash",
					parameters: { command: "echo hello" },
				}),
			);

			expect(decision.type).toBe("ask_user");
		});

		it("still asks for risky ripgrep forms even though rg is readonly by default", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L3_BASH);

			const commands = ['rg --pre "bash" foo', 'rg "$PATTERN" src'];
			for (const command of commands) {
				const decision = governor.beforeExecution(
					executionContext({
						toolName: "bash",
						toolCallId: `call_${command}`,
						parameters: { command },
					}),
				);
				expect(decision.type).toBe("ask_user");
			}
		});
	});

	describe("afterExecution", () => {
		it("records in audit log", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L0_READ);

			governor.beforeExecution(executionContext());

			governor.afterExecution({
				toolName: "test_tool",
				toolCallId: "call_1",
				status: "success",
				durationMs: 100,
			});

			expect(governor.audit.size).toBe(1);
			const entries = governor.audit.getByTool("test_tool");
			expect(entries).toHaveLength(1);
			expect(entries[0]!.status).toBe("success");
			expect(entries[0]!.toolCallId).toBe("call_1");
		});

		it("releases mutation queue entry for per_target tool", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L2_EDIT);

			governor.recordSessionApproval({
				sessionId: "session-1",
				toolName: "edit",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			// First execution
			governor.beforeExecution(
				executionContext({
					toolName: "edit",
					toolCallId: "call_1",
					targetPath: "/project/src/main.ts",
				}),
			);

			expect(governor.mutations.isPending("/project/src/main.ts")).toBe(true);

			// Complete the first execution
			governor.afterExecution({
				toolName: "edit",
				toolCallId: "call_1",
				status: "success",
				durationMs: 100,
			});

			expect(governor.mutations.isPending("/project/src/main.ts")).toBe(false);

			// Second execution should now succeed
			const second = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					toolCallId: "call_2",
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(second.type).toBe("allow");
		});
	});

	describe("recordSessionApproval", () => {
		it("enables subsequent allow for L2 tool", () => {
			const governor = createToolGovernor();
			governor.catalog.register(L2_EDIT);

			// Without approval: ask_user
			const first = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(first.type).toBe("ask_user");

			// Record approval
			governor.recordSessionApproval({
				sessionId: "session-1",
				toolName: "edit",
				riskLevel: "L2",
				targetPattern: "/project/src/main.ts",
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});

			// With approval: allow
			const second = governor.beforeExecution(
				executionContext({
					toolName: "edit",
					toolCallId: "call_2",
					targetPath: "/project/src/main.ts",
				}),
			);
			expect(second.type).toBe("allow");
		});
	});

	describe("governance components", () => {
		it("exposes catalog, permissions, mutations, and audit", () => {
			const governor = createToolGovernor();

			expect(governor.catalog).toBeDefined();
			expect(governor.permissions).toBeDefined();
			expect(governor.mutations).toBeDefined();
			expect(governor.audit).toBeDefined();
		});
	});
});
