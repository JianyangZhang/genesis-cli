/**
 * Tests for built-in slash commands.
 */

import type { AppRuntime, SessionFacade, SessionId, SessionState } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import { createBuiltinCommands } from "../domain/builtin-commands.js";
import type { OutputSink, SlashCommandContext, SlashCommandHost } from "../types/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockOutputSink(): { lines: string[]; errors: string[] } & OutputSink {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		lines,
		errors,
		write(text: string) {
			lines.push(text);
		},
		writeLine(text: string) {
			lines.push(text);
		},
		writeError(text: string) {
			errors.push(text);
		},
	};
}

function createMockSession(overrides?: Partial<SessionState>): SessionFacade {
	const state: SessionState = {
		id: { value: "test-session-1" } as SessionId,
		status: "active",
		createdAt: Date.now() - 60000,
		updatedAt: Date.now(),
		model: { id: "claude-3-sonnet", provider: "anthropic", displayName: "Claude 3 Sonnet" },
		toolSet: new Set(["read_file", "write_file", "bash"]),
		planSummary: null,
		compactionSummary: null,
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
		...overrides,
	};

	return {
		id: state.id,
		get state() {
			return state;
		},
		context: {} as unknown as SessionFacade["context"],
		events: {} as unknown as SessionFacade["events"],
		plan: null,
		prompt: async () => {},
		continue: async () => {},
		abort: () => {},
		close: async () => {},
		switchModel: async () => {},
		onStateChange: () => {},
		compact: async () => {},
	} as unknown as SessionFacade;
}

function createMockRuntime(session: SessionFacade): AppRuntime {
	return {
		createSession: () => session,
		recoverSession: () => session,
		createSessionEngine: () => ({
			activeSession: session,
			createSession: () => session,
			recoverSession: async () => session,
			listSessions: () => [session],
			getSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			selectSession: () => session,
			isBusy: () => false,
			submit: async () => {},
			resolvePermission: async () => {},
			closeSession: async () => session,
			closeAllSessions: async () => {},
			dispose: () => {},
		}),
		events: {} as AppRuntime["events"],
		governor: {
			catalog: {
				listAll: () => [],
				get: () => undefined,
				register: () => {},
				getByCategory: () => [],
				has: () => false,
				size: 0,
			},
		} as unknown as AppRuntime["governor"],
		planEngine: {} as AppRuntime["planEngine"],
		recordRecentSession: async () => {},
		recordClosedRecentSession: async () => {},
		recordRecentSessionInput: async () => {},
		recordRecentSessionAssistantText: async () => {},
		recordRecentSessionEvent: async () => {},
		listRecentSessions: async () => [],
		searchRecentSessions: async () => [],
		pruneRecentSessions: async () => ({ before: 0, after: 0, removed: 0 }),
		getDefaultModel: () => session.state.model,
		setDefaultModel: () => {},
		shutdown: async () => {},
	};
}

function createContext(
	session: SessionFacade,
	runtime: AppRuntime,
	output: OutputSink,
	args = "",
	host?: SlashCommandHost,
): SlashCommandContext {
	return { args, runtime, session, output, host };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBuiltinCommands", () => {
	it("returns 5 commands", () => {
		const cmds = createBuiltinCommands();
		expect(cmds).toHaveLength(5);
		const names = cmds.map((c) => c.name).sort();
		expect(names).toEqual(["compact", "model", "plan", "session", "tools"]);
	});
});

describe("/model command", () => {
	it("displays current model when no args", async () => {
		const cmds = createBuiltinCommands();
		const model = cmds.find((c) => c.name === "model")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		await model.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("Claude 3 Sonnet"))).toBe(true);
		expect(output.lines.some((l) => l.includes("anthropic"))).toBe(true);
	});

	it("switches the model via the host when args are provided", async () => {
		const cmds = createBuiltinCommands();
		const model = cmds.find((c) => c.name === "model")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const host: SlashCommandHost = {
			switchModel: async () => ({
				model: { id: "gpt-4", provider: "openai", displayName: "GPT-4" },
				persistedTo: "/tmp/settings.json",
			}),
		};
		await model.execute!(createContext(session, runtime, output, "gpt-4", host));
		expect(output.lines).toContain("Current model: GPT-4");
		expect(output.lines).toContain("  Provider: openai");
		expect(output.lines).toContain("  Persisted to: /tmp/settings.json");
	});
});

describe("/session command", () => {
	it("displays session information", async () => {
		const cmds = createBuiltinCommands();
		const cmd = cmds.find((c) => c.name === "session")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		await cmd.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("test-session-1"))).toBe(true);
		expect(output.lines.some((l) => l.includes("active"))).toBe(true);
		expect(output.lines.some((l) => l.includes("Claude 3 Sonnet"))).toBe(true);
	});
});

describe("/tools command", () => {
	it("shows no tools message when empty", async () => {
		const cmds = createBuiltinCommands();
		const cmd = cmds.find((c) => c.name === "tools")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		await cmd.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("No tools registered"))).toBe(true);
	});
});

describe("/plan command", () => {
	it("shows no plan message when null", async () => {
		const cmds = createBuiltinCommands();
		const cmd = cmds.find((c) => c.name === "plan")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		await cmd.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("No active plan"))).toBe(true);
	});

	it("shows plan summary when active", async () => {
		const cmds = createBuiltinCommands();
		const cmd = cmds.find((c) => c.name === "plan")!;
		const output = createMockOutputSink();
		const session = createMockSession({
			planSummary: {
				planId: "p-1",
				goal: "fix the critical bug",
				status: "active",
				stepCount: 5,
				completedSteps: 2,
			},
		} as Partial<SessionState>);
		const runtime = createMockRuntime(session);
		await cmd.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("fix the critical bug"))).toBe(true);
		expect(output.lines.some((l) => l.includes("2/5"))).toBe(true);
	});
});

describe("/compact command", () => {
	it("outputs compaction message", async () => {
		const cmds = createBuiltinCommands();
		const cmd = cmds.find((c) => c.name === "compact")!;
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		await cmd.execute!(createContext(session, runtime, output));
		expect(output.lines.some((l) => l.includes("Compaction completed"))).toBe(true);
	});
});
