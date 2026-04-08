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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});

		expect(cmds.map((cmd) => cmd.name).sort()).toEqual([
			"changes",
			"clear",
			"config",
			"diff",
			"doctor",
			"exit",
			"help",
			"quit",
			"review",
			"status",
			"title",
			"usage",
		]);
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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

	it("/changes renders the shared working-tree summary and next steps", async () => {
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
			getChangedFileCount: () => 1,
			getPendingPermissionCallId: () => null,
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({
				changedPaths: ["src/main.ts"],
				snapshot: {
					available: true,
					statusLines: ["M src/main.ts"],
					diffStatLines: ["src/main.ts | 2 +-"],
				},
			}),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "changes")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Working tree:");
		expect(output.lines).toContain("Changed files (observed by tools):");
		expect(output.lines).toContain("  src/main.ts");
		expect(output.lines).toContain("git status --porcelain:");
		expect(output.lines).toContain("  M src/main.ts");
		expect(output.lines).toContain("git diff --stat:");
		expect(output.lines).toContain("  src/main.ts | 2 +-");
		expect(output.lines).toContain("Next: /review to inspect, or /diff [file] to see patches.");
	});

	it("/review renders review guidance on top of the shared working-tree summary", async () => {
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
			getChangedFileCount: () => 1,
			getPendingPermissionCallId: () => null,
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({
				changedPaths: ["src/main.ts"],
				snapshot: {
					available: true,
					statusLines: ["M src/main.ts"],
					diffStatLines: ["src/main.ts | 2 +-"],
				},
			}),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "review")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Working tree:");
		expect(output.lines).toContain("Review tips:");
		expect(output.lines).toContain("  /diff <file>   Inspect a specific patch");
		expect(output.lines).toContain("  Use git manually if you want to discard changes");
		expect(output.lines).toContain("Next: inspect diffs, then continue chatting.");
	});

	it("/review reports a clean working tree when there are no changes", async () => {
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({
				changedPaths: [],
				snapshot: {
					available: true,
					statusLines: [],
					diffStatLines: [],
				},
			}),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "review")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toEqual([
			"Review: clean working tree.",
			"Next: continue chatting, or /changes if you want a snapshot.",
		]);
	});

	it("/diff renders a file-scoped patch and next step guidance", async () => {
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
			getChangedFileCount: () => 1,
			getPendingPermissionCallId: () => null,
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({
				type: "ok",
				stdout: "--- a/notes.txt\n+++ b/notes.txt\n@@\n-hello\n+hello changed\n",
			}),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "diff")!.execute!(createContext(session, runtime, output, "notes.txt"));

		expect(output.lines).toContain("Diff: notes.txt");
		expect(output.lines).toContain("--- a/notes.txt\n+++ b/notes.txt\n@@\n-hello\n+hello changed");
		expect(output.lines).toContain("Next: /review to see a summary, or keep iterating.");
	});

	it("/doctor renders provider configuration and probe results", async () => {
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => ({
				providerKey: "zai",
				api: "openai-completions",
				baseUrl: "https://api.example.com",
				apiKeyEnv: "GENESIS_API_KEY",
				apiKeyPresent: true,
				httpStatus: 200,
				responseText: "DOCTOR_OK",
			}),
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "doctor")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("provider: zai");
		expect(output.lines).toContain("  api: openai-completions");
		expect(output.lines).toContain("  baseUrl: https://api.example.com");
		expect(output.lines).toContain("  apiKey env: GENESIS_API_KEY (set)");
		expect(output.lines).toContain("  http: 200");
		expect(output.lines).toContain("  response: DOCTOR_OK");
	});

	it("/usage renders audit summary and recent entries", async () => {
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
			getToolUsageSummary: () => ({
				total: 4,
				success: 2,
				failure: 1,
				denied: 1,
				recent: [
					{ status: "success", toolName: "read", riskLevel: "low", targetPath: "/tmp/a.ts", durationMs: 12 },
					{ status: "denied", toolName: "write", riskLevel: "high", durationMs: 5 },
				],
			}),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "usage")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Tools: 4 total — 2 success, 1 failure, 1 denied");
		expect(output.lines).toContain("Recent:");
		expect(output.lines).toContain("  success read (low) /tmp/a.ts 12ms");
		expect(output.lines).toContain("  denied write (high) 5ms");
	});

	it("/config renders effective config from an injected snapshot", async () => {
		const session = createMockSession();
		(session.context as SessionFacade["context"]) = {
			workingDirectory: "/repo",
			configSources: {
				model: { layer: "cli", detail: "--model" },
				provider: { layer: "env", detail: "GENESIS_PROVIDER" },
			},
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
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({
				sources: [
					{ key: "model", layer: "cli", detail: "--model" },
					{ key: "provider", layer: "env", detail: "GENESIS_PROVIDER" },
				],
				agentDir: "/agent",
				modelsPath: "/agent/models.json",
				providerKey: "zai",
				provider: {
					api: "openai-completions",
					baseUrl: "https://api.example.com",
					apiKeyEnv: "GENESIS_API_KEY",
					apiKeyPresent: true,
				},
				activeModel: {
					name: "GLM 5.1",
					id: "glm-5.1",
					reasoning: true,
				},
			}),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "config")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Precedence: default < agent < project < env < cli");
		expect(output.lines).toContain("Sources:");
		expect(output.lines).toContain("  model: cli (--model)");
		expect(output.lines).toContain("  provider: env (GENESIS_PROVIDER)");
		expect(output.lines).toContain("agentDir: /agent");
		expect(output.lines).toContain("models.json: /agent/models.json");
		expect(output.lines).toContain("provider: zai");
		expect(output.lines).toContain("  api: openai-completions");
		expect(output.lines).toContain("  baseUrl: https://api.example.com");
		expect(output.lines).toContain("  apiKey env: GENESIS_API_KEY (set)");
		expect(output.lines).toContain("model: GLM 5.1");
		expect(output.lines).toContain("  id: glm-5.1");
		expect(output.lines).toContain("  reasoning: true");
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		for (const cmd of cmds) {
			registry.register(cmd);
		}
		registry.register({ name: "ask", description: "Ask the model", type: "prompt", visibility: "public" });
		registry.register({ name: "panel", description: "Open UI panel", type: "ui", visibility: "public" });
		const output = createMockOutputSink();

		await cmds.find((cmd) => cmd.name === "help")!.execute!(createContext(session, runtime, output));

		expect(output.lines).toContain("Commands:");
		expect(output.lines).toContain("\nLocal (8):");
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({ sources: [], agentDir: "/agent", modelsPath: "/agent/models.json" }),
			getWorkingTreeSummary: async () => ({ changedPaths: [], snapshot: { available: true, statusLines: [], diffStatLines: [] } }),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
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
