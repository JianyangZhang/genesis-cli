/**
 * Mode dispatch — four CLI mode handlers sharing the same AppRuntime.
 *
 * Each mode handler receives an identical AppRuntime and creates sessions
 * from it. Mode-specific behavior is isolated to how events are rendered.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppRuntime, CliMode, RuntimeEvent, SessionClosedEvent, SessionFacade } from "@pickle-pee/runtime";
import type { InteractionState, OutputSink, SlashCommand } from "@pickle-pee/ui";
import {
	ansiClearLine,
	ansiCursorHome,
	ansiShowCursor,
	createBuiltinCommands,
	createSlashCommandRegistry,
	eventToJsonEnvelope,
	formatEventAsText,
	initialInteractionState,
	reduceInteractionState,
} from "@pickle-pee/ui";
import type { InputLoop } from "./input-loop.js";
import { createInputLoop } from "./input-loop.js";
import type { RpcServer } from "./rpc-server.js";
import { createRpcServer } from "./rpc-server.js";
import { getSessionStoreDir, readLastSession, readRecentSessions, writeLastSession } from "./session-store.js";
import { measureTerminalDisplayWidth } from "./terminal-display-width.js";
import { INTERACTIVE_THEME } from "./theme.js";
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
	private readonly _prompt = "❯ ";
	private _inputState: { buffer: string; cursor: number } = { buffer: "", cursor: 0 };
	private readonly _history: string[] = [];
	private _historyIndex: number | null = null;
	private _suppressPersistOnce = false;
	private _lastError: string | null = null;
	private readonly _changedPaths = new Set<string>();
	private readonly _transcriptBlocks: string[] = [];
	private _assistantBuffer = "";
	private _streamingReservedRows = 0;
	private _streamingDisplayRows = 0;
	private _renderedStreamingStartRow: number | null = null;
	private _turnNotice: "thinking" | "responding" | null = null;
	private _turnNoticeAnimationFrame = 0;
	private _turnNoticeTimer: ReturnType<typeof setInterval> | null = null;
	private _commandSuggestions: readonly string[] = [];
	private readonly _toolCalls = new Map<string, { toolName: string; parameters: Readonly<Record<string, unknown>> }>();
	private readonly _queuedInputs: string[] = [];
	private _pendingPermissionSelection = 0;
	private _renderedFooterUi: InteractiveFooterRenderResult | null = null;
	private _renderedFooterStartRow: number | null = null;
	private _welcomeLines: readonly string[] = [];

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
				this.rerenderInteractiveRegions();
			},
			useAlternateScreen: false,
			enableMouseTracking: false,
		});
		const onResize = (): void => {
			this.rerenderInteractiveRegions();
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
			this._transcriptBlocks.length = 0;
			this._assistantBuffer = "";
			this._streamingReservedRows = 0;
			this._streamingDisplayRows = 0;
			this._renderedStreamingStartRow = null;
			this.stopTurnNoticeAnimation();
			this._turnNotice = null;
			this._turnNoticeAnimationFrame = 0;
			this._commandSuggestions = [];
			this._toolCalls.clear();
			this._queuedInputs.length = 0;
			this._pendingPermissionSelection = 0;
			this._renderedFooterUi = null;
			this._renderedFooterStartRow = null;
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
					this._pendingPermissionSelection = 0;
				}
				if (event.type === "permission_resolved") {
					if (this._pendingPermissionDetails?.toolCallId === event.toolCallId) {
						this._pendingPermissionDetails = null;
						this._pendingPermissionSelection = 0;
					}
				}
				if (event.type === "tool_started") {
					this._toolCalls.set(event.toolCallId, { toolName: event.toolName, parameters: event.parameters });
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
					this._toolCalls.delete(event.toolCallId);
					this._lastError = `${event.toolName}: ${event.reason}`;
				}
				if (event.type === "tool_completed" && event.status === "failure") {
					this._toolCalls.delete(event.toolCallId);
					this._lastError = `${event.toolName}: ${event.result ?? "failure"}`;
				}
				if (event.type === "tool_completed" && event.status === "success") {
					this._toolCalls.delete(event.toolCallId);
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
			submitNewline: false,
			onInputStateChange: (state) => {
				this._inputState = state;
				this._commandSuggestions = computeSlashSuggestions(state.buffer, registry.listAll());
				this.renderPromptLine();
			},
			onTabComplete: (state) => {
				if (this._pendingPermissionCallId !== null) {
					return null;
				}
				const nextState = acceptFirstSlashSuggestion(state, this._commandSuggestions);
				if (nextState) {
					this._inputState = nextState;
					this._commandSuggestions = computeSlashSuggestions(nextState.buffer, registry.listAll());
					this.renderPromptLine();
				}
				return nextState;
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
					this.rerenderInteractiveRegions();
				}
			},
		});

		ttySession.enter();
		this.renderWelcome(sessionRef.current);
		this.fullRedrawInteractiveScreen();

		try {
			let line = await inputLoop.nextLine();
			while (line !== null) {
				const trimmed = line.trim();

				// Permission response
				if (this._pendingPermissionCallId !== null) {
					const decision = parsePermissionDecision(trimmed, this._pendingPermissionSelection);
					if (!decision) {
						sink.writeError("Permission: use 1/2/3, Enter, y/Y/n, or arrow keys/Tab to choose.");
						line = await inputLoop.nextLine();
						continue;
					}
					await sessionRef.current.resolvePermission(this._pendingPermissionCallId, decision);
					this._pendingPermissionCallId = null;
					this._pendingPermissionDetails = null;
					this._pendingPermissionSelection = 0;
					line = await inputLoop.nextLine();
					continue;
				}

				if (trimmed.length === 0) {
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
					this._queuedInputs.push(trimmed);
					this.renderFooterRegion();
					line = await inputLoop.nextLine();
					continue;
				}
				this.startPromptTurn(sessionRef.current, trimmed, sink);

				line = await inputLoop.nextLine();
			}
		} finally {
			process.stdout.off("resize", onResize);
			inputLoop.close();
			process.stdout.write(ansiResetScrollRegion());
			ttySession.restore();
			sessionRef.current.events.removeAllListeners();
			await sessionRef.current.close();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		this._welcomeLines = buildWelcomeLines({
			terminalWidth: process.stdout.columns ?? 80,
			version: process.env.npm_package_version ?? "dev",
			model: session.state.model.displayName ?? session.state.model.id,
			provider: session.state.model.provider,
			greeting: pickWelcomeGreeting(),
		});
	}

	private renderPromptLine(): void {
		this.renderFooterRegion();
	}

	private handleSpecialKey(
		key: "up" | "down" | "pageup" | "pagedown" | "wheelup" | "wheeldown" | "tab" | "shifttab" | "esc",
	): void {
		if (this._pendingPermissionCallId !== null) {
			if (key === "up" || key === "shifttab") {
				this._pendingPermissionSelection = movePermissionSelection(this._pendingPermissionSelection, -1);
				this.renderPermissionUi();
			} else if (key === "down" || key === "tab") {
				this._pendingPermissionSelection = movePermissionSelection(this._pendingPermissionSelection, 1);
				this.renderPermissionUi();
			}
			return;
		}
		if (key === "up" || key === "down") {
			this.navigateHistory(key === "up" ? -1 : 1);
		}
	}

	private renderPermissionUi(): void {
		if (this._pendingPermissionCallId === null || this._pendingPermissionDetails === null) {
			this.fullRedrawInteractiveScreen();
			return;
		}
		this.fullRedrawInteractiveScreen();
	}

	private handleTranscriptEvent(event: RuntimeEvent): void {
		if (event.category === "permission") {
			if (event.type === "permission_requested") {
				this.renderPermissionUi();
			} else {
				this.fullRedrawInteractiveScreen();
			}
			return;
		}
		if (event.category === "tool") {
			const text = formatInteractiveToolEvent(event, this._toolCalls.get(event.toolCallId)?.parameters);
			if (text.length > 0) {
				this.flushAssistantBuffer(false);
				this.writeTranscriptText(text, true);
			} else {
				this.renderPromptLine();
			}
			return;
		}
		if (!shouldRenderInteractiveTranscriptEvent(event)) {
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "thinking_delta") {
			if (this._turnNotice === null) {
				this.startTurnFeedback();
			}
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "text_delta") {
			if (this._turnNotice !== "responding") {
				this.stopTurnNoticeAnimation();
				this._turnNoticeAnimationFrame = 0;
				this._turnNotice = "responding";
			}
			this._assistantBuffer = mergeStreamingText(this._assistantBuffer, event.content);
			this.renderStreamingAssistantBlock();
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
		const assistantBlock = materializeAssistantTranscriptBlock(this._assistantBuffer);
		if (assistantBlock !== null) {
			this.rememberAssistantTranscriptBlock(assistantBlock);
		}
		this._assistantBuffer = "";
		this._streamingReservedRows = 0;
		this._streamingDisplayRows = 0;
		this._renderedStreamingStartRow = null;
		if (redrawPrompt) {
			this.renderPromptLine();
		}
	}

	private startTurnFeedback(): void {
		if (this._turnNotice !== null) {
			return;
		}
		this._turnNotice = "thinking";
		this._turnNoticeAnimationFrame = 0;
		this.startTurnNoticeAnimation();
		this.renderPromptLine();
	}

	private startTurnNoticeAnimation(): void {
		if (this._turnNoticeTimer !== null) {
			return;
		}
		this._turnNoticeTimer = setInterval(() => {
			if (this._turnNotice !== "thinking") {
				return;
			}
			this._turnNoticeAnimationFrame = (this._turnNoticeAnimationFrame + 1) % 3;
			this.renderFooterRegion();
		}, 400);
		this._turnNoticeTimer.unref?.();
	}

	private stopTurnNoticeAnimation(): void {
		if (this._turnNoticeTimer === null) {
			return;
		}
		clearInterval(this._turnNoticeTimer);
		this._turnNoticeTimer = null;
	}

	private renderStreamingAssistantBlock(): void {
		const rendered = formatTranscriptAssistantLine(this._assistantBuffer);
		const lines = wrapTranscriptContent(rendered, process.stdout.columns ?? 80);
		const renderedWidth = this.terminalWidth();
		const rows = countRenderedTerminalRows(lines, renderedWidth);
		const previousStartRow = this._renderedStreamingStartRow;
		const previousRows = this._streamingReservedRows;
		this._streamingDisplayRows = rows;
		this.renderFooterRegion();
		const footerStartRow =
			this._renderedFooterStartRow ??
			computeFooterStartRow(
				this._welcomeLines.length,
				this.terminalHeight(),
				this.currentFooterHeight(),
				this.currentTranscriptDisplayRows(),
			);
		if (isFooterBottomAnchored(footerStartRow, this.terminalHeight(), this.currentFooterHeight())) {
			this.reserveStreamingRows(rows);
		} else {
			this._streamingReservedRows = rows;
		}
		const startRow = footerStartRow - rows;
		const transcriptBottomRow = footerStartRow - 1;
		const clearStartRow = previousStartRow === null ? startRow : Math.min(startRow, previousStartRow);
		const clearEndRow =
			previousStartRow === null
				? transcriptBottomRow
				: Math.max(transcriptBottomRow, previousStartRow + previousRows - 1);
		this.clearTranscriptRows(clearStartRow, clearEndRow);
		this.writeLinesAtRow(startRow, lines, renderedWidth);
		this._renderedStreamingStartRow = startRow;
		this.renderFooterRegion();
	}

	private writeTranscriptText(text: string, newline: boolean, redrawPrompt = true): void {
		this.flushAssistantBuffer(false);
		this.rememberTranscriptBlock(text, newline);
		const logicalLines = text.split("\n");
		const outputLines = newline ? logicalLines : logicalLines.slice(0, -1).concat(logicalLines.at(-1) ?? "");
		if (outputLines.length > 0) {
			this.appendTranscriptLines(outputLines);
		}
		if (redrawPrompt) {
			this.renderFooterRegion();
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

	private startPromptTurn(session: SessionFacade, prompt: string, sink: OutputSink): void {
		this.flushAssistantBuffer(false);
		this.writeTranscriptText(formatTranscriptUserLine(prompt), true, false);
		this.startTurnFeedback();
		this.rememberHistory(prompt);
		this._activeTurn = session
			.prompt(prompt)
			.catch((err) => {
				sink.writeError(`Error: ${err}`);
			})
			.finally(() => {
				this.stopTurnNoticeAnimation();
				this._activeTurn = null;
				this.flushAssistantBuffer(false);
				this._turnNotice = null;
				this._turnNoticeAnimationFrame = 0;
				const nextQueued = this._queuedInputs.shift();
				if (nextQueued) {
					this.startPromptTurn(session, nextQueued, sink);
					return;
				}
				this.fullRedrawInteractiveScreen();
			});
	}

	private buildFooterUi(): InteractiveFooterRenderResult {
		return formatInteractiveFooter({
			terminalWidth: process.stdout.columns ?? 80,
			prompt: this._prompt,
			buffer: this._inputState.buffer,
			cursor: this._inputState.cursor,
			suggestions: this._commandSuggestions,
			turnNotice: this._turnNotice,
			turnNoticeAnimationFrame: this._turnNoticeAnimationFrame,
			queuedInputs: this._queuedInputs,
			permission:
				this._pendingPermissionCallId !== null && this._pendingPermissionDetails !== null
					? {
							details: this._pendingPermissionDetails,
							selectedIndex: this._pendingPermissionSelection,
						}
					: null,
		});
	}

	private rerenderInteractiveRegions(): void {
		this.fullRedrawInteractiveScreen();
	}

	private terminalWidth(): number {
		return Math.max(1, process.stdout.columns ?? 80);
	}

	private terminalHeight(): number {
		return Math.max(6, process.stdout.rows ?? 24);
	}

	private transcriptBottomRow(footerHeight = this.currentFooterHeight()): number {
		return Math.max(1, this.terminalHeight() - footerHeight);
	}

	private currentFooterHeight(): number {
		return this._renderedFooterUi?.lines.length ?? this.buildFooterUi().lines.length;
	}

	private renderFooterRegion(): void {
		const ui = this.buildFooterUi();
		const footerHeight = ui.lines.length;
		const startRow = computeFooterStartRow(
			this._welcomeLines.length,
			this.terminalHeight(),
			footerHeight,
			this.currentTranscriptDisplayRows(),
		);
		const oldStartRow = this._renderedFooterStartRow;
		const oldHeight = this._renderedFooterUi?.lines.length ?? 0;
		if (oldStartRow !== null && oldStartRow !== startRow) {
			for (let index = 0; index < oldHeight; index += 1) {
				this.writeAbsoluteTerminalLine(oldStartRow + index, "");
			}
		}
		if (startRow === Math.max(1, this.terminalHeight() - footerHeight + 1)) {
			this.applyTranscriptViewport(footerHeight);
		}
		for (let index = 0; index < footerHeight; index += 1) {
			const row = startRow + index;
			const line = fitTerminalLine(ui.lines[index] ?? "", this.terminalWidth());
			this.writeAbsoluteTerminalLine(row, line);
		}
		for (let index = footerHeight; index < oldHeight; index += 1) {
			this.writeAbsoluteTerminalLine(startRow + index, "");
		}
		process.stdout.write(
			ansiCursorTo(
				startRow + ui.cursorLineIndex,
				computeFooterCursorColumn(this.terminalWidth(), ui.cursorColumn) + 1,
			),
		);
		process.stdout.write(ansiShowCursor());
		this._renderedFooterUi = { ...ui, renderedWidth: this.terminalWidth() };
		this._renderedFooterStartRow = startRow;
	}

	private applyTranscriptViewport(footerHeight: number): void {
		process.stdout.write(ansiSetScrollRegion(1, this.transcriptBottomRow(footerHeight)));
	}

	private appendTranscriptLines(lines: readonly string[]): void {
		if (lines.length === 0) {
			return;
		}
		this.fullRedrawInteractiveScreen();
	}

	private reserveStreamingRows(rows: number): void {
		if (rows <= this._streamingReservedRows) {
			return;
		}
		this.applyTranscriptViewport(this.currentFooterHeight());
		for (let index = this._streamingReservedRows; index < rows; index += 1) {
			process.stdout.write(ansiCursorTo(this.transcriptBottomRow(), 1));
			process.stdout.write("\n");
		}
		this._streamingReservedRows = rows;
	}

	private clearTranscriptRows(startRow: number, endRow: number): void {
		for (let row = startRow; row <= endRow; row += 1) {
			this.writeAbsoluteTerminalLine(row, "");
		}
	}

	private writeLinesAtRow(startRow: number, lines: readonly string[], width: number): void {
		for (let index = 0; index < lines.length; index += 1) {
			this.writeAbsoluteTerminalLine(startRow + index, fitTerminalLine(lines[index] ?? "", width));
		}
	}

	private writeAbsoluteTerminalLine(row: number, line: string): void {
		process.stdout.write(ansiDisableAutoWrap());
		process.stdout.write(ansiCursorTo(row, 1));
		process.stdout.write(ansiClearLine());
		process.stdout.write(line);
		process.stdout.write(ansiEnableAutoWrap());
	}

	private rememberTranscriptBlock(text: string, newline: boolean): void {
		const block = newline ? text : text.replace(/\n$/, "");
		if (block.length === 0) {
			return;
		}
		this._transcriptBlocks.push(block);
	}

	private rememberAssistantTranscriptBlock(block: string): void {
		const nextBlocks = appendAssistantTranscriptBlock(this._transcriptBlocks, block);
		this._transcriptBlocks.length = 0;
		this._transcriptBlocks.push(...nextBlocks);
	}

	private fullRedrawInteractiveScreen(): void {
		if (this._welcomeLines.length === 0) {
			return;
		}
		process.stdout.write(ansiResetScrollRegion());
		process.stdout.write(ansiCursorHome());
		process.stdout.write("\x1b[2J");
		for (let index = 0; index < this._welcomeLines.length; index += 1) {
			this.writeAbsoluteTerminalLine(
				index + 1,
				fitTerminalLine(this._welcomeLines[index] ?? "", this.terminalWidth()),
			);
		}
		this._renderedFooterUi = null;
		this._renderedFooterStartRow = null;
		this._streamingReservedRows = 0;
		this._renderedStreamingStartRow = null;
		this._streamingDisplayRows =
			this._assistantBuffer.length > 0
				? countRenderedTerminalRows(
						wrapTranscriptContent(formatTranscriptAssistantLine(this._assistantBuffer), this.terminalWidth()),
						this.terminalWidth(),
					)
				: 0;
		this.renderTranscriptViewport();
		this.renderFooterRegion();
		if (this._assistantBuffer.length > 0) {
			this.renderStreamingAssistantBlock();
		}
	}

	private renderTranscriptViewport(): void {
		const footerUi = this.buildFooterUi();
		const transcriptTopRow = this._welcomeLines.length + 1;
		const transcriptBottomRow =
			computeFooterStartRow(
				this._welcomeLines.length,
				this.terminalHeight(),
				footerUi.lines.length,
				this.currentTranscriptDisplayRows(),
			) - 1;
		const availableRows = Math.max(0, transcriptBottomRow - transcriptTopRow + 1);
		const visibleLines = computeVisibleTranscriptLines(this._transcriptBlocks, this.terminalWidth(), availableRows);
		for (let row = transcriptTopRow; row <= transcriptBottomRow; row += 1) {
			const index = row - transcriptTopRow;
			this.writeAbsoluteTerminalLine(row, fitTerminalLine(visibleLines[index] ?? "", this.terminalWidth()));
		}
	}

	private currentTranscriptDisplayRows(): number {
		return computeTranscriptDisplayRows(this._transcriptBlocks, this.terminalWidth()) + this._streamingDisplayRows;
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

function parsePermissionDecision(input: string, selectedIndex = 0): "allow_once" | "allow_for_session" | "deny" | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return permissionDecisionFromSelection(selectedIndex);
	if (trimmed === "y" || trimmed.toLowerCase() === "yes") return "allow_once";
	if (trimmed === "Y") return "allow_for_session";
	if (trimmed === "n" || trimmed.toLowerCase() === "no") return "deny";
	if (trimmed === "1") return "allow_once";
	if (trimmed === "2") return "allow_for_session";
	if (trimmed === "3") return "deny";
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

function applyWelcomeBorderColor(text: string): string {
	return `${INTERACTIVE_THEME.welcomeBorder}${text}${INTERACTIVE_THEME.reset}`;
}

function buildWelcomeHintLine(width: number): string {
	if (width < 64) {
		return "Start: Enter  Help: /help  Scroll: wheel/PageUp/PageDown";
	}
	return "Start: type a prompt and press Enter  Help: /help  Scroll: wheel/PageUp/PageDown";
}

export const WELCOME_BIBLE_GREETINGS = [
	"Let there be light.",
	"Seek, and ye shall find.",
	"Knock, and it shall be opened.",
	"Write the vision plainly.",
	"Iron sharpeneth iron.",
	"The truth shall make you free.",
	"A wise man will hear.",
	"Let all things be done decently.",
] as const;

export function pickWelcomeGreeting(randomValue = Math.random()): string {
	const size = WELCOME_BIBLE_GREETINGS.length;
	const normalized = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 0.999999999999) : 0;
	return WELCOME_BIBLE_GREETINGS[Math.floor(normalized * size)] ?? WELCOME_BIBLE_GREETINGS[0];
}

export function buildWelcomeLines(input: {
	terminalWidth: number;
	version: string;
	model: string;
	provider: string;
	greeting: string;
}): readonly string[] {
	const width = Math.max(24, Math.min(input.terminalWidth, 100));
	const DIM = INTERACTIVE_THEME.muted;
	const RESET = INTERACTIVE_THEME.reset;
	const GREEN = INTERACTIVE_THEME.success;
	const CYAN = INTERACTIVE_THEME.brand;
	const BOLD = INTERACTIVE_THEME.bold;
	const contentWidth = width - 2;
	const center = (text: string): string => formatWelcomeCenteredLine(contentWidth, text);
	const fill = (text = ""): string => formatWelcomeFilledLine(contentWidth, text);
	return [
		formatWelcomeTopBorder(width, input.version),
		fill(),
		center(`${BOLD}${input.greeting}${RESET}`),
		fill(),
		center(`${DIM}        ${GREEN}✦${RESET}        ${RESET}`),
		center(`${CYAN}      ──╂──      ${RESET}`),
		center(`${DIM}        ${CYAN}│${RESET}        ${RESET}`),
		fill(),
		center(`${CYAN}${input.model}${RESET} ${DIM}via${RESET} ${input.provider}`),
		formatWelcomeBottomBorder(width),
		buildWelcomeHintLine(width),
	];
}

export function formatWelcomeTopBorder(width: number, version: string): string {
	const label = `╭─── ${INTERACTIVE_THEME.bold}${INTERACTIVE_THEME.welcomeTitle}Genesis CLI${INTERACTIVE_THEME.reset} ${INTERACTIVE_THEME.muted}v${version}${INTERACTIVE_THEME.reset} `;
	const plainWidth = measureTerminalDisplayWidth(stripAnsiWelcome(label));
	return applyWelcomeBorderColor(`${label}${"─".repeat(Math.max(0, width - plainWidth - 1))}╮`);
}

export function formatWelcomeBottomBorder(width: number): string {
	return applyWelcomeBorderColor(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

export function formatWelcomeFilledLine(contentWidth: number, text = ""): string {
	const plainWidth = measureTerminalDisplayWidth(stripAnsiWelcome(text));
	const padding = Math.max(0, contentWidth - plainWidth);
	return `${applyWelcomeBorderColor("│")}${text}${" ".repeat(padding)}${applyWelcomeBorderColor("│")}`;
}

export function formatWelcomeCenteredLine(contentWidth: number, text: string): string {
	const plainWidth = measureTerminalDisplayWidth(stripAnsiWelcome(text));
	const padding = Math.max(0, contentWidth - plainWidth);
	const left = Math.floor(padding / 2);
	const right = padding - left;
	return `${applyWelcomeBorderColor("│")}${" ".repeat(left)}${text}${" ".repeat(right)}${applyWelcomeBorderColor("│")}`;
}

export function computePromptCursorColumn(prompt: string, buffer: string, cursor: number): number {
	return measureTerminalDisplayWidth(prompt) + measureTerminalDisplayWidth(buffer.slice(0, cursor));
}

export function shouldRenderInteractiveTranscriptEvent(event: RuntimeEvent): boolean {
	if (event.category === "session") return false;
	if (event.category === "tool") return false;
	if (event.category === "compaction") return false;
	if (event.category === "permission") return false;
	return true;
}

export function formatInteractiveToolEvent(
	event: RuntimeEvent,
	startedParameters?: Readonly<Record<string, unknown>>,
): string {
	if (event.category !== "tool") return "";
	if (event.type === "tool_started") {
		return [
			formatInteractiveToolTitle(event.toolName, event.parameters),
			formatInteractiveToolPreview(event.toolName, event.parameters),
		]
			.filter((part) => part.length > 0)
			.join("\n");
	}
	if (event.type === "tool_completed") {
		return formatInteractiveToolResult(event.toolName, event.result, startedParameters);
	}
	if (event.type === "tool_denied") {
		return "";
	}
	return "";
}

export function formatInteractivePermissionBlock(
	details: {
		toolName: string;
		riskLevel: string;
		reason?: string;
		targetPath?: string;
	},
	selectedIndex = 0,
): string {
	const lines = formatInteractivePermissionBodyLines(details, selectedIndex);
	lines.splice(1, 0, "────────────────────────────────────────");
	return lines.join("\n");
}

export interface InteractiveFooterRenderResult {
	readonly block: string;
	readonly lines: readonly string[];
	readonly cursorLineIndex: number;
	readonly cursorColumn: number;
	readonly renderedWidth: number;
}

export interface InteractiveStreamingRenderResult {
	readonly lines: readonly string[];
	readonly renderedWidth: number;
	readonly startRow: number;
	readonly reservedRows: number;
}

export function formatInteractiveFooter(state: {
	readonly terminalWidth: number;
	readonly prompt: string;
	readonly buffer: string;
	readonly cursor: number;
	readonly suggestions: readonly string[];
	readonly turnNotice: "thinking" | "responding" | null;
	readonly turnNoticeAnimationFrame?: number;
	readonly queuedInputs?: readonly string[];
	readonly permission: {
		readonly details: {
			toolName: string;
			riskLevel: string;
			reason?: string;
			targetPath?: string;
		};
		readonly selectedIndex: number;
	} | null;
}): InteractiveFooterRenderResult {
	const separator = formatInteractiveInputSeparator(computeInteractiveFooterSeparatorWidth(state.terminalWidth));
	const lines: string[] = [];
	if (state.turnNotice !== null) {
		lines.push(
			formatTurnNotice(state.turnNotice, {
				animationFrame: state.turnNoticeAnimationFrame ?? 0,
				queuedCount: state.queuedInputs?.length ?? 0,
			}),
		);
	}
	if ((state.queuedInputs?.length ?? 0) > 0) {
		lines.push(...formatQueuedPromptPreviewLines(state.queuedInputs ?? [], state.terminalWidth));
	}
	lines.push(separator);
	if (state.permission !== null) {
		lines.push(...formatInteractivePermissionBodyLines(state.permission.details, state.permission.selectedIndex));
		const prompt = "choice [Enter/1/2/3]> ";
		lines.push(`${prompt}${state.buffer}`);
		lines.push(separator);
		return {
			block: lines.join("\n"),
			lines,
			cursorLineIndex: lines.length - 2,
			cursorColumn: computePromptCursorColumn(prompt, state.buffer, state.cursor),
			renderedWidth: Math.max(1, state.terminalWidth),
		};
	}
	const hint = formatSlashSuggestionHint(
		state.suggestions,
		state.terminalWidth - computePromptCursorColumn(state.prompt, state.buffer, state.buffer.length),
	);
	lines.push(`${state.prompt}${formatInteractivePromptBuffer(state.buffer, false)}${hint}`);
	lines.push(separator);
	return {
		block: lines.join("\n"),
		lines,
		cursorLineIndex: lines.length - 2,
		cursorColumn: computePromptCursorColumn(state.prompt, state.buffer, state.cursor),
		renderedWidth: Math.max(1, state.terminalWidth),
	};
}

export function movePermissionSelection(current: number, direction: -1 | 1): number {
	const size = 3;
	return (current + direction + size) % size;
}

export function permissionDecisionFromSelection(selectedIndex: number): "allow_once" | "allow_for_session" | "deny" {
	if (selectedIndex === 1) return "allow_for_session";
	if (selectedIndex === 2) return "deny";
	return "allow_once";
}

function formatPermissionChoiceLine(index: number, selectedIndex: number, label: string): string {
	const prefix = index === selectedIndex ? "❯" : " ";
	if (index === selectedIndex) {
		return `${prefix} ${INTERACTIVE_THEME.selectedBg}${INTERACTIVE_THEME.selectedFg}${index + 1}. ${label}${INTERACTIVE_THEME.reset}`;
	}
	return `${prefix} ${index + 1}. ${label}`;
}

function formatInteractivePermissionBodyLines(
	details: {
		toolName: string;
		riskLevel: string;
		reason?: string;
		targetPath?: string;
	},
	selectedIndex: number,
): string[] {
	return [
		formatInteractiveToolTitle(details.toolName, details.targetPath ? { file_path: details.targetPath } : {}),
		formatPermissionQuestion(details),
		formatPermissionChoiceLine(0, selectedIndex, "Yes"),
		formatPermissionChoiceLine(1, selectedIndex, "Yes, allow during this session"),
		formatPermissionChoiceLine(2, selectedIndex, "No"),
	];
}

function formatPermissionQuestion(details: {
	toolName: string;
	riskLevel: string;
	reason?: string;
	targetPath?: string;
}): string {
	if (details.toolName === "write" || details.toolName === "edit") {
		const target = details.targetPath ? basename(details.targetPath) : "this file";
		const action = details.toolName === "write" ? "create or overwrite" : "edit";
		return `Do you want to ${action} ${target}?`;
	}
	return `Allow ${details.toolName} (${details.riskLevel})${details.reason ? ` — ${details.reason}` : ""}?`;
}

export function formatInteractiveToolTitle(
	toolName: string,
	parameters: Readonly<Record<string, unknown>> | { file_path?: string; path?: string } = {},
): string {
	const name = interactiveToolDisplayName(toolName);
	const summary = summarizeToolParameters(toolName, parameters);
	return summary.length > 0 ? `⏺ ${name}(${summary})` : `⏺ ${name}`;
}

export function formatInteractiveToolResult(
	toolName: string,
	result?: string,
	startedParameters?: Readonly<Record<string, unknown>>,
): string {
	const lines = normalizeToolResultLines(toolName, result, startedParameters);
	if (lines.length === 0) return "";
	return lines.map((line, index) => `${index === 0 ? "  ⎿" : "   "} ${line}`).join("\n");
}

function formatInteractiveToolPreview(toolName: string, parameters: Readonly<Record<string, unknown>>): string {
	if (toolName !== "write" && toolName !== "edit") return "";
	if (toolName === "edit") {
		const oldString = typeof parameters.old_string === "string" ? parameters.old_string : "";
		const newString = typeof parameters.new_string === "string" ? parameters.new_string : "";
		const diff = formatMiniDiffPreview(oldString, newString);
		if (diff.length > 0) {
			return diff;
		}
	}
	const previewSource = typeof parameters.content === "string" ? parameters.content : "";
	if (previewSource.trim().length === 0) return "";
	const previewLines = previewSource.trimEnd().split("\n").slice(0, 4);
	return ["  │ Preview", ...previewLines.map((line) => `  │ ${truncatePreviewLine(line)}`)]
		.filter((line) => line.length > 0)
		.join("\n");
}

function interactiveToolDisplayName(toolName: string): string {
	switch (toolName) {
		case "bash":
			return "Bash";
		case "write":
			return "Write";
		case "edit":
			return "Edit";
		case "read":
			return "Read";
		case "grep":
			return "Grep";
		case "find":
			return "Find";
		case "ls":
			return "LS";
		default:
			return toolName;
	}
}

function summarizeToolParameters(
	toolName: string,
	parameters: Readonly<Record<string, unknown>> | { file_path?: string; path?: string },
): string {
	if (toolName === "bash" && typeof (parameters as Record<string, unknown>).command === "string") {
		return (parameters as Record<string, unknown>).command as string;
	}
	const filePath =
		typeof parameters.file_path === "string"
			? parameters.file_path
			: typeof parameters.path === "string"
				? parameters.path
				: undefined;
	if (filePath) {
		return basename(filePath);
	}
	if (toolName === "grep" && typeof (parameters as Record<string, unknown>).pattern === "string") {
		return (parameters as Record<string, unknown>).pattern as string;
	}
	return "";
}

function normalizeToolResultLines(
	toolName: string,
	result?: string,
	startedParameters?: Readonly<Record<string, unknown>>,
): readonly string[] {
	if ((!result || result.trim().length === 0) && startedParameters) {
		if (toolName === "write" || toolName === "edit") {
			const target =
				typeof startedParameters.file_path === "string"
					? basename(startedParameters.file_path)
					: typeof startedParameters.path === "string"
						? basename(startedParameters.path)
						: "file";
			const previewSource =
				typeof startedParameters.content === "string"
					? startedParameters.content
					: typeof startedParameters.new_string === "string"
						? startedParameters.new_string
						: "";
			const lineCount = previewSource.length > 0 ? previewSource.split("\n").length : null;
			if (toolName === "write") {
				return [`Wrote ${lineCount ?? 1} lines to ${target}`];
			}
			const replacementCount =
				typeof startedParameters.old_string === "string" || typeof startedParameters.new_string === "string"
					? 1
					: null;
			return [
				`Applied edit to ${target}${replacementCount ? ` (${replacementCount} change)` : lineCount ? ` (${lineCount} lines)` : ""}`,
			];
		}
		if (toolName === "bash" && typeof startedParameters.command === "string") {
			return [`Ran: ${startedParameters.command}`];
		}
	}
	if (!result || result.trim().length === 0) return [];
	if (toolName === "write" || toolName === "edit") {
		const lines = result.trimEnd().split("\n");
		return lines.slice(0, 4);
	}
	return result.trimEnd().split("\n").slice(0, 6);
}

function truncatePreviewLine(line: string): string {
	return measureTerminalDisplayWidth(line) <= 72 ? line : `${line.slice(0, 69)}...`;
}

function formatMiniDiffPreview(oldString: string, newString: string): string {
	if (oldString.trim().length === 0 && newString.trim().length === 0) return "";
	const removed = oldString
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.slice(0, 2);
	const added = newString
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.slice(0, 2);
	const lines = ["  │ Diff"];
	lines.push(...removed.map((line) => `  - ${truncatePreviewLine(line)}`));
	lines.push(...added.map((line) => `  + ${truncatePreviewLine(line)}`));
	return lines.join("\n");
}

export function computeSlashSuggestions(input: string, commands: readonly SlashCommand[]): readonly string[] {
	const trimmed = input.trimStart();
	if (!trimmed.startsWith("/")) return [];
	const body = trimmed.slice(1);
	if (body.includes(" ")) return [];
	const query = body.toLowerCase();
	return commands
		.map((command) => command.name)
		.filter((name) => query.length === 0 || name.startsWith(query))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, 6);
}

export function formatSlashSuggestionHint(suggestions: readonly string[], remainingWidth: number): string {
	if (suggestions.length === 0 || remainingWidth < 6) return "";
	const DIM = "\x1b[2m";
	const RESET = "\x1b[0m";
	let hint = "";
	for (const name of suggestions) {
		const segment = `${hint.length === 0 ? "  " : "  "}/${name}`;
		if (measureTerminalDisplayWidth(hint + segment) > remainingWidth) {
			break;
		}
		hint += segment;
	}
	return hint.length > 0 ? `${DIM}${hint}${RESET}` : "";
}

export function acceptFirstSlashSuggestion(
	state: { buffer: string; cursor: number },
	suggestions: readonly string[],
): { buffer: string; cursor: number } | null {
	if (suggestions.length === 0) return null;
	if (state.cursor !== state.buffer.length) return null;
	const trimmed = state.buffer.trimStart();
	if (!trimmed.startsWith("/")) return null;
	if (trimmed.slice(1).includes(" ")) return null;
	const nextBuffer = `/${suggestions[0]} `;
	return {
		buffer: nextBuffer,
		cursor: nextBuffer.length,
	};
}

export function formatTranscriptUserLine(content: string): string {
	return `${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg} ${content} ${INTERACTIVE_THEME.reset}`;
}

export function formatTranscriptAssistantLine(content: string): string {
	return `${INTERACTIVE_THEME.assistantBullet}⏺${INTERACTIVE_THEME.reset} ${content}`;
}

export function formatInteractivePromptBuffer(content: string, plain = false): string {
	if (plain) return content;
	return content;
}

export function formatInteractiveInputSeparator(width: number): string {
	return `${INTERACTIVE_THEME.muted}${"─".repeat(Math.max(1, width))}${INTERACTIVE_THEME.reset}`;
}

export function computeInteractiveFooterSeparatorWidth(terminalWidth: number): number {
	return Math.max(20, terminalWidth);
}

export function computeFooterCursorColumn(width: number, cursorColumn: number): number {
	const safeWidth = Math.max(1, width);
	return Math.max(0, cursorColumn % safeWidth);
}

export function countRenderedTerminalRows(lines: readonly string[], width: number): number {
	const safeWidth = Math.max(1, width);
	let total = 0;
	for (const line of lines) {
		const plain = stripAnsiWelcome(line);
		const visibleWidth = Math.max(1, measureTerminalDisplayWidth(plain));
		total += Math.max(1, Math.ceil(visibleWidth / safeWidth));
	}
	return total;
}

export function computePromptCursorRowsUp(lines: readonly string[], width: number, cursorColumn: number): number {
	const safeWidth = Math.max(1, width);
	const rowsBeforePrompt = countRenderedTerminalRows(lines.slice(0, 1), safeWidth);
	const promptRowOffset = Math.floor(Math.max(0, cursorColumn) / safeWidth);
	return rowsBeforePrompt + promptRowOffset;
}

export function computeFooterCursorRowsUp(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	const safeWidth = Math.max(1, width);
	const rowsBeforeCursor = countRenderedTerminalRows(lines.slice(0, cursorLineIndex), safeWidth);
	const cursorRowOffset = Math.floor(Math.max(0, cursorColumn) / safeWidth);
	return rowsBeforeCursor + cursorRowOffset;
}

export function computeFooterCursorRowsFromEnd(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	const totalRows = countRenderedTerminalRows(lines, width);
	const rowsUp = computeFooterCursorRowsUp(lines, width, cursorLineIndex, cursorColumn);
	return Math.max(0, totalRows - rowsUp - 1);
}

export function computeInteractiveEphemeralRows(
	streaming: InteractiveStreamingRenderResult | null,
	footer: InteractiveFooterRenderResult | null,
): number {
	const footerRowsUp =
		footer === null
			? 0
			: computeFooterCursorRowsUp(footer.lines, footer.renderedWidth, footer.cursorLineIndex, footer.cursorColumn);
	const streamingRows = streaming === null ? 0 : countRenderedTerminalRows(streaming.lines, streaming.renderedWidth);
	return footerRowsUp + streamingRows;
}

function ansiCursorTo(row: number, column: number): string {
	return `\x1b[${Math.max(1, row)};${Math.max(1, column)}H`;
}

function ansiSetScrollRegion(top: number, bottom: number): string {
	return `\x1b[${Math.max(1, top)};${Math.max(1, bottom)}r`;
}

function ansiResetScrollRegion(): string {
	return "\x1b[r";
}

function ansiDisableAutoWrap(): string {
	return "\x1b[?7l";
}

function ansiEnableAutoWrap(): string {
	return "\x1b[?7h";
}

export function fitTerminalLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const visibleWidth = measureTerminalDisplayWidth(stripAnsiWelcome(line));
	if (visibleWidth <= safeWidth) {
		return `${line}${" ".repeat(safeWidth - visibleWidth)}`;
	}
	const truncated = truncatePlainTerminalText(stripAnsiWelcome(line), safeWidth);
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - measureTerminalDisplayWidth(truncated)))}`;
}

function truncatePlainTerminalText(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	let output = "";
	let used = 0;
	for (const ch of text) {
		const charWidth = measureTerminalDisplayWidth(ch);
		if (used + charWidth > safeWidth) {
			break;
		}
		output += ch;
		used += charWidth;
	}
	return output;
}

function formatQueuedPromptPreviewLines(queuedInputs: readonly string[], terminalWidth: number): readonly string[] {
	const DIM = "\x1b[2m";
	const YELLOW = "\x1b[33m";
	const RESET = "\x1b[0m";
	const maxVisible = 2;
	const previewWidth = Math.max(12, terminalWidth - 18);
	const lines = queuedInputs.slice(0, maxVisible).map((input, index) => {
		const label = queuedInputs.length > 1 ? `↳ Queued ${index + 1}: ` : "↳ Queued: ";
		return `${DIM}${YELLOW}${label}${RESET}${truncatePlainTerminalText(input, previewWidth)}`;
	});
	if (queuedInputs.length > maxVisible) {
		lines.push(`${DIM}${YELLOW}↳ +${queuedInputs.length - maxVisible} more queued${RESET}`);
	}
	return lines;
}

export function formatTurnNotice(
	kind: "thinking" | "responding",
	options: {
		readonly animationFrame?: number;
		readonly queuedCount?: number;
		readonly tokenCount?: number;
	} = {},
): string {
	const DIM = "\x1b[2m";
	const CYAN = "\x1b[36m";
	const RESET = "\x1b[0m";
	const suffix = kind === "thinking" ? ".".repeat(((options.animationFrame ?? 0) % 3) + 1) : "...";
	const label = kind === "thinking" ? `Thinking${suffix}` : `Responding${suffix}`;
	const meta: string[] = [];
	if (typeof options.tokenCount === "number" && Number.isFinite(options.tokenCount)) {
		meta.push(`${options.tokenCount} tokens`);
	}
	if ((options.queuedCount ?? 0) > 0) {
		meta.push(`${options.queuedCount} queued`);
	}
	return `${DIM}${CYAN}· ${label}${meta.length > 0 ? ` (${meta.join(" · ")})` : ""}${RESET}`;
}

export function mergeStreamingText(existing: string, incoming: string): string {
	if (incoming.length === 0) return existing;
	if (existing.length === 0) return incoming;
	if (incoming.startsWith(existing)) return incoming;
	const embeddedExistingIndex = incoming.indexOf(existing);
	if (embeddedExistingIndex >= 0 && embeddedExistingIndex <= 8) {
		return incoming.slice(embeddedExistingIndex);
	}
	if (existing.endsWith(incoming)) return existing;

	const trimmedIncoming = incoming.trimStart();
	if (trimmedIncoming.startsWith(existing)) return trimmedIncoming;

	const maxOverlap = Math.min(existing.length, incoming.length);
	for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
		if (existing.endsWith(incoming.slice(0, overlap))) {
			return `${existing}${incoming.slice(overlap)}`;
		}
	}
	const trimmedMaxOverlap = Math.min(existing.length, trimmedIncoming.length);
	for (let overlap = trimmedMaxOverlap; overlap > 0; overlap -= 1) {
		if (existing.endsWith(trimmedIncoming.slice(0, overlap))) {
			return `${existing}${trimmedIncoming.slice(overlap)}`;
		}
	}
	return `${existing}${incoming}`;
}

export function wrapTranscriptContent(content: string, width: number): readonly string[] {
	if (content.length === 0) {
		return [""];
	}
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const ch of content.replace(/\r\n/g, "\n")) {
		if (ch === "\n") {
			lines.push(current);
			current = "";
			currentWidth = 0;
			continue;
		}
		const charWidth = measureTerminalDisplayWidth(ch);
		if (currentWidth + charWidth > width && current.length > 0) {
			lines.push(current);
			current = ch;
			currentWidth = charWidth;
			continue;
		}
		current += ch;
		currentWidth += charWidth;
	}
	lines.push(current);
	return lines;
}

export function computeVisibleTranscriptLines(
	blocks: readonly string[],
	width: number,
	maxRows: number,
): readonly string[] {
	if (maxRows <= 0 || blocks.length === 0) {
		return [];
	}
	const flattened = flattenTranscriptLines(blocks, width);
	if (flattened.length <= maxRows) {
		return flattened;
	}
	return flattened.slice(flattened.length - maxRows);
}

export function computeTranscriptDisplayRows(blocks: readonly string[], width: number): number {
	return flattenTranscriptLines(blocks, width).length;
}

export function materializeAssistantTranscriptBlock(buffer: string): string | null {
	if (buffer.length === 0) {
		return null;
	}
	return formatTranscriptAssistantLine(buffer);
}

export function appendAssistantTranscriptBlock(blocks: readonly string[], assistantBlock: string): readonly string[] {
	const lastNonEmptyBlock = [...blocks].reverse().find((block) => block.length > 0);
	if (lastNonEmptyBlock && isTranscriptUserBlock(lastNonEmptyBlock)) {
		return [...blocks, "", assistantBlock];
	}
	return [...blocks, assistantBlock];
}

export function computeFooterStartRow(
	welcomeLineCount: number,
	terminalHeight: number,
	footerHeight: number,
	transcriptRows: number,
): number {
	const naturalStartRow = welcomeLineCount + 1 + Math.max(0, transcriptRows);
	const bottomAnchoredStartRow = Math.max(1, terminalHeight - footerHeight + 1);
	return Math.min(naturalStartRow, bottomAnchoredStartRow);
}

function isFooterBottomAnchored(startRow: number, terminalHeight: number, footerHeight: number): boolean {
	return startRow === Math.max(1, terminalHeight - footerHeight + 1);
}

function flattenTranscriptLines(blocks: readonly string[], width: number): string[] {
	const flattened: string[] = [];
	for (const block of blocks) {
		for (const logicalLine of block.split("\n")) {
			flattened.push(...wrapTranscriptContent(logicalLine, width));
		}
	}
	return flattened;
}

function isTranscriptUserBlock(block: string): boolean {
	return block.startsWith(`${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg} `);
}
