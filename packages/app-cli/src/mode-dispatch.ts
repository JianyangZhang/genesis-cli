/**
 * Mode dispatch — four CLI mode handlers sharing the same AppRuntime.
 *
 * Each mode handler receives an identical AppRuntime and creates sessions
 * from it. Mode-specific behavior is isolated to how events are rendered.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppRuntime, CliMode, RuntimeEvent, SessionClosedEvent, SessionFacade } from "@genesis-cli/runtime";
import type { InteractionState, OutputSink, SlashCommand } from "@genesis-cli/ui";
import {
	ansiClearLine,
	ansiMoveRight,
	ansiShowCursor,
	createBuiltinCommands,
	createSlashCommandRegistry,
	eventToJsonEnvelope,
	formatEventAsText,
	initialInteractionState,
	reduceInteractionState,
} from "@genesis-cli/ui";
import type { InputLoop } from "./input-loop.js";
import { createInputLoop } from "./input-loop.js";
import type { RpcServer } from "./rpc-server.js";
import { createRpcServer } from "./rpc-server.js";
import { getSessionStoreDir, readLastSession, readRecentSessions, writeLastSession } from "./session-store.js";
import { measureTerminalDisplayWidth } from "./terminal-display-width.js";
import { createTtySession } from "./tty-session.js";

// ---------------------------------------------------------------------------
// Mode handler interface
// ---------------------------------------------------------------------------

export interface ModeHandler {
	start(runtime: AppRuntime): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createModeHandler(mode: CliMode): ModeHandler {
	switch (mode) {
		case "interactive":
			return new InteractiveModeHandler();
		case "print":
			return new PrintModeHandler();
		case "json":
			return new JsonModeHandler();
		case "rpc":
			return new RpcModeHandler();
	}

	throw new Error(`Unsupported mode: ${mode}`);
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

class InteractiveModeHandler implements ModeHandler {
	private _pendingPermissionCallId: string | null = null;
	private _pendingPermissionDetails: {
		toolName: string;
		toolCallId: string;
		riskLevel: string;
		reason?: string;
		targetPath?: string;
	} | null = null;
	private _activeTurn: Promise<void> | null = null;
	private readonly _prompt = "genesis> ";
	private _inputState: { buffer: string; cursor: number } = { buffer: "", cursor: 0 };
	private readonly _history: string[] = [];
	private _historyIndex: number | null = null;
	private _suppressPersistOnce = false;
	private _lastError: string | null = null;
	private readonly _changedPaths = new Set<string>();
	private _assistantBuffer = "";

	async start(runtime: AppRuntime): Promise<void> {
		const handler = this;
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("Interactive mode requires a TTY. Use --mode print|json|rpc instead.");
		}

		const sessionRef: { current: SessionFacade } = { current: runtime.createSession() };
		const sink: OutputSink = {
			write: (text) => {
				this.writeTranscriptText(text, false);
			},
			writeLine: (text) => {
				this.writeTranscriptText(text, true);
			},
			writeError: (text) => {
				this.writeTranscriptText(`Error: ${text}`, true);
			},
		};

		// Slash command registry
		const registry = createSlashCommandRegistry();
		for (const cmd of createBuiltinCommands()) {
			registry.register(cmd);
		}

		let interactionState: InteractionState = initialInteractionState();
		let sessionTitle: string | undefined;
		let exitRequested = false;
		let inputLoop: InputLoop | null = null;
		const ttySession = createTtySession({
			onResume: () => {
				this.renderPromptLine();
			},
			useAlternateScreen: false,
			enableMouseTracking: false,
		});
		const onResize = (): void => {
			this.renderPromptLine();
		};
		process.stdout.on("resize", onResize);

		const resolveAgentDir = (): string => {
			return (
				sessionRef.current.context.agentDir ??
				join(sessionRef.current.context.workingDirectory, ".genesis-local", "pi-agent")
			);
		};

		const attachSession = (next: SessionFacade): void => {
			sessionRef.current.events.removeAllListeners();
			sessionRef.current = next;
			this._pendingPermissionCallId = null;
			this._pendingPermissionDetails = null;
			this._activeTurn = null;
			this._historyIndex = null;
			this._lastError = null;
			this._changedPaths.clear();
			this._assistantBuffer = "";
			sessionTitle = undefined;
			interactionState = initialInteractionState();

			sessionRef.current.events.on("session_closed", (event) => {
				if (this._suppressPersistOnce) {
					this._suppressPersistOnce = false;
					return;
				}
				try {
					const dir = getSessionStoreDir(resolveAgentDir());
					void writeLastSession(dir, (event as SessionClosedEvent).recoveryData, { title: sessionTitle });
				} catch {}
			});

			sessionRef.current.events.onAny((event: RuntimeEvent) => {
				if (event.type === "permission_requested") {
					this._pendingPermissionDetails = {
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						riskLevel: event.riskLevel,
						reason: (event as { reason?: string }).reason,
						targetPath: (event as { targetPath?: string }).targetPath,
					};
				}
				if (event.type === "permission_resolved") {
					if (this._pendingPermissionDetails?.toolCallId === event.toolCallId) {
						this._pendingPermissionDetails = null;
					}
				}
				if (event.type === "tool_started") {
					const targetPath =
						typeof event.parameters.file_path === "string"
							? event.parameters.file_path
							: typeof event.parameters.path === "string"
								? event.parameters.path
								: undefined;
					if (targetPath && (event.toolName === "edit" || event.toolName === "write")) {
						this._changedPaths.add(targetPath);
					}
				}
				if (event.type === "tool_denied") {
					this._lastError = `${event.toolName}: ${event.reason}`;
				}
				if (event.type === "tool_completed" && event.status === "failure") {
					this._lastError = `${event.toolName}: ${event.result ?? "failure"}`;
				}

				interactionState = reduceInteractionState(interactionState, event);

				if (interactionState.phase === "waiting_permission" && interactionState.activeToolCallId) {
					this._pendingPermissionCallId = interactionState.activeToolCallId;
				} else if (interactionState.phase !== "waiting_permission") {
					this._pendingPermissionCallId = null;
				}
				this.handleTranscriptEvent(event);
			});
		};

		const register = (command: SlashCommand): void => {
			registry.register(command);
		};

		for (const cmd of createBuiltinCommands()) {
			register(cmd);
		}

		register({
			name: "title",
			description: "Set the current session title",
			type: "local",
			async execute(ctx) {
				const next = ctx.args.trim();
				if (next.length === 0) {
					ctx.output.writeError("Usage: /title <text>");
					return undefined;
				}
				sessionTitle = next;
				ctx.output.writeLine(`Title: ${next}`);
				return undefined;
			},
		});

		register({
			name: "help",
			description: "Show available commands",
			type: "local",
			async execute(ctx) {
				const query = ctx.args.trim().replace(/^\/+/, "");
				const all = registry.listAll().slice();

				if (query.length > 0) {
					const cmd = all.find((c) => c.name === query) ?? null;
					if (!cmd) {
						ctx.output.writeError(`Unknown command: /${query}`);
						ctx.output.writeLine("Type /help to see all commands.");
						return undefined;
					}
					ctx.output.writeLine(`/${cmd.name}`);
					ctx.output.writeLine(`  ${cmd.description}`);
					ctx.output.writeLine(`  Type: ${cmd.type}`);
					return undefined;
				}

				all.sort((a, b) => a.name.localeCompare(b.name));
				const local = all.filter((c) => c.type === "local");
				const prompt = all.filter((c) => c.type === "prompt");
				const ui = all.filter((c) => c.type === "ui");

				ctx.output.writeLine("Commands:");
				const renderGroup = (label: string, items: readonly SlashCommand[]): void => {
					if (items.length === 0) return;
					ctx.output.writeLine(`\n${label} (${items.length}):`);
					for (const cmd of items) {
						ctx.output.writeLine(`  /${cmd.name} — ${cmd.description}`);
					}
				};
				renderGroup("Local", local);
				renderGroup("Prompt", prompt);
				renderGroup("UI", ui);

				ctx.output.writeLine("\nTips:");
				ctx.output.writeLine("  /help <name>  Show details for a command");
				ctx.output.writeLine("  Ctrl+C        Abort the current turn (or exit if idle)");
				return undefined;
			},
		});

		register({
			name: "exit",
			description: "Exit the interactive session",
			type: "local",
			async execute(ctx) {
				exitRequested = true;
				ctx.output.writeLine("Bye.");
				inputLoop?.close();
				return undefined;
			},
		});

		register({
			name: "quit",
			description: "Exit the interactive session (alias of /exit)",
			type: "local",
			async execute(ctx) {
				exitRequested = true;
				ctx.output.writeLine("Bye.");
				inputLoop?.close();
				return undefined;
			},
		});

		register({
			name: "clear",
			description: "Clear the transcript",
			type: "local",
			async execute(ctx) {
				ctx.output.writeLine(
					"Transcript stays in terminal scrollback. Use your terminal clear command if you want a clean screen.",
				);
				return undefined;
			},
		});

		register({
			name: "sessions",
			description: "List recent sessions",
			type: "local",
			async execute(ctx) {
				const dir = getSessionStoreDir(resolveAgentDir());
				const recent = await readRecentSessions(dir);
				if (recent.length === 0) {
					ctx.output.writeLine("No recent sessions.");
					return undefined;
				}
				const formatAge = (ts: number): string => {
					const delta = Math.max(0, Date.now() - ts);
					const seconds = Math.floor(delta / 1000);
					if (seconds < 60) return `${seconds}s ago`;
					const minutes = Math.floor(seconds / 60);
					if (minutes < 60) return `${minutes}m ago`;
					const hours = Math.floor(minutes / 60);
					if (hours < 24) return `${hours}h ago`;
					const days = Math.floor(hours / 24);
					return `${days}d ago`;
				};

				ctx.output.writeLine("Recent sessions:");
				let i = 0;
				for (const entry of recent) {
					i++;
					const id = entry.recoveryData.sessionId.value;
					const model = entry.recoveryData.model.id;
					const title = entry.title ? ` — ${entry.title}` : "";
					const age = formatAge(entry.updatedAt);
					ctx.output.writeLine(`  #${i} ${id} (${model})${title} — ${age}`);
				}
				ctx.output.writeLine("Next: /resume <sessionId|#N|title> or /resume (last)");
				return undefined;
			},
		});

		register({
			name: "changes",
			description: "Show changed files and diff summary",
			type: "local",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				ctx.output.writeLine("Working tree:");
				if (handler._changedPaths.size > 0) {
					ctx.output.writeLine("Changed files (observed by tools):");
					for (const path of [...handler._changedPaths].sort((a, b) => a.localeCompare(b))) {
						ctx.output.writeLine(`  ${path}`);
					}
				} else {
					ctx.output.writeLine("Changed files (observed by tools): none");
				}

				const status = await runGit(cwd, ["status", "--porcelain"]);
				if (status.type === "ok") {
					const trimmed = status.stdout.trim();
					ctx.output.writeLine("git status --porcelain:");
					ctx.output.writeLine(trimmed.length > 0 ? trimmed : "  clean");
				}
				const stat = await runGit(cwd, ["diff", "--stat"]);
				if (stat.type === "ok" && stat.stdout.trim().length > 0) {
					ctx.output.writeLine("git diff --stat:");
					ctx.output.writeLine(`  ${stat.stdout.trimEnd().split("\n").join("\n  ")}`);
				}
				if (status.type === "error" || stat.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					ctx.output.writeLine("Next: use /review to inspect tool-observed changes.");
					return undefined;
				}
				ctx.output.writeLine("Next: /review to inspect, /diff [file] to see patches, /revert <file> to undo.");
				return undefined;
			},
		});

		register({
			name: "diff",
			description: "Show git diff (optionally for a file)",
			type: "local",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const target = ctx.args.trim();
				if (target.length === 0) {
					ctx.output.writeLine("Diff:");
				} else {
					ctx.output.writeLine(`Diff: ${target}`);
				}
				const args = target.length > 0 ? ["diff", "--", target] : ["diff"];
				const diff = await runGit(cwd, args);
				if (diff.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					return undefined;
				}
				ctx.output.writeLine(diff.stdout.trimEnd().length > 0 ? diff.stdout.trimEnd() : "(no diff)");
				ctx.output.writeLine("Next: /revert <file> to undo, or /review to see a summary.");
				return undefined;
			},
		});

		register({
			name: "revert",
			description: "Revert a file using git checkout -- <file> (or --all)",
			type: "local",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const arg = ctx.args.trim();
				if (arg.length === 0) {
					ctx.output.writeError("Usage: /revert <file> | /revert --all");
					return undefined;
				}
				if (arg === "--all") {
					const result = await runGit(cwd, ["checkout", "--", "."]);
					if (result.type === "error") {
						ctx.output.writeError("git not available in this working directory.");
						return undefined;
					}
					handler._changedPaths.clear();
					ctx.output.writeLine("Reverted all changes.");
					ctx.output.writeLine("Next: /changes to confirm clean state.");
					return undefined;
				}
				const result = await runGit(cwd, ["checkout", "--", arg]);
				if (result.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					return undefined;
				}
				handler._changedPaths.delete(arg);
				ctx.output.writeLine(`Reverted: ${arg}`);
				ctx.output.writeLine("Next: /changes to confirm, or keep iterating.");
				return undefined;
			},
		});

		register({
			name: "review",
			description: "Review changes and decide to keep or revert",
			type: "local",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const status = await runGit(cwd, ["status", "--porcelain"]);
				if (status.type === "ok" && status.stdout.trim().length === 0 && handler._changedPaths.size === 0) {
					ctx.output.writeLine("Review: clean working tree.");
					ctx.output.writeLine("Next: continue chatting, or run /status if you want a snapshot.");
					return undefined;
				}
				await registry.get("changes")!.execute?.(ctx);
				ctx.output.writeLine("Review tips:");
				ctx.output.writeLine("  /diff <file>   Inspect a specific patch");
				ctx.output.writeLine("  /revert <file> Undo a change");
				ctx.output.writeLine("  /revert --all  Undo all changes");
				ctx.output.writeLine("Next: inspect diffs, then continue chatting.");
				return undefined;
			},
		});

		register({
			name: "status",
			description: "Show status",
			type: "local",
			async execute(ctx) {
				const state = ctx.session.state;
				ctx.output.writeLine(`Session: ${state.id.value}`);
				ctx.output.writeLine(`  CWD: ${ctx.session.context.workingDirectory}`);
				ctx.output.writeLine(`  Agent dir: ${resolveAgentDir()}`);
				ctx.output.writeLine(`  Model: ${state.model.displayName ?? state.model.id}`);
				ctx.output.writeLine(`  Provider: ${state.model.provider}`);
				ctx.output.writeLine(`  Phase: ${interactionState.phase}`);
				ctx.output.writeLine(
					`  Task: ${state.taskState.status}${
						state.taskState.currentTaskId ? ` (${state.taskState.currentTaskId})` : ""
					}`,
				);
				ctx.output.writeLine(`  Tools: ${[...state.toolSet].join(", ") || "(none)"}`);
				if (state.planSummary) {
					ctx.output.writeLine(`  Plan: ${state.planSummary.completedSteps}/${state.planSummary.stepCount}`);
				}
				if (state.compactionSummary) {
					ctx.output.writeLine(`  Last compaction: ${state.compactionSummary.estimatedTokensSaved} tokens saved`);
				}
				if (handler._lastError) {
					ctx.output.writeLine(`  Last error: ${handler._lastError}`);
				}
				if (handler._changedPaths.size > 0) {
					ctx.output.writeLine(`  Changed files: ${handler._changedPaths.size}`);
				}
				if (handler._pendingPermissionCallId) {
					ctx.output.writeLine(`  Waiting permission: ${handler._pendingPermissionCallId}`);
				}

				ctx.output.writeLine("Next:");
				if (handler._pendingPermissionCallId) {
					ctx.output.writeLine("  Reply y (once), Y (session), n (deny), or Ctrl+C to deny");
				} else if (handler._activeTurn) {
					ctx.output.writeLine("  Wait for the active turn, or Ctrl+C to abort");
				} else if (handler._changedPaths.size > 0) {
					ctx.output.writeLine("  /review to inspect changes, or /diff <file>");
				} else if (handler._lastError) {
					ctx.output.writeLine("  /doctor to diagnose, or /help for commands");
				} else {
					ctx.output.writeLine("  Type a prompt, or /help for commands");
				}
				return undefined;
			},
		});

		register({
			name: "usage",
			description: "Show tool usage and governance summary",
			type: "local",
			async execute(ctx) {
				const entries = ctx.runtime.governor.audit.getAll();
				const total = entries.length;
				const success = entries.filter((e) => e.status === "success").length;
				const failure = entries.filter((e) => e.status === "failure").length;
				const denied = entries.filter((e) => e.status === "denied").length;
				ctx.output.writeLine(`Tools: ${total} total — ${success} success, ${failure} failure, ${denied} denied`);
				const tail = entries.slice(-10);
				if (tail.length > 0) {
					ctx.output.writeLine("Recent:");
					for (const entry of tail) {
						const path = entry.targetPath ? ` ${entry.targetPath}` : "";
						ctx.output.writeLine(
							`  ${entry.status} ${entry.toolName} (${entry.riskLevel})${path} ${entry.durationMs}ms`,
						);
					}
				}
				return undefined;
			},
		});

		register({
			name: "config",
			description: "Show effective config",
			type: "local",
			async execute(ctx) {
				const sources = ctx.session.context.configSources ?? {};
				ctx.output.writeLine("Precedence: default < agent < project < env < cli");
				const keys = Object.keys(sources).sort((a, b) => a.localeCompare(b));
				if (keys.length > 0) {
					ctx.output.writeLine("Sources:");
					for (const key of keys) {
						const source = sources[key]!;
						ctx.output.writeLine(`  ${key}: ${source.layer} (${source.detail})`);
					}
				}

				const agentDir = resolveAgentDir();
				const modelsPath = join(agentDir, "models.json");
				ctx.output.writeLine(`agentDir: ${agentDir}`);
				ctx.output.writeLine(`models.json: ${modelsPath}`);
				let raw = "";
				try {
					raw = await readFile(modelsPath, "utf8");
				} catch {
					ctx.output.writeError("models.json not found. Run Genesis once or pass --agent-dir.");
					return undefined;
				}

				const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
				const providerKey = ctx.session.state.model.provider;
				const provider = parsed.providers?.[providerKey];
				if (!provider) {
					ctx.output.writeError(`Provider not configured: ${providerKey}`);
					return undefined;
				}

				ctx.output.writeLine(`provider: ${providerKey}`);
				ctx.output.writeLine(`  api: ${provider.api ?? "(missing)"}`);
				ctx.output.writeLine(`  baseUrl: ${provider.baseUrl ?? "(missing)"}`);
				const apiKeyEnv = typeof provider.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
				ctx.output.writeLine(`  apiKey env: ${apiKeyEnv} (${process.env[apiKeyEnv] ? "set" : "missing"})`);

				const models = Array.isArray(provider.models) ? provider.models : [];
				const active = models.find((m: any) => m?.id === ctx.session.state.model.id);
				if (active) {
					ctx.output.writeLine(`model: ${active.name ?? active.id}`);
					ctx.output.writeLine(`  id: ${active.id}`);
					ctx.output.writeLine(`  reasoning: ${Boolean(active.reasoning)}`);
				} else {
					ctx.output.writeError(`Model not configured: ${ctx.session.state.model.id}`);
				}
				return undefined;
			},
		});

		register({
			name: "doctor",
			description: "Diagnose OpenAI-compatible mainline",
			type: "local",
			async execute(ctx) {
				const agentDir = resolveAgentDir();
				const modelsPath = join(agentDir, "models.json");
				let raw = "";
				try {
					raw = await readFile(modelsPath, "utf8");
				} catch {
					ctx.output.writeError("models.json not found.");
					return undefined;
				}
				const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
				const providerKey = ctx.session.state.model.provider;
				const provider = parsed.providers?.[providerKey];
				const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
				const api = typeof provider?.api === "string" ? provider.api : "";
				const apiKeyEnv = typeof provider?.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
				const apiKey = process.env[apiKeyEnv];

				ctx.output.writeLine(`provider: ${providerKey}`);
				ctx.output.writeLine(`  api: ${api || "(missing)"}`);
				ctx.output.writeLine(`  baseUrl: ${baseUrl || "(missing)"}`);
				ctx.output.writeLine(`  apiKey env: ${apiKeyEnv} (${apiKey ? "set" : "missing"})`);
				if (!apiKey || !baseUrl || api !== "openai-completions") {
					return undefined;
				}

				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 3000);
				try {
					const response = await fetch(
						new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`),
						{
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
							},
							body: JSON.stringify({
								model: ctx.session.state.model.id,
								stream: false,
								messages: [{ role: "user", content: "Reply exactly DOCTOR_OK" }],
							}),
							signal: controller.signal,
						},
					);
					ctx.output.writeLine(`  http: ${response.status}`);
					if (!response.ok) {
						ctx.output.writeError(await response.text());
						return undefined;
					}
					const payload = (await response.json()) as any;
					const text = payload?.choices?.[0]?.message?.content;
					if (typeof text === "string") {
						ctx.output.writeLine(`  response: ${text.trim()}`);
					}
				} catch (err) {
					ctx.output.writeError(`  error: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					clearTimeout(timeout);
				}
				return undefined;
			},
		});

		register({
			name: "resume",
			description: "Resume the last session",
			type: "local",
			async execute(ctx) {
				if (handler._activeTurn || handler._pendingPermissionCallId) {
					ctx.output.writeError("Session is busy.");
					return undefined;
				}

				const dir = getSessionStoreDir(resolveAgentDir());
				const selector = ctx.args.trim();
				const recent = selector.length === 0 ? null : await readRecentSessions(dir);
				const data =
					selector.length === 0
						? await readLastSession(dir)
						: (() => {
								if (!recent) return null;
								const idxText = selector.startsWith("#") ? selector.slice(1) : selector;
								const idx = Number.parseInt(idxText, 10);
								if (Number.isFinite(idx) && idx >= 1 && idx <= recent.length) {
									return recent[idx - 1]?.recoveryData ?? null;
								}

								const exact =
									recent.find((entry) => entry.recoveryData.sessionId.value === selector)?.recoveryData ??
									null;
								if (exact) return exact;

								const prefixMatches = recent.filter((entry) =>
									entry.recoveryData.sessionId.value.startsWith(selector),
								);
								if (prefixMatches.length === 1) return prefixMatches[0]!.recoveryData;

								const q = selector.toLowerCase();
								const titleMatches = recent.filter((entry) => (entry.title ?? "").toLowerCase().includes(q));
								if (titleMatches.length === 1) return titleMatches[0]!.recoveryData;

								const candidates = [...prefixMatches, ...titleMatches].slice(0, 10);
								if (candidates.length > 1) {
									ctx.output.writeLine("Multiple matches:");
									let i = 0;
									for (const entry of candidates) {
										i++;
										const id = entry.recoveryData.sessionId.value;
										const model = entry.recoveryData.model.id;
										const title = entry.title ? ` — ${entry.title}` : "";
										ctx.output.writeLine(`  #${i} ${id} (${model})${title}`);
									}
									ctx.output.writeLine("Tip: use an exact sessionId, or /sessions then /resume #N.");
									return null;
								}

								return null;
							})();

				if (!data) {
					ctx.output.writeError(
						selector.length === 0 ? "No previous session found." : `Session not found: ${selector}`,
					);
					return undefined;
				}

				handler._suppressPersistOnce = true;
				await sessionRef.current.close();

				const recovered = runtime.recoverSession(data);
				attachSession(recovered);
				ctx.output.writeLine(`Resumed: ${data.sessionId.value}`);
				handler.renderPromptLine();
				return undefined;
			},
		});

		attachSession(sessionRef.current);

		// Input loop
		inputLoop = createInputLoop({
			prompt: "",
			rawMode: true,
			onInputStateChange: (state) => {
				this._inputState = state;
				this.renderPromptLine();
			},
			onKey: (key) => {
				if (key === "ctrlc") {
					if (this._pendingPermissionCallId !== null) {
						const callId = this._pendingPermissionCallId;
						this._pendingPermissionCallId = null;
						this._pendingPermissionDetails = null;
						void sessionRef.current.resolvePermission(callId, "deny").catch((err) => {
							sink.writeError(`Error: ${err}`);
						});
						sink.writeLine("Permission denied.");
						this.renderPromptLine();
						return;
					}
					if (this._activeTurn !== null) {
						sessionRef.current.abort();
						this.flushAssistantBuffer(false);
						sink.writeLine("Aborted.");
						return;
					}
					exitRequested = true;
					sink.writeLine("Bye.");
					inputLoop?.close();
					return;
				}
				this.handleSpecialKey(key);
			},
			onTerminalEvent: (event) => {
				if (event === "focusin") {
					ttySession.refresh();
					this.renderPromptLine();
				}
			},
		});

		ttySession.enter();
		this.renderWelcome(sessionRef.current);
		this.renderPromptLine();

		try {
			let line = await inputLoop.nextLine();
			while (line !== null) {
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					line = await inputLoop.nextLine();
					continue;
				}

				// Permission response
				if (this._pendingPermissionCallId !== null) {
					const decision = parsePermissionDecision(trimmed);
					if (!decision) {
						sink.writeError("Permission: [y] once, [Y] session, [n] deny");
						line = await inputLoop.nextLine();
						continue;
					}
					await sessionRef.current.resolvePermission(this._pendingPermissionCallId, decision);
					this._pendingPermissionCallId = null;
					this._pendingPermissionDetails = null;
					line = await inputLoop.nextLine();
					continue;
				}

				// Check for slash commands
				const resolution = registry.resolve(trimmed);
				if (resolution && resolution.type === "command") {
					await resolution.command.execute?.({
						args: resolution.args,
						runtime,
						session: sessionRef.current,
						output: sink,
					});
					if (exitRequested) {
						break;
					}
					line = await inputLoop.nextLine();
					continue;
				}
				if (resolution && resolution.type === "not_found") {
					sink.writeError(`Unknown command: /${resolution.name}. Type /help for a list.`);
					line = await inputLoop.nextLine();
					continue;
				}

				// Regular prompt
				if (this._activeTurn !== null) {
					sink.writeError("Session is busy. Wait for the active turn or answer the permission prompt.");
					line = await inputLoop.nextLine();
					continue;
				}
				this.flushAssistantBuffer(false);
				this.writeTranscriptText(formatTranscriptUserLine(trimmed), true);
				this.rememberHistory(trimmed);
				this._activeTurn = sessionRef.current
					.prompt(trimmed)
					.catch((err) => {
						sink.writeError(`Error: ${err}`);
					})
					.finally(() => {
						this._activeTurn = null;
						this.flushAssistantBuffer(false);
						this.renderPromptLine();
					});

				line = await inputLoop.nextLine();
			}
		} finally {
			process.stdout.off("resize", onResize);
			inputLoop.close();
			ttySession.restore();
			sessionRef.current.events.removeAllListeners();
			await sessionRef.current.close();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		const width = Math.max(60, Math.min(process.stdout.columns ?? 80, 100));
		const DIM = "\x1b[2m";
		const RESET = "\x1b[0m";
		const GREEN = "\x1b[32m";
		const CYAN = "\x1b[36m";
		const BOLD = "\x1b[1m";
		const model = session.state.model.displayName ?? session.state.model.id;
		const provider = session.state.model.provider;
		const cwd = session.context.workingDirectory;
		const version = process.env.npm_package_version ?? "dev";
		const contentWidth = width - 2;
		const center = (text: string): string => {
			const plain = stripAnsiWelcome(text);
			const padding = Math.max(0, contentWidth - plain.length);
			const left = Math.floor(padding / 2);
			const right = padding - left;
			return `│${" ".repeat(left)}${text}${" ".repeat(right)}│`;
		};
		const fill = (text = ""): string => {
			const plain = stripAnsiWelcome(text);
			const padding = Math.max(0, contentWidth - plain.length);
			return `│${text}${" ".repeat(padding)}│`;
		};
		process.stdout.write(
			`╭─── ${BOLD}${GREEN}Genesis CLI${RESET} ${DIM}v${version}${RESET} ${"─".repeat(Math.max(0, width - 23 - version.length))}╮\n`,
		);
		process.stdout.write(fill());
		process.stdout.write("\n");
		process.stdout.write(center(`${BOLD}Welcome back!${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(fill());
		process.stdout.write("\n");
		process.stdout.write(center(`${GREEN}███████${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${GREEN}   ▄▄  ${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${GREEN}  ▄▀   ${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${GREEN} ▄▀▄▄▄ ${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${GREEN} ▀▀▀▀▀ ${RESET}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${CYAN}${model}${RESET} ${DIM}via${RESET} ${provider}`));
		process.stdout.write("\n");
		process.stdout.write(center(`${DIM}${cwd}${RESET}`));
		process.stdout.write("\n");
		process.stdout.write("╰");
		process.stdout.write("─".repeat(contentWidth));
		process.stdout.write("╯\n");
		process.stdout.write(
			`${DIM}Start:${RESET} type a prompt and press Enter  ${DIM}Help:${RESET} /help  ${DIM}Scroll:${RESET} wheel/PageUp/PageDown\n`,
		);
	}

	private renderPromptLine(): void {
		process.stdout.write(ansiClearLine());
		const buffer = this._inputState.buffer;
		const prompt =
			this._pendingPermissionCallId !== null
				? `perm${this._pendingPermissionDetails ? `(${this._pendingPermissionDetails.riskLevel} ${this._pendingPermissionDetails.toolName})` : ""} [y/Y/n]> `
				: this._prompt;
		process.stdout.write(prompt);
		if (buffer.length > 0) {
			process.stdout.write(buffer);
		}
		process.stdout.write("\r");
		process.stdout.write(
			ansiMoveRight(computePromptCursorColumn(prompt, this._inputState.buffer, this._inputState.cursor)),
		);
		process.stdout.write(ansiShowCursor());
	}

	private handleSpecialKey(key: "up" | "down" | "pageup" | "pagedown" | "wheelup" | "wheeldown" | "esc"): void {
		if (key === "up" || key === "down") {
			this.navigateHistory(key === "up" ? -1 : 1);
		}
	}

	private handleTranscriptEvent(event: RuntimeEvent): void {
		if (!shouldRenderInteractiveTranscriptEvent(event)) {
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "text_delta") {
			this._assistantBuffer += event.content;
			return;
		}
		this.flushAssistantBuffer(false);
		const text = formatEventAsText(event);
		if (text.length > 0) {
			this.writeTranscriptText(text, true);
		} else {
			this.renderPromptLine();
		}
	}

	private flushAssistantBuffer(redrawPrompt: boolean): void {
		if (this._assistantBuffer.length === 0) {
			if (redrawPrompt) {
				this.renderPromptLine();
			}
			return;
		}
		const text = formatTranscriptAssistantLine(this._assistantBuffer);
		this._assistantBuffer = "";
		this.writeTranscriptText(text, true, redrawPrompt);
	}

	private writeTranscriptText(text: string, newline: boolean, redrawPrompt = true): void {
		process.stdout.write(ansiClearLine());
		process.stdout.write(text);
		if (newline) {
			process.stdout.write("\n");
		}
		if (redrawPrompt) {
			this.renderPromptLine();
		}
	}

	private rememberHistory(line: string): void {
		if (line.length === 0) return;
		if (this._history.at(-1) === line) return;
		this._history.push(line);
		if (this._history.length > 200) {
			this._history.shift();
		}
		this._historyIndex = null;
	}

	private navigateHistory(direction: -1 | 1): void {
		if (this._history.length === 0) return;

		if (this._historyIndex === null) {
			this._historyIndex = this._history.length;
		}
		const next = Math.max(0, Math.min(this._history.length, this._historyIndex + direction));
		this._historyIndex = next;
		const text = next === this._history.length ? "" : (this._history[next] ?? "");
		this._inputState = { buffer: text, cursor: text.length };
		this.renderPromptLine();
	}
}

// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------

class PrintModeHandler implements ModeHandler {
	async start(runtime: AppRuntime): Promise<void> {
		const session = runtime.createSession();

		// Subscribe to events and format as text
		session.events.onAny((event: RuntimeEvent) => {
			const text = formatEventAsText(event);
			if (text.length > 0) {
				process.stdout.write(`${text}\n`);
			}
		});

		// Read one prompt from stdin, send it, wait for completion
		const inputLoop = createInputLoop({ prompt: "" });
		try {
			const line = await inputLoop.nextLine();
			if (line && line.trim().length > 0) {
				await session.prompt(line.trim());
			}
		} finally {
			inputLoop.close();
			await session.close();
		}
	}
}

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

class JsonModeHandler implements ModeHandler {
	async start(runtime: AppRuntime): Promise<void> {
		const session = runtime.createSession();

		// Subscribe to events and emit JSON envelopes
		session.events.onAny((event: RuntimeEvent) => {
			const envelope = eventToJsonEnvelope(event);
			process.stdout.write(`${JSON.stringify(envelope)}\n`);
		});

		// Also forward global events
		runtime.events.onAny((event: RuntimeEvent) => {
			const envelope = eventToJsonEnvelope(event);
			process.stdout.write(`${JSON.stringify(envelope)}\n`);
		});

		// Read one prompt from stdin
		const inputLoop = createInputLoop({ prompt: "" });
		try {
			const line = await inputLoop.nextLine();
			if (line && line.trim().length > 0) {
				await session.prompt(line.trim());
			}
		} finally {
			inputLoop.close();
			await session.close();
		}
	}
}

// ---------------------------------------------------------------------------
// RPC mode
// ---------------------------------------------------------------------------

class RpcModeHandler implements ModeHandler {
	private server: RpcServer | null = null;

	async start(runtime: AppRuntime): Promise<void> {
		this.server = createRpcServer();
		await this.server.start(runtime);
	}

	async stop(): Promise<void> {
		if (this.server) {
			await this.server.stop();
			this.server = null;
		}
	}
}

function parsePermissionDecision(input: string): "allow_once" | "allow_for_session" | "deny" | null {
	const trimmed = input.trim();
	if (trimmed === "y" || trimmed.toLowerCase() === "yes") return "allow_once";
	if (trimmed === "Y") return "allow_for_session";
	if (trimmed === "n" || trimmed.toLowerCase() === "no") return "deny";
	return null;
}

function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ type: "ok"; stdout: string; stderr: string } | { type: "error" }> {
	return new Promise((resolve) => {
		execFile("git", [...args], { cwd }, (error, stdout, stderr) => {
			if (error) {
				resolve({ type: "error" });
				return;
			}
			resolve({ type: "ok", stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function stripAnsiWelcome(text: string): string {
	return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

export function computePromptCursorColumn(prompt: string, buffer: string, cursor: number): number {
	return measureTerminalDisplayWidth(prompt) + measureTerminalDisplayWidth(buffer.slice(0, cursor));
}

export function shouldRenderInteractiveTranscriptEvent(event: RuntimeEvent): boolean {
	if (event.category === "session") {
		return false;
	}
	return true;
}

export function formatTranscriptUserLine(content: string): string {
	const BG = "\x1b[48;5;238m";
	const FG = "\x1b[97m";
	const RESET = "\x1b[0m";
	return `${BG}${FG} ${content} ${RESET}`;
}

export function formatTranscriptAssistantLine(content: string): string {
	return content;
}
