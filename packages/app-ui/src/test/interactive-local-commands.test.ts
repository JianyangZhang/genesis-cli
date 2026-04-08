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

function createMockRuntimeWithSessions(sessions: readonly SessionFacade[]): AppRuntime {
	let index = 0;
	return {
		createSession: () => {
			const next = sessions[Math.min(index, sessions.length - 1)];
			index += 1;
			if (!next) {
				throw new Error("No session configured");
			}
			return next;
		},
		recoverSession: () => sessions[0]!,
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
		getDefaultModel: () => sessions[0]!.state.model,
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
			getCurrentSession: () => createMockSession(),
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});

		expect(cmds.map((cmd) => cmd.name).sort()).toEqual(["clear", "exit", "help", "quit", "status", "title"]);
	});

	it("/status renders session state and next-step guidance", async () => {
		const session = createMockSession({
			planSummary: { stepCount: 5, completedSteps: 2 },
			compactionSummary: { estimatedTokensSaved: 128, completedAt: Date.now() },
			taskState: { status: "running", currentTaskId: "task-7", startedAt: Date.now() - 1_000 },
		});
		(session.context as SessionFacade["context"]) = {
			workingDirectory: "/repo",
		} as SessionFacade["context"];
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => "network timeout",
			getChangedFileCount: () => 3,
			getPendingPermissionCallId: () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "status")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Session: interactive-session-1");
		expect(output.lines).toContain("  CWD: /repo");
		expect(output.lines).toContain("  Agent dir: /agent");
		expect(output.lines).toContain("  Model: GLM 5.1");
		expect(output.lines).toContain("  Provider: zai");
		expect(output.lines).toContain("  Phase: idle");
		expect(output.lines).toContain("  Task: running (task-7)");
		expect(output.lines).toContain("  Tools: read");
		expect(output.lines).toContain("  Plan: 2/5");
		expect(output.lines).toContain("  Last compaction: 128 tokens saved");
		expect(output.lines).toContain("  Last error: network timeout");
		expect(output.lines).toContain("  Changed files: 3");
		expect(output.lines).toContain("Next:");
		expect(output.lines).toContain("  /review to inspect changes, or /diff <file>");
	});

	it("/title updates the session title through injected state", async () => {
		let title: string | undefined;
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: (next) => {
				title = next;
			},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "title")!.execute!(createContext(session, runtime, output, "My Session"));

		expect(title).toBe("My Session");
		expect(output.lines).toContain("Title: My Session");
	});

	it("/help renders groups from the registry", async () => {
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		for (const cmd of cmds) {
			registry.register(cmd);
		}
		registry.register({ name: "ask", description: "Ask the model", type: "prompt", visibility: "public" });
		registry.register({ name: "panel", description: "Open UI panel", type: "ui", visibility: "public" });
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "help")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Commands:");
		expect(output.lines).toContain("\nLocal (5):");
		expect(output.lines).toContain("\nPrompt (1):");
		expect(output.lines).toContain("\nUI (1):");
		expect(output.lines).toContain("  /help — Show available commands");
		expect(output.lines).toContain("  /ask — Ask the model");
		expect(output.lines).toContain("  /panel — Open UI panel");
	});

	it("/help reports unknown commands with a suggestion to retry", async () => {
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		for (const cmd of cmds) {
			registry.register(cmd);
		}
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "help")!.execute!(createContext(session, runtime, output, "missing"));

		expect(output.errors).toEqual(["Unknown command: /missing"]);
		expect(output.lines).toContain("Type /help to see all commands.");
	});

	it.each(["exit", "quit"] as const)("/%s requests an interactive exit", async (name) => {
		const requestExit = vi.fn();
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit,
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === name)!.execute!(createContext(session, runtime, output));

		expect(requestExit).toHaveBeenCalledTimes(1);
		expect(output.lines).toContain("Bye.");
	});

	it("/clear blocks when the interaction is busy", async () => {
		const session = createMockSession();
		const runtime = createMockRuntime(session);
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => session,
			getSessionTitle: () => "Busy session",
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => true,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "clear")!.execute!(createContext(session, runtime, output));

		expect(output.errors).toEqual(["Session is busy."]);
	});

	it("/clear starts a fresh session and reports the previous session title", async () => {
		const replaceSession = vi.fn();
		const close = vi.fn(async () => {});
		const previousSession = {
			...createMockSession({ id: { value: "session-before-clear" } as SessionId }),
			close,
		} as SessionFacade;
		const nextSession = createMockSession({ id: { value: "session-after-clear" } as SessionId });
		const registry = createSlashCommandRegistry();
		const cmds = createInteractiveLocalCommands({
			registry,
			getCurrentSession: () => previousSession,
			getSessionTitle: () => "Planning",
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession,
			getAgentDir: () => "/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
		});
		const output = createMockOutputSink();
		const runtime = createMockRuntimeWithSessions([nextSession]);

		await cmds.find((cmd) => cmd.name === "clear")!.execute!(createContext(previousSession, runtime, output));

		expect(close).toHaveBeenCalledTimes(1);
		expect(replaceSession).toHaveBeenCalledWith(nextSession);
		expect(output.lines).toContain("Started a new session: session-after-clear");
		expect(output.lines).toContain("Previous session saved: session-before-clear — Planning");
		expect(output.lines).toContain("Next: type a prompt, or /resume <sessionId|#N|title> to return.");
	});
});
