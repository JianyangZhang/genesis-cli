import type { AppRuntime, SessionFacade, SessionId, SessionState } from "@pickle-pee/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInteractiveLocalCommands } from "../domain/interactive-local-commands.js";
import { createSlashCommandRegistry } from "../domain/slash-command-registry.js";
import type { OutputSink, SlashCommandContext } from "../types/index.js";

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
		id: { value: "interactive-session-1" } as SessionId,
		status: "active",
		createdAt: Date.now() - 1000,
		updatedAt: Date.now(),
		model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
		toolSet: new Set(["read"]),
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
		context: {} as SessionFacade["context"],
		events: {} as SessionFacade["events"],
		plan: null,
		prompt: async () => {},
		continue: async () => {},
		abort: () => {},
		close: async () => {},
		switchModel: async () => {},
		onStateChange: () => () => {},
		compact: async () => {},
	} as unknown as SessionFacade;
}

function createMockRuntime(session: SessionFacade): AppRuntime {
	return {
		createSession: () => session,
		recoverSession: () => session,
		events: {} as AppRuntime["events"],
		governor: {} as AppRuntime["governor"],
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
): SlashCommandContext {
	return { args, runtime, session, output };
}

describe("createInteractiveLocalCommands", () => {
	it("creates the expected interactive command set", () => {
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			setSessionTitle: () => {},
			requestExit: () => {},
		});

		expect(cmds.map((cmd) => cmd.name).sort()).toEqual(["exit", "help", "quit", "title"]);
	});

	it("/title updates the session title through injected state", async () => {
		let title: string | undefined;
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			setSessionTitle: (next) => {
				title = next;
			},
			requestExit: () => {},
		});
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);

		await cmds.find((cmd) => cmd.name === "title")!.execute!(createContext(session, runtime, output, "My Session"));

		expect(title).toBe("My Session");
		expect(output.lines).toContain("Title: My Session");
	});

	it("/help renders groups from the registry", async () => {
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			setSessionTitle: () => {},
			requestExit: () => {},
		});
		for (const cmd of cmds) {
			registry.register(cmd);
		}
		registry.register({ name: "ask", description: "Ask the model", type: "prompt", visibility: "public" });
		registry.register({ name: "panel", description: "Open UI panel", type: "ui", visibility: "public" });
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);

		await cmds.find((cmd) => cmd.name === "help")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Commands:");
		expect(output.lines).toContain("\nLocal (3):");
		expect(output.lines).toContain("\nPrompt (1):");
		expect(output.lines).toContain("\nUI (1):");
		expect(output.lines).toContain("  /help — Show available commands");
		expect(output.lines).toContain("  /ask — Ask the model");
		expect(output.lines).toContain("  /panel — Open UI panel");
	});

	it("/help reports unknown commands with a suggestion to retry", async () => {
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			setSessionTitle: () => {},
			requestExit: () => {},
		});
		for (const cmd of cmds) {
			registry.register(cmd);
		}
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);

		await cmds.find((cmd) => cmd.name === "help")!.execute!(createContext(session, runtime, output, "missing"));

		expect(output.errors).toEqual(["Unknown command: /missing"]);
		expect(output.lines).toContain("Type /help to see all commands.");
	});

	it.each(["exit", "quit"] as const)("/%s requests an interactive exit", async (name) => {
		const requestExit = vi.fn();
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			setSessionTitle: () => {},
			requestExit,
		});
		const output = createMockOutputSink();
		const session = createMockSession();
		const runtime = createMockRuntime(session);

		await cmds.find((cmd) => cmd.name === name)!.execute!(createContext(session, runtime, output));

		expect(requestExit).toHaveBeenCalledTimes(1);
		expect(output.lines).toContain("Bye.");
	});
});
