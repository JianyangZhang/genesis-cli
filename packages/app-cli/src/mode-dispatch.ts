/**
 * Mode dispatch — four CLI mode handlers sharing the same AppRuntime.
 *
 * Each mode handler receives an identical AppRuntime and creates sessions
 * from it. Mode-specific behavior is isolated to how events are rendered.
 */

import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
	AppRuntime,
	CliMode,
	CompactionSummary,
	RecentSessionEntry,
	RecentSessionSearchHit,
	RuntimeEvent,
	SessionClosedEvent,
	SessionFacade,
} from "@pickle-pee/runtime";
import {
	composePromptBlock,
	composeSectionBlock,
	composeScreenWithFooter,
	computeEphemeralRows,
	computeFooterCursorColumn as computeFooterCursorColumnFromTuiCore,
	computeFooterCursorRowsFromEnd as computeFooterCursorRowsFromEndFromTuiCore,
	computeFooterCursorRowsUp as computeFooterCursorRowsUpFromTuiCore,
	computePromptCursorColumn as computePromptCursorColumnFromTuiCore,
	computeSelectionColumnsForRow,
	computeFooterStartRow as computeFooterStartRowFromTuiCore,
	computePromptCursorRowsUp as computePromptCursorRowsUpFromTuiCore,
	computeTranscriptDisplayRows as computeTranscriptDisplayRowsFromTuiCore,
	computeVisibleViewportLines,
	countRenderedTerminalRows as countRenderedTerminalRowsFromTuiCore,
	createInteractiveModePlan,
	detectTerminalCapabilities,
	diffScreenFrames,
	encodeFramePatches,
	encodeResetScrollRegion,
	encodeSetScrollRegion,
	extractPlainTextSelection as extractPlainTextSelectionFromTuiCore,
	fitTerminalLine as fitTerminalLineFromTuiCore,
	materializeComposerBlock,
	materializeTextBlock,
	stripAnsiControlSequences,
	renderSelectedPlainLine,
	summarizeFramePatches,
	summarizeScreenFrame,
	summarizeTerminalCapabilities,
	summarizeTerminalModePlan,
	truncatePlainText as truncatePlainTextFromTuiCore,
	type ComposedScreen,
	type RenderedComposerBlock,
	type ScreenFrame,
	type TerminalSelectionRange,
	wrapTranscriptContent as wrapTranscriptContentFromTuiCore,
} from "@pickle-pee/tui-core";
import type { InteractionState, OutputSink, ResumeBrowserState, SlashCommand } from "@pickle-pee/ui";
import {
	ansiShowCursor,
	buildInteractiveFooterLeadingLines as buildInteractiveFooterLeadingLinesFromUi,
	createBuiltinCommands,
	createSlashCommandRegistry,
	eventToJsonEnvelope,
	formatEventAsText,
	formatResumeBrowserTranscriptBlocks,
	formatTurnNotice as formatTurnNoticeFromUi,
	initialInteractionState,
	moveResumeBrowserSelection,
	reduceInteractionState,
} from "@pickle-pee/ui";
import type { InputLoop } from "./input-loop.js";
import { createInputLoop } from "./input-loop.js";
import { createModelCommandHost, type ModelCommandHostOptions } from "./model-command-host.js";
import type { RpcServer } from "./rpc-server.js";
import { getActiveDebugLogger } from "./debug-logger.js";
import { createRpcServer } from "./rpc-server.js";
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

export function createModeHandler(mode: CliMode, options?: { readonly modelHost?: ModelCommandHostOptions }): ModeHandler {
	switch (mode) {
		case "interactive":
			return new InteractiveModeHandler(options?.modelHost);
		case "print":
			return new PrintModeHandler();
		case "json":
			return new JsonModeHandler();
		case "rpc":
			return new RpcModeHandler();
	}
}

interface UsageSnapshot {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

const RESIZE_REDRAW_DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

class InteractiveModeHandler implements ModeHandler {
	constructor(private readonly _modelHostOptions?: ModelCommandHostOptions) {}

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
	private _turnNotice: "thinking" | "responding" | "compacting" | null = null;
	private _turnNoticeAnimationFrame = 0;
	private _turnNoticeTimer: ReturnType<typeof setInterval> | null = null;
	private _turnStartedAt: number | null = null;
	private _detailPanelExpanded = false;
	private _detailPanelScroll = 0;
	private _thinkingBuffer = "";
	private _compactionDetailText = "";
	private _activeTurnUsageTotals: UsageSnapshot = emptyUsageSnapshot();
	private _currentMessageUsage: UsageSnapshot = emptyUsageSnapshot();
	private _lastTurnUsage: UsageSnapshot | null = null;
	private _sessionUsageTotals: UsageSnapshot = emptyUsageSnapshot();
	private _commandSuggestions: readonly string[] = [];
	private readonly _toolCalls = new Map<string, { toolName: string; parameters: Readonly<Record<string, unknown>> }>();
	private readonly _queuedInputs: string[] = [];
	private _pendingPermissionSelection = 0;
	private _renderedFooterUi: InteractiveFooterRenderResult | null = null;
	private _renderedFooterStartRow: number | null = null;
	private _lastScreenFrame: ScreenFrame | null = null;
	private _welcomeLines: readonly string[] = [];
	private _transcriptScrollOffset = 0;
	private _renderedTranscriptViewportLines: readonly string[] = [];
	private _mouseSelection: {
		anchorRow: number;
		anchorColumn: number;
		focusRow: number;
		focusColumn: number;
	} | null = null;
	private _resumeBrowser: ResumeBrowserState | null = null;
	private _resumeSearchRequestId = 0;
	private _inputLoop: InputLoop | null = null;
	private _activeLocalCommand: Promise<void> | null = null;

	async start(runtime: AppRuntime): Promise<void> {
		const handler = this;
		const commandHost = createModelCommandHost(this._modelHostOptions ?? {});
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
		const terminalCapabilities = detectTerminalCapabilities({
			term: process.env.TERM,
			termProgram: process.env.TERM_PROGRAM,
			terminalEmulator: process.env.TERMINAL_EMULATOR,
			tmux: process.env.TMUX,
		});
		const terminalModePlan = createInteractiveModePlan({
			...terminalCapabilities,
			// Old input-loop path does not yet parse bracketed paste envelopes safely.
			bracketedPaste: false,
		});
		getActiveDebugLogger()?.debug("tui.capabilities", "Resolved terminal capabilities", {
			env: {
				term: process.env.TERM,
				termProgram: process.env.TERM_PROGRAM,
				terminalEmulator: process.env.TERMINAL_EMULATOR,
				tmux: process.env.TMUX,
			},
			capabilities: summarizeTerminalCapabilities(terminalCapabilities),
			modePlan: summarizeTerminalModePlan(terminalModePlan),
		});
		const ttySession = createTtySession({
			onResume: () => {
				this.rerenderInteractiveRegions();
			},
			modePlan: terminalModePlan,
		});
		const debouncedResizeRedraw = createDebouncedCallback(() => {
			this.rerenderInteractiveRegions();
		}, RESIZE_REDRAW_DEBOUNCE_MS);
		const onResize = (): void => {
			debouncedResizeRedraw.schedule();
		};
		process.stdout.on("resize", onResize);
		let detachSessionStateListener: (() => void) | null = null;

		const resolveAgentDir = (): string => {
			return (
				sessionRef.current.context.agentDir ??
				join(sessionRef.current.context.workingDirectory, ".genesis-local", "pi-agent")
			);
		};

		const attachSession = (next: SessionFacade): void => {
			detachSessionStateSubscription(detachSessionStateListener);
			detachSessionStateListener = null;
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
			this.stopTurnNoticeAnimation();
			this._turnNotice = null;
			this._turnNoticeAnimationFrame = 0;
			this._turnStartedAt = null;
			this._detailPanelExpanded = false;
			this._detailPanelScroll = 0;
			this._thinkingBuffer = "";
			this._compactionDetailText = "";
			this._activeTurnUsageTotals = emptyUsageSnapshot();
			this._currentMessageUsage = emptyUsageSnapshot();
			this._lastTurnUsage = null;
			this._sessionUsageTotals = emptyUsageSnapshot();
			this._commandSuggestions = [];
			this._toolCalls.clear();
			this._queuedInputs.length = 0;
			this._pendingPermissionSelection = 0;
			this._renderedFooterUi = null;
			this._renderedFooterStartRow = null;
			this._lastScreenFrame = null;
			this._transcriptScrollOffset = 0;
			sessionTitle = undefined;
			interactionState = initialInteractionState();

			sessionRef.current.events.on("session_closed", (event) => {
				if (this._suppressPersistOnce) {
					this._suppressPersistOnce = false;
					return;
				}
				try {
					void runtime.recordRecentSession((event as SessionClosedEvent).recoveryData, { title: sessionTitle });
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
			detachSessionStateListener = sessionRef.current.onStateChange((state) => {
				if (state.model.id !== sessionRef.current.state.model.id || state.model.provider !== sessionRef.current.state.model.provider) {
					return;
				}
				this.renderWelcome(sessionRef.current);
				this.renderFooterRegion();
			});
		};

		const switchInteractiveSession = (next: SessionFacade): void => {
			attachSession(next);
			this.renderWelcome(next);
			this.fullRedrawInteractiveScreen();
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
			visibility: "internal",
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
				const all = registry.listPublic().slice();

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
			visibility: "public",
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
			visibility: "public",
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
			visibility: "public",
			async execute(ctx) {
				if (handler.isInteractionBusy() || handler._pendingPermissionCallId) {
					ctx.output.writeError("Session is busy.");
					return undefined;
				}

				const previousSessionId = sessionRef.current.state.id.value;
				const previousTitleSuffix = sessionTitle ? ` — ${sessionTitle}` : "";
				await sessionRef.current.close();

				const next = runtime.createSession();
				switchInteractiveSession(next);
				ctx.output.writeLine(`Started a new session: ${next.state.id.value}`);
				ctx.output.writeLine(`Previous session saved: ${previousSessionId}${previousTitleSuffix}`);
				ctx.output.writeLine("Next: type a prompt, or /resume <sessionId|#N|title> to return.");
				return undefined;
			},
		});

		register({
			name: "changes",
			description: "Show changed files and diff summary",
			type: "local",
			visibility: "public",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const snapshot = await inspectGitWorkingTree(cwd);
				renderWorkingTreeSummary(ctx.output, handler._changedPaths, snapshot);
				if (snapshot.available === false) {
					ctx.output.writeError("git not available in this working directory.");
					ctx.output.writeLine("Next: use /review to inspect tool-observed changes.");
					return undefined;
				}
				ctx.output.writeLine("Next: /review to inspect, or /diff [file] to see patches.");
				return undefined;
			},
		});

		register({
			name: "diff",
			description: "Show git diff (optionally for a file)",
			type: "local",
			visibility: "public",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const target = ctx.args.trim();
				if (target.length === 0) {
					ctx.output.writeLine("Diff:");
				} else {
					ctx.output.writeLine(`Diff: ${target}`);
				}
				const diff = await readGitDiff(cwd, target.length > 0 ? target : null);
				if (diff.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					return undefined;
				}
				ctx.output.writeLine(diff.stdout.trimEnd().length > 0 ? diff.stdout.trimEnd() : "(no diff)");
				ctx.output.writeLine("Next: /review to see a summary, or keep iterating.");
				return undefined;
			},
		});

		register({
			name: "review",
			description: "Review changes and decide next steps",
			type: "local",
			visibility: "public",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				const snapshot = await inspectGitWorkingTree(cwd);
				if (snapshot.available && snapshot.statusLines.length === 0 && handler._changedPaths.size === 0) {
					ctx.output.writeLine("Review: clean working tree.");
					ctx.output.writeLine("Next: continue chatting, or /changes if you want a snapshot.");
					return undefined;
				}
				renderWorkingTreeSummary(ctx.output, handler._changedPaths, snapshot);
				if (snapshot.available === false) {
					ctx.output.writeError("git not available in this working directory.");
					ctx.output.writeLine("Next: continue chatting, or inspect tool-observed changes manually.");
					return undefined;
				}
				ctx.output.writeLine("Review tips:");
				ctx.output.writeLine("  /diff <file>   Inspect a specific patch");
				ctx.output.writeLine("  Use git manually if you want to discard changes");
				ctx.output.writeLine("Next: inspect diffs, then continue chatting.");
				return undefined;
			},
		});

		register({
			name: "status",
			description: "Show status",
			type: "local",
			visibility: "public",
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
				} else if (handler.isInteractionBusy()) {
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
			visibility: "internal",
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
			visibility: "internal",
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
			visibility: "internal",
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
			description: "Show recent sessions or resume one",
			type: "local",
			visibility: "public",
			async execute(ctx) {
				if (handler.isInteractionBusy() || handler._pendingPermissionCallId) {
					ctx.output.writeError("Session is busy.");
					return undefined;
				}

				const recent = await runtime.listRecentSessions();
				const selector = ctx.args.trim();
				if (selector.length === 0) {
					await handler.openResumeBrowser(runtime, "");
					return undefined;
				}

				const directMatch = resolveRecentSessionDirectSelection(selector, recent, recent);
				if (!directMatch) {
					await handler.openResumeBrowser(runtime, selector);
					return undefined;
				}
				const data = directMatch.recoveryData;

				handler._suppressPersistOnce = true;
				await sessionRef.current.close();

				const recovered = runtime.recoverSession(data);
				switchInteractiveSession(recovered);
				handler.closeResumeBrowser();
				writeSessionTranscriptPreview(ctx.output, directMatch);
				ctx.output.writeLine(`Resumed: ${data.sessionId.value}`);
				ctx.output.writeLine("Next: continue this session, or /resume to view history again.");
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
				if (this._resumeBrowser !== null) {
					this._commandSuggestions = [];
					void this.refreshResumeBrowserResults(runtime, state.buffer);
					return;
				}
				this._commandSuggestions = computeSlashSuggestions(state.buffer, registry.listPublic());
				this.renderPromptLine();
			},
			onTabComplete: (state) => {
				if (this._resumeBrowser !== null) {
					return null;
				}
				if (this._pendingPermissionCallId !== null) {
					return null;
				}
				const nextState = acceptFirstSlashSuggestion(state, this._commandSuggestions);
				if (nextState) {
					this._inputState = nextState;
					this._commandSuggestions = computeSlashSuggestions(nextState.buffer, registry.listPublic());
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
			onMouse: (event) => {
				this.handleMouseEvent(event);
			},
		});
		this._inputLoop = inputLoop;

		ttySession.enter();
		this.renderWelcome(sessionRef.current);
		this.fullRedrawInteractiveScreen();

		try {
			let line = await inputLoop.nextLine();
			while (line !== null) {
				const trimmed = line.trim();

				if (this._resumeBrowser !== null) {
					const handled = await this.handleResumeBrowserSubmit(line, runtime, sessionRef, sink, switchInteractiveSession);
					if (handled) {
						if (exitRequested) {
							break;
						}
						line = await inputLoop.nextLine();
						continue;
					}
				}

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
					const executeCommand = async (): Promise<void> => {
						await resolution.command.execute?.({
							args: resolution.args,
							runtime,
							session: sessionRef.current,
							output: sink,
							host: commandHost,
						});
					};
					try {
						if (resolution.command.name === "compact") {
							this.startLocalBusyCommand(executeCommand(), sessionRef, sink);
						} else {
							await executeCommand();
						}
					} catch (error) {
						this._lastError = error instanceof Error ? error.message : String(error);
						getActiveDebugLogger()?.error("interactive.slash_command", "Slash command failed", {
							command: resolution.command.name,
							args: resolution.args,
							error,
						});
						sink.writeError(this._lastError);
					}
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
				if (this.isInteractionBusy()) {
					this._queuedInputs.push(trimmed);
					this.preserveThinkingNoticeForQueuedBacklog();
					this.renderFooterRegion();
					line = await inputLoop.nextLine();
					continue;
				}
				this.startPromptTurn(sessionRef.current, trimmed, sink);

				line = await inputLoop.nextLine();
			}
		} finally {
			process.stdout.off("resize", onResize);
			debouncedResizeRedraw.cancel();
			detachSessionStateSubscription(detachSessionStateListener);
			inputLoop.close();
			this._inputLoop = null;
			process.stdout.write(encodeResetScrollRegion());
			ttySession.restore();
			sessionRef.current.events.removeAllListeners();
			await sessionRef.current.close();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		const debugTraceId = getActiveDebugLogger()?.session.debugEnabled ? getActiveDebugLogger()?.session.traceId : undefined;
		this._welcomeLines = buildWelcomeLines({
			terminalWidth: process.stdout.columns ?? 80,
			version: readInteractiveCliPackageVersion(),
			model: session.state.model.displayName ?? session.state.model.id,
			provider: session.state.model.provider,
			greeting: pickWelcomeGreeting(),
			debugTraceId,
		});
	}

	private renderPromptLine(): void {
		this.renderFooterRegion();
	}

	private handleMouseEvent(event: { kind: "leftdown" | "leftdrag" | "leftup"; row: number; column: number }): void {
		if (!this.isTranscriptMouseRow(event.row)) {
			if (event.kind === "leftdown") {
				this.clearMouseSelection();
			}
			return;
		}
		if (event.kind === "leftdown") {
			this._mouseSelection = {
				anchorRow: event.row,
				anchorColumn: event.column,
				focusRow: event.row,
				focusColumn: event.column,
			};
			this.renderTranscriptViewport();
			return;
		}
		if (this._mouseSelection === null) {
			return;
		}
		this._mouseSelection = {
			...this._mouseSelection,
			focusRow: event.row,
			focusColumn: event.column,
		};
		this.renderTranscriptViewport();
		if (event.kind === "leftup") {
			const selectedText = this.currentTranscriptSelectionText();
			if (selectedText.length > 0) {
				copyTextToClipboard(selectedText);
			}
		}
	}

	private handleSpecialKey(
		key:
			| "up"
			| "down"
			| "pageup"
			| "pagedown"
			| "wheelup"
			| "wheeldown"
			| "tab"
			| "shifttab"
			| "esc"
			| "ctrlo"
			| "ctrlv",
	): void {
		if (this._resumeBrowser !== null) {
			if (key === "esc") {
				this.closeResumeBrowser();
				return;
			}
			if (key === "ctrlv") {
				this.toggleResumeBrowserPreview();
				return;
			}
			if (key === "up" || key === "shifttab") {
				this.moveResumeBrowserSelection(-1);
				return;
			}
			if (key === "down" || key === "tab") {
				this.moveResumeBrowserSelection(1);
				return;
			}
		}
		if (key === "ctrlo") {
			this.toggleDetailPanel();
			return;
		}
		if (key === "ctrlv") {
			return;
		}
		if (key === "esc" && this._detailPanelExpanded) {
			this._detailPanelExpanded = false;
			this.renderFooterRegion();
			return;
		}
		if (this._detailPanelExpanded) {
			const detailScrollDelta = detailPanelScrollDeltaForKey(key, this.currentDetailPanelViewport().viewportSize);
			if (detailScrollDelta !== 0) {
				this.scrollDetailPanel(detailScrollDelta);
				return;
			}
		}
		const transcriptScrollDelta = transcriptScrollDeltaForKey(key, this.currentTranscriptViewportRows());
		if (transcriptScrollDelta !== 0) {
			this.scrollTranscript(transcriptScrollDelta);
			return;
		}
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
		if (event.category === "usage" && event.type === "usage_updated") {
			this.updateTurnUsage(event.usage, event.isFinal);
			this.renderPromptLine();
			return;
		}
		if (event.category === "compaction") {
			if (event.type === "compaction_started") {
				this._turnNotice = "compacting";
				this._turnNoticeAnimationFrame = 0;
				this._turnStartedAt = Date.now();
				this.startTurnNoticeAnimation();
			} else {
				this.stopTurnNoticeAnimation();
				this._turnNotice = null;
				this._turnNoticeAnimationFrame = 0;
				this._turnStartedAt = null;
				this._detailPanelExpanded = false;
				this._detailPanelScroll = 0;
				this._compactionDetailText = formatCompactionDetailText(event.summary);
			}
			this.renderPromptLine();
			return;
		}
		if (!shouldRenderInteractiveTranscriptEvent(event)) {
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "thinking_delta") {
			this._thinkingBuffer += event.content;
			if (this._turnNotice === null) {
				this.startTurnFeedback();
			}
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "text_delta") {
			if (this._turnNotice !== "responding") {
				this._turnNoticeAnimationFrame = 0;
				this._turnNotice = "responding";
				this.startTurnNoticeAnimation();
			}
			const previousRows = this.currentTranscriptDisplayRows();
			this._assistantBuffer = mergeStreamingText(this._assistantBuffer, event.content);
			this.adjustTranscriptScrollForGrowth(previousRows, this.currentTranscriptDisplayRows());
			this.fullRedrawInteractiveScreen();
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
			const previousRows = this.currentTranscriptDisplayRows();
			this.rememberAssistantTranscriptBlock(assistantBlock);
			this.adjustTranscriptScrollForGrowth(previousRows, this.currentTranscriptDisplayRows());
		}
		this._assistantBuffer = "";
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
			if (this._turnNotice === null) {
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

	private writeTranscriptText(text: string, newline: boolean, redrawPrompt = true): void {
		this.flushAssistantBuffer(false);
		const previousRows = this.currentTranscriptDisplayRows();
		this.rememberTranscriptBlock(text, newline);
		this.adjustTranscriptScrollForGrowth(previousRows, this.currentTranscriptDisplayRows());
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
		this._inputLoop?.setState({ buffer: text, cursor: text.length });
	}

	private async openResumeBrowser(runtime: AppRuntime, initialQuery: string): Promise<void> {
		this._resumeBrowser = {
			query: initialQuery,
			hits: [],
			selectedIndex: 0,
			previewExpanded: false,
			loading: true,
		};
		this._detailPanelExpanded = false;
		this._detailPanelScroll = 0;
		this._transcriptScrollOffset = 0;
		this.clearMouseSelection(false);
		this._commandSuggestions = [];
		if (this._inputLoop !== null) {
			this._inputLoop.setState({ buffer: initialQuery, cursor: initialQuery.length });
		} else {
			this._inputState = { buffer: initialQuery, cursor: initialQuery.length };
			await this.refreshResumeBrowserResults(runtime, initialQuery);
		}
		this.rerenderInteractiveRegions();
	}

	private closeResumeBrowser(): void {
		if (this._resumeBrowser === null) {
			return;
		}
		this._resumeBrowser = null;
		this._resumeSearchRequestId += 1;
		this._transcriptScrollOffset = 0;
		this.clearMouseSelection(false);
		if (this._inputLoop !== null) {
			this._inputLoop.setState({ buffer: "", cursor: 0 });
		} else {
			this._inputState = { buffer: "", cursor: 0 };
			this._commandSuggestions = [];
		}
		this.rerenderInteractiveRegions();
	}

	private async refreshResumeBrowserResults(runtime: AppRuntime, query: string): Promise<void> {
		const browser = this._resumeBrowser;
		if (browser === null) {
			return;
		}
		const selectedSessionId = browser.hits[browser.selectedIndex]?.entry.recoveryData.sessionId.value ?? null;
		const requestId = ++this._resumeSearchRequestId;
		const nextQuery = query;
		this._resumeBrowser = {
			...browser,
			query: nextQuery,
			loading: true,
			selectedIndex: browser.selectedIndex,
		};
		this.rerenderInteractiveRegions();
		const hits = await runtime.searchRecentSessions(nextQuery);
		if (this._resumeBrowser === null || requestId !== this._resumeSearchRequestId) {
			return;
		}
		this._resumeBrowser = {
			...this._resumeBrowser,
			query: nextQuery,
			hits,
			loading: false,
			selectedIndex: resolveResumeBrowserSelectedIndex(hits, selectedSessionId, browser.selectedIndex),
		};
		this._transcriptScrollOffset = 0;
		this.rerenderInteractiveRegions();
	}

	private moveResumeBrowserSelection(delta: number): void {
		if (this._resumeBrowser === null) {
			return;
		}
		const nextIndex = moveResumeBrowserSelection(this._resumeBrowser.selectedIndex, delta, this._resumeBrowser.hits.length);
		if (nextIndex === this._resumeBrowser.selectedIndex) {
			return;
		}
		this._resumeBrowser = {
			...this._resumeBrowser,
			selectedIndex: nextIndex,
		};
		this._transcriptScrollOffset = 0;
		this.rerenderInteractiveRegions();
	}

	private toggleResumeBrowserPreview(): void {
		if (this._resumeBrowser === null) {
			return;
		}
		this._resumeBrowser = {
			...this._resumeBrowser,
			previewExpanded: !this._resumeBrowser.previewExpanded,
		};
		this._transcriptScrollOffset = 0;
		this.rerenderInteractiveRegions();
	}

	private async handleResumeBrowserSubmit(
		_line: string,
		runtime: AppRuntime,
		sessionRef: { current: SessionFacade },
		sink: OutputSink,
		switchInteractiveSession: (nextSession: SessionFacade) => void,
	): Promise<boolean> {
		if (this._resumeBrowser === null) {
			return false;
		}
		if (this._resumeBrowser.loading) {
			return true;
		}
		const hit = this._resumeBrowser.hits[this._resumeBrowser.selectedIndex] ?? this._resumeBrowser.hits[0] ?? null;
		if (!hit) {
			return true;
		}
		const data = hit.entry.recoveryData;
		this.closeResumeBrowser();
		this._suppressPersistOnce = true;
		await sessionRef.current.close();
		const recovered = runtime.recoverSession(data);
		switchInteractiveSession(recovered);
		writeSessionTranscriptPreview(sink, hit.entry);
		sink.writeLine(`Resumed: ${data.sessionId.value}`);
		sink.writeLine("Next: continue this session, or /resume to view history again.");
		return true;
	}

	private startPromptTurn(session: SessionFacade, prompt: string, sink: OutputSink): void {
		this.startUserTurn(session, prompt, sink, "prompt");
	}

	private startQueuedContinueTurn(session: SessionFacade, input: string, sink: OutputSink): void {
		this.startUserTurn(session, input, sink, "continue");
	}

	private startUserTurn(session: SessionFacade, input: string, sink: OutputSink, mode: "prompt" | "continue"): void {
		this.flushAssistantBuffer(false);
		for (const block of formatTranscriptUserBlocks(input)) {
			this.writeTranscriptText(block, true, false);
		}
		this._turnStartedAt = Date.now();
		this._detailPanelExpanded = false;
		this._detailPanelScroll = 0;
		this._thinkingBuffer = "";
		this._compactionDetailText = "";
		this._activeTurnUsageTotals = emptyUsageSnapshot();
		this._currentMessageUsage = emptyUsageSnapshot();
		this.startTurnFeedback();
		this.rememberHistory(input);
		const sendTurn =
			mode === "continue" ? (value: string) => session.continue(value) : (value: string) => session.prompt(value);
		this._activeTurn = sendTurn(input)
			.catch((err: unknown) => {
				sink.writeError(`Error: ${err}`);
			})
			.finally(() => {
				this.stopTurnNoticeAnimation();
				const completedTurnUsage = this.currentTurnUsage();
				this._activeTurn = null;
				this.flushAssistantBuffer(false);
				this._turnNotice = null;
				this._turnNoticeAnimationFrame = 0;
				this._turnStartedAt = null;
				this._detailPanelExpanded = false;
				this._detailPanelScroll = 0;
				this._thinkingBuffer = "";
				this._compactionDetailText = "";
				if (hasUsageSnapshot(completedTurnUsage)) {
					this._lastTurnUsage = completedTurnUsage;
					this._sessionUsageTotals = addUsageSnapshots(this._sessionUsageTotals, completedTurnUsage);
				}
				this._activeTurnUsageTotals = emptyUsageSnapshot();
				this._currentMessageUsage = emptyUsageSnapshot();
				const queuedInputBatch = this.drainQueuedInputs();
				if (queuedInputBatch !== null) {
					this.startQueuedContinueTurn(session, queuedInputBatch, sink);
					return;
				}
				this.fullRedrawInteractiveScreen();
			});
	}

	private drainQueuedInputs(): string | null {
		if (this._queuedInputs.length === 0) {
			return null;
		}
		const queued = [...this._queuedInputs];
		this._queuedInputs.length = 0;
		return queued.join("\n\n");
	}

	private startLocalBusyCommand(command: Promise<void>, sessionRef: { current: SessionFacade }, sink: OutputSink): void {
		this._activeLocalCommand = command
			.catch((error: unknown) => {
				this._lastError = error instanceof Error ? error.message : String(error);
				getActiveDebugLogger()?.error("interactive.local_command", "Local command failed", { error });
				sink.writeError(this._lastError);
			})
			.finally(() => {
				this._activeLocalCommand = null;
				if (this._activeTurn !== null || this._turnNotice === "compacting") {
					this.renderFooterRegion();
					return;
				}
				const queuedInputBatch = this.drainQueuedInputs();
				if (queuedInputBatch !== null) {
					this.startQueuedContinueTurn(sessionRef.current, queuedInputBatch, sink);
					return;
				}
				this.fullRedrawInteractiveScreen();
			});
	}

	private preserveThinkingNoticeForQueuedBacklog(): void {
		if (this._activeTurn === null && this._turnNotice !== "compacting") {
			return;
		}
		if (this._turnNotice === "responding") {
			this._turnNotice = "thinking";
			this.startTurnNoticeAnimation();
			return;
		}
		if (this._turnNotice === null) {
			this.startTurnFeedback();
		}
	}

	private isInteractionBusy(): boolean {
		return this._activeTurn !== null || this._activeLocalCommand !== null || this._turnNotice === "compacting";
	}

	private toggleDetailPanel(): void {
		if (this.currentDetailPanelContentLines().length === 0) {
			return;
		}
		this._detailPanelExpanded = !this._detailPanelExpanded;
		if (this._detailPanelExpanded) {
			this._detailPanelScroll = 0;
		}
		this.renderFooterRegion();
	}

	private scrollDetailPanel(delta: number): void {
		const viewport = this.currentDetailPanelViewport();
		if (viewport.totalLines <= viewport.viewportSize) {
			return;
		}
		const maxScroll = Math.max(0, viewport.totalLines - viewport.viewportSize);
		const next = Math.max(0, Math.min(maxScroll, this._detailPanelScroll + delta));
		if (next === this._detailPanelScroll) {
			return;
		}
		this._detailPanelScroll = next;
		this.renderFooterRegion();
	}

	private scrollTranscript(delta: number): void {
		const maxScroll = this.currentTranscriptMaxScroll();
		if (delta === 0 || maxScroll <= 0) {
			return;
		}
		const next = Math.max(0, Math.min(maxScroll, this._transcriptScrollOffset + delta));
		if (next === this._transcriptScrollOffset) {
			return;
		}
		this.clearMouseSelection(false);
		this._transcriptScrollOffset = next;
		this.renderTranscriptViewport();
		this.renderFooterRegion();
	}

	private buildFooterUi(): InteractiveFooterRenderResult {
		const activeToolLabel = summarizeActiveToolNotice(this._toolCalls);
		const detailPanel = this.currentDetailPanelViewport();
		return formatInteractiveFooter({
			terminalWidth: process.stdout.columns ?? 80,
			prompt: this.currentPrompt(),
			buffer: this._inputState.buffer,
			cursor: this._inputState.cursor,
			suggestions: this._commandSuggestions,
			turnNotice: activeToolLabel !== null ? "tool" : this._turnNotice,
			turnNoticeAnimationFrame: this._turnNoticeAnimationFrame,
			elapsedMs: this.currentTurnElapsedMs(),
			currentTurnUsage: this.currentTurnUsage(),
			lastTurnUsage: this._lastTurnUsage,
			sessionUsage: this._sessionUsageTotals,
			activeToolLabel,
			showPendingOutputIndicator: this.shouldShowPendingOutputIndicator(activeToolLabel),
			detailPanelExpanded: this._detailPanelExpanded,
			detailPanelLines: detailPanel.lines,
			detailPanelSummary: detailPanel.summary,
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

	private currentDetailPanelContentLines(): readonly string[] {
		if (this._thinkingBuffer.trim().length > 0) {
			return wrapTranscriptContent(this._thinkingBuffer.trim(), this.terminalWidth());
		}
		if (this._compactionDetailText.trim().length > 0) {
			return wrapTranscriptContent(this._compactionDetailText.trim(), this.terminalWidth());
		}
		return [];
	}

	private currentPrompt(): string {
		return this._resumeBrowser === null ? this._prompt : "Search> ";
	}

	private shouldShowPendingOutputIndicator(activeToolLabel: string | null): boolean {
		if (this._assistantBuffer.length > 0) {
			return true;
		}
		if (activeToolLabel === null) {
			return false;
		}
		const lastNonEmptyIndex = findLastNonEmptyBlockIndex(this._transcriptBlocks);
		if (lastNonEmptyIndex === -1) {
			return false;
		}
		const lastBlock = this._transcriptBlocks[lastNonEmptyIndex] ?? "";
		return !isTranscriptUserBlock(lastBlock) && !lastBlock.startsWith("⏺ ") && !lastBlock.startsWith("  ⎿ ");
	}

	private currentDetailPanelViewport(): {
		readonly lines: readonly string[];
		readonly summary: string | null;
		readonly viewportSize: number;
		readonly totalLines: number;
	} {
		const lines = this.currentDetailPanelContentLines();
		if (lines.length === 0) {
			return { lines: [], summary: null, viewportSize: 0, totalLines: 0 };
		}
		if (!this._detailPanelExpanded) {
			return {
				lines: [],
				summary: "ctrl+o to expand",
				viewportSize: 0,
				totalLines: lines.length,
			};
		}
		const viewportSize = Math.max(3, this.terminalHeight() - 8);
		const maxScroll = Math.max(0, lines.length - viewportSize);
		const start = Math.max(0, Math.min(this._detailPanelScroll, maxScroll));
		const end = Math.min(lines.length, start + viewportSize);
		const summary =
			lines.length <= viewportSize
				? "esc to collapse · ↑↓"
				: `esc to collapse · ↑↓ · ${start + 1}-${end}/${lines.length}`;
		return {
			lines: lines.slice(start, end),
			summary,
			viewportSize,
			totalLines: lines.length,
		};
	}

	private rerenderInteractiveRegions(): void {
		this.clearMouseSelection(false);
		this.clampTranscriptScrollOffset();
		this.fullRedrawInteractiveScreen();
	}

	private adjustTranscriptScrollForGrowth(previousRows: number, nextRows: number): void {
		this.clearMouseSelection(false);
		if (this._transcriptScrollOffset === 0) {
			return;
		}
		const delta = Math.max(0, nextRows - previousRows);
		if (delta === 0) {
			this.clampTranscriptScrollOffset();
			return;
		}
		this._transcriptScrollOffset += delta;
		this.clampTranscriptScrollOffset();
	}

	private updateTurnUsage(usage: UsageSnapshot, isFinal: boolean): void {
		const normalized = normalizeUsageSnapshot(usage);
		if (isFinal) {
			this._activeTurnUsageTotals = addUsageSnapshots(this._activeTurnUsageTotals, normalized);
			this._currentMessageUsage = emptyUsageSnapshot();
			return;
		}
		this._currentMessageUsage = normalized;
	}

	private currentTurnUsage(): UsageSnapshot | null {
		const usage = addUsageSnapshots(this._activeTurnUsageTotals, this._currentMessageUsage);
		return hasUsageSnapshot(usage) ? usage : null;
	}

	private currentTurnElapsedMs(): number | null {
		if (this._turnNotice === null || this._turnStartedAt === null) {
			return null;
		}
		return Math.max(0, Date.now() - this._turnStartedAt);
	}

	private terminalWidth(): number {
		return Math.max(1, process.stdout.columns ?? 80);
	}

	private terminalHeight(): number {
		return Math.max(6, process.stdout.rows ?? 24);
	}

	private currentTranscriptViewportRows(): number {
		const footerUi = this.buildFooterUi();
		const transcriptTopRow = 1;
		const transcriptBottomRow =
			computeFooterStartRowFromTuiCore(this.terminalHeight(), footerUi.lines.length, this.currentTranscriptDisplayRows()) -
			1;
		return Math.max(0, transcriptBottomRow - transcriptTopRow + 1);
	}

	private currentTranscriptMaxScroll(): number {
		return Math.max(0, this.currentTranscriptDisplayRows() - this.currentTranscriptViewportRows());
	}

	private clampTranscriptScrollOffset(): void {
		this._transcriptScrollOffset = Math.max(
			0,
			Math.min(this._transcriptScrollOffset, this.currentTranscriptMaxScroll()),
		);
	}

	private isTranscriptMouseRow(row: number): boolean {
		const footerStartRow =
			this._renderedFooterStartRow ??
			computeFooterStartRowFromTuiCore(
				this.terminalHeight(),
				this.currentFooterHeight(),
				this.currentTranscriptDisplayRows(),
			);
		return row >= 1 && row < footerStartRow;
	}

	private clearMouseSelection(redraw = true): void {
		if (this._mouseSelection === null) {
			return;
		}
		this._mouseSelection = null;
		if (redraw) {
			this.renderTranscriptViewport();
		}
	}

	private currentTranscriptSelectionText(): string {
		if (this._mouseSelection === null) {
			return "";
		}
		return extractPlainTextSelection(this._renderedTranscriptViewportLines, {
			startRow: this._mouseSelection.anchorRow - 1,
			startColumn: this._mouseSelection.anchorColumn,
			endRow: this._mouseSelection.focusRow - 1,
			endColumn: this._mouseSelection.focusColumn,
		});
	}

	private transcriptBottomRow(footerHeight = this.currentFooterHeight()): number {
		return Math.max(1, this.terminalHeight() - footerHeight);
	}

	private currentFooterHeight(): number {
		return this._renderedFooterUi?.lines.length ?? this.buildFooterUi().lines.length;
	}

	private renderFooterRegion(): void {
		this.renderInteractiveScreenState();
	}

	private appendTranscriptLines(lines: readonly string[]): void {
		if (lines.length === 0) {
			return;
		}
		this.fullRedrawInteractiveScreen();
	}

	private rememberTranscriptBlock(text: string, newline: boolean): void {
		const block = newline ? text : text.replace(/\n$/, "");
		if (block.length === 0) {
			return;
		}
		const nextBlocks = appendTranscriptBlockWithSpacer(this._transcriptBlocks, block);
		this._transcriptBlocks.length = 0;
		this._transcriptBlocks.push(...nextBlocks);
	}

	private rememberAssistantTranscriptBlock(block: string): void {
		const nextBlocks = appendAssistantTranscriptBlock(this._transcriptBlocks, block);
		this._transcriptBlocks.length = 0;
		this._transcriptBlocks.push(...nextBlocks);
	}

	private fullRedrawInteractiveScreen(): void {
		this.renderInteractiveScreenState({ resetScrollRegion: true });
	}

	private renderTranscriptViewport(): void {
		this.renderInteractiveScreenState();
	}

	private renderInteractiveScreenState(options: { readonly resetScrollRegion?: boolean } = {}): void {
		this.clampTranscriptScrollOffset();
		if (options.resetScrollRegion) {
			process.stdout.write(encodeResetScrollRegion());
		}
		const next = this.buildInteractiveScreenFrame();
		const patches = diffScreenFrames(this._lastScreenFrame, next.frame);
		getActiveDebugLogger()?.debug("tui.render", "Rendered interactive screen frame", {
			resetScrollRegion: options.resetScrollRegion ?? false,
			footerStartRow: next.footerStartRow,
			pinFooterToBottom: next.pinFooterToBottom,
			footerLineCount: next.footerUi.lines.length,
			transcriptViewportLineCount: this._renderedTranscriptViewportLines.length,
			frame: summarizeScreenFrame(next.frame),
			patches: summarizeFramePatches(patches),
		});
		process.stdout.write(encodeFramePatches(patches, next.frame.width));
		if (next.pinFooterToBottom) {
			process.stdout.write(
				encodeSetScrollRegion({
					top: 1,
					bottom: this.transcriptBottomRow(next.footerUi.lines.length),
				}),
			);
		} else {
			process.stdout.write(encodeResetScrollRegion());
		}
		process.stdout.write(
			encodeFramePatches([{ type: "move-cursor", cursor: next.frame.cursor }], next.frame.width),
		);
		process.stdout.write(ansiShowCursor());
		this._renderedFooterUi = next.footerUi;
		this._renderedFooterStartRow = next.footerStartRow;
		this._lastScreenFrame = next.frame;
	}

	private buildInteractiveScreenFrame(): {
		readonly frame: ScreenFrame;
		readonly footerUi: InteractiveFooterRenderResult;
		readonly footerStartRow: number;
		readonly pinFooterToBottom: boolean;
	} {
		const terminalWidth = this.terminalWidth();
		const terminalHeight = this.terminalHeight();
		const footerUi = this.buildFooterUi();
		const availableRows = Math.max(0, terminalHeight - footerUi.lines.length);
		const visibleLines = computeVisibleTranscriptLines(
			this.currentRenderedTranscriptBlocks(),
			terminalWidth,
			availableRows,
			this._transcriptScrollOffset,
			this.currentWelcomeLineCount(),
		);
		this._renderedTranscriptViewportLines = visibleLines.map((line) => stripAnsiWelcome(line));

		const bodyLines = visibleLines.map((visibleLine, index) => {
			const plainLine = this._renderedTranscriptViewportLines[index] ?? "";
			const row = index + 1;
			const selectionColumns = this.selectionColumnsForRow(row);
			return selectionColumns === null
				? isTranscriptUserBlock(visibleLine)
					? formatFullWidthTranscriptUserLine(plainLine, terminalWidth)
					: fitTerminalLine(visibleLine, terminalWidth)
				: renderSelectedPlainLine(plainLine, selectionColumns.startColumn, selectionColumns.endColumn, terminalWidth);
		});

		const composed = composeScreenWithFooter({
			width: terminalWidth,
			height: terminalHeight,
			bodyLines,
			footer: {
				lines: footerUi.lines.map((line: string) => fitTerminalLine(line ?? "", terminalWidth)),
				cursorLineIndex: footerUi.cursorLineIndex,
				cursorColumn: footerUi.cursorColumn,
			},
		});

		return materializeInteractiveScreenFrame(composed, footerUi, terminalWidth);
	}

	private selectionColumnsForRow(row: number): { startColumn: number; endColumn: number } | null {
		return computeSelectionColumnsForRow(this.currentSelectionRange(), row, this.terminalWidth());
	}

	private currentSelectionRange(): TerminalSelectionRange | null {
		if (this._mouseSelection === null) {
			return null;
		}
		return {
			startRow: this._mouseSelection.anchorRow,
			startColumn: this._mouseSelection.anchorColumn,
			endRow: this._mouseSelection.focusRow,
			endColumn: this._mouseSelection.focusColumn,
		};
	}

	private currentTranscriptDisplayRows(): number {
		return computeTranscriptDisplayRows(
			this.currentRenderedTranscriptBlocks(),
			this.terminalWidth(),
			this.currentWelcomeLineCount(),
		);
	}

	private currentRenderedTranscriptBlocks(): readonly string[] {
		if (this._resumeBrowser !== null) {
			return formatResumeBrowserTranscriptBlocks(this._resumeBrowser);
		}
		const welcomeBlocks = this._welcomeLines;
		if (this._assistantBuffer.length === 0) {
			return [...welcomeBlocks, ...this._transcriptBlocks];
		}
		const assistantBlock = materializeAssistantTranscriptBlock(this._assistantBuffer);
		if (assistantBlock === null) {
			return [...welcomeBlocks, ...this._transcriptBlocks];
		}
		return appendAssistantTranscriptBlock([...welcomeBlocks, ...this._transcriptBlocks], assistantBlock);
	}

	private currentWelcomeLineCount(): number {
		return this._resumeBrowser === null ? this._welcomeLines.length : 0;
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

interface GitWorkingTreeSnapshot {
	readonly available: boolean;
	readonly statusLines: readonly string[];
	readonly diffStatLines: readonly string[];
}

async function inspectGitWorkingTree(cwd: string): Promise<GitWorkingTreeSnapshot> {
	const [status, diffStat] = await Promise.all([runGit(cwd, ["status", "--porcelain"]), runGit(cwd, ["diff", "--stat"])]);
	if (status.type === "error" || diffStat.type === "error") {
		return {
			available: false,
			statusLines: [],
			diffStatLines: [],
		};
	}
	return {
		available: true,
		statusLines: splitNonEmptyLines(status.stdout),
		diffStatLines: splitNonEmptyLines(diffStat.stdout),
	};
}

function renderWorkingTreeSummary(
	output: OutputSink,
	changedPaths: ReadonlySet<string>,
	snapshot: GitWorkingTreeSnapshot,
): void {
	output.writeLine("Working tree:");
	if (changedPaths.size > 0) {
		output.writeLine("Changed files (observed by tools):");
		for (const path of [...changedPaths].sort((a, b) => a.localeCompare(b))) {
			output.writeLine(`  ${path}`);
		}
	} else {
		output.writeLine("Changed files (observed by tools): none");
	}
	if (!snapshot.available) {
		return;
	}
	output.writeLine("git status --porcelain:");
	output.writeLine(snapshot.statusLines.length > 0 ? `  ${snapshot.statusLines.join("\n  ")}` : "  clean");
	if (snapshot.diffStatLines.length > 0) {
		output.writeLine("git diff --stat:");
		output.writeLine(`  ${snapshot.diffStatLines.join("\n  ")}`);
	}
}

function readGitDiff(cwd: string, target: string | null): Promise<{ type: "ok"; stdout: string; stderr: string } | { type: "error" }> {
	return runGit(cwd, target ? ["diff", "--", target] : ["diff"]);
}

function splitNonEmptyLines(text: string): readonly string[] {
	return text
		.trim()
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function detachSessionStateSubscription(unsubscribe: (() => void) | null): void {
	if (unsubscribe) {
		unsubscribe();
	}
}

function stripAnsiWelcome(text: string): string {
	return stripAnsiControlSequences(text);
}

function applyWelcomeBorderColor(text: string): string {
	return `${INTERACTIVE_THEME.welcomeBorder}${text}${INTERACTIVE_THEME.reset}`;
}

function buildWelcomeHintLine(width: number): string {
	if (width < 64) {
		return "Start: Enter  Help: /help  Exit: /exit";
	}
	return "Start: type a prompt and press Enter  Help: /help  Exit: /exit";
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
const WELCOME_CARD_WIDTH = 80;

export function pickWelcomeGreeting(randomValue = Math.random()): string {
	const size = WELCOME_BIBLE_GREETINGS.length;
	const normalized = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 0.999999999999) : 0;
	return WELCOME_BIBLE_GREETINGS[Math.floor(normalized * size)] ?? WELCOME_BIBLE_GREETINGS[0];
}

export function readInteractiveCliPackageVersion(packageJsonPath = resolve(__dirname, "../package.json")): string {
	try {
		const raw = readFileSync(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "dev";
	} catch {
		return process.env.npm_package_version ?? "dev";
	}
}

export function buildWelcomeLines(input: {
	terminalWidth: number;
	version: string;
	model: string;
	provider: string;
	greeting: string;
	debugTraceId?: string;
}): readonly string[] {
	const width = WELCOME_CARD_WIDTH;
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
		buildWelcomeHintLine(input.terminalWidth),
		...(input.debugTraceId ? [`${INTERACTIVE_THEME.muted}Debug trace: ${input.debugTraceId}${RESET}`] : []),
		"",
	];
}

export function formatWelcomeTopBorder(width: number, version: string): string {
	const border = INTERACTIVE_THEME.welcomeBorder;
	const reset = INTERACTIVE_THEME.reset;
	const title = `${INTERACTIVE_THEME.bold}${INTERACTIVE_THEME.welcomeTitle}Genesis CLI${reset}`;
	const versionLabel = `${INTERACTIVE_THEME.muted}v${version}${reset}`;
	const visibleLabel = `╭─── Genesis CLI v${version} `;
	const plainWidth = measureTerminalDisplayWidth(visibleLabel);
	return `${border}╭─── ${reset}${title}${border} ${reset}${versionLabel}${border} ${"─".repeat(Math.max(0, width - plainWidth - 1))}╮${reset}`;
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
	return computePromptCursorColumnFromTuiCore(prompt, buffer, cursor);
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
	const bodyLines = formatInteractivePermissionBodyLines(details, selectedIndex);
	return materializeTextBlock(
		composeSectionBlock({
			leadingLines: bodyLines.slice(0, 1),
			separator: "────────────────────────────────────────",
			bodyLines: bodyLines.slice(1),
		}),
	).block;
}

export type InteractiveFooterRenderResult = RenderedComposerBlock;

export function buildInteractiveFooterLeadingLines(state: {
	readonly terminalWidth: number;
	readonly turnNotice: "thinking" | "responding" | "tool" | "compacting" | null;
	readonly turnNoticeAnimationFrame?: number;
	readonly elapsedMs?: number | null;
	readonly currentTurnUsage?: UsageSnapshot | null;
	readonly lastTurnUsage?: UsageSnapshot | null;
	readonly sessionUsage?: UsageSnapshot | null;
	readonly activeToolLabel?: string | null;
	readonly showPendingOutputIndicator?: boolean;
	readonly detailPanelExpanded?: boolean;
	readonly detailPanelSummary?: string | null;
	readonly detailPanelLines?: readonly string[];
	readonly queuedInputs?: readonly string[];
}): readonly string[] {
	return buildInteractiveFooterLeadingLinesFromUi({
		...state,
		truncateText: truncatePlainTerminalText,
	});
}

function materializeInteractiveScreenFrame(
	composed: ComposedScreen,
	footerUi: InteractiveFooterRenderResult,
	terminalWidth: number,
): {
	readonly frame: ScreenFrame;
	readonly footerUi: InteractiveFooterRenderResult;
	readonly footerStartRow: number;
	readonly pinFooterToBottom: boolean;
} {
	return {
		frame: composed.frame,
		footerUi: { ...footerUi, renderedWidth: terminalWidth },
		footerStartRow: composed.footerStartRow,
		pinFooterToBottom: composed.pinFooterToBottom,
	};
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
	readonly turnNotice: "thinking" | "responding" | "tool" | "compacting" | null;
	readonly turnNoticeAnimationFrame?: number;
	readonly elapsedMs?: number | null;
	readonly currentTurnUsage?: UsageSnapshot | null;
	readonly lastTurnUsage?: UsageSnapshot | null;
	readonly sessionUsage?: UsageSnapshot | null;
	readonly activeToolLabel?: string | null;
	readonly showPendingOutputIndicator?: boolean;
	readonly detailPanelExpanded?: boolean;
	readonly detailPanelSummary?: string | null;
	readonly detailPanelLines?: readonly string[];
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
	const leadingLines = buildInteractiveFooterLeadingLines(state);
	if (state.permission !== null) {
		const prompt = "choice [Enter/1/2/3]> ";
		const layout = composePromptBlock({
			leadingLines,
			separator,
			bodyLines: formatInteractivePermissionBodyLines(
				state.permission.details,
				state.permission.selectedIndex,
			),
			prompt,
			buffer: state.buffer,
			cursor: state.cursor,
		});
		return materializeComposerBlock(layout, state.terminalWidth);
	}
	const hint = formatSlashSuggestionHint(
		state.suggestions,
		state.terminalWidth - computePromptCursorColumn(state.prompt, state.buffer, state.buffer.length),
	);
	const layout = composePromptBlock({
		leadingLines,
		separator,
		prompt: state.prompt,
		buffer: formatInteractivePromptBuffer(state.buffer, false),
		cursor: state.cursor,
		hint,
	});
	return materializeComposerBlock(layout, state.terminalWidth);
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

function summarizeActiveToolNotice(
	toolCalls: ReadonlyMap<string, { toolName: string; parameters: Readonly<Record<string, unknown>> }>,
): string | null {
	if (toolCalls.size === 0) {
		return null;
	}
	const [first] = toolCalls.values();
	if (!first) {
		return "Running tools";
	}
	const title = formatInteractiveToolTitle(first.toolName, first.parameters).replace(/^⏺\s+/, "");
	if (toolCalls.size === 1) {
		return `Running ${title}`;
	}
	return `Running ${toolCalls.size} tools`;
}

function formatCompactionDetailText(summary: CompactionSummary): string {
	const lines = [
		"Compaction summary",
		`- Messages: ${summary.originalMessageCount} -> ${summary.retainedMessageCount}`,
		`- Estimated tokens saved: ${summary.estimatedTokensSaved}`,
	];
	if (summary.compactedSummary && summary.compactedSummary.trim().length > 0) {
		lines.push("", summary.compactedSummary.trim());
	}
	return lines.join("\n");
}

function detailPanelScrollDeltaForKey(
	key: "up" | "down" | "pageup" | "pagedown" | "wheelup" | "wheeldown" | "tab" | "shifttab" | "esc" | "ctrlo",
	viewportSize: number,
): number {
	switch (key) {
		case "up":
		case "wheelup":
			return -1;
		case "down":
		case "wheeldown":
			return 1;
		case "pageup":
			return -Math.max(1, viewportSize - 1);
		case "pagedown":
			return Math.max(1, viewportSize - 1);
		default:
			return 0;
	}
}

function transcriptScrollDeltaForKey(
	key: "up" | "down" | "pageup" | "pagedown" | "wheelup" | "wheeldown" | "tab" | "shifttab" | "esc" | "ctrlo",
	viewportSize: number,
): number {
	switch (key) {
		case "pageup":
			return Math.max(1, viewportSize - 1);
		case "pagedown":
			return -Math.max(1, viewportSize - 1);
		case "wheelup":
			return 3;
		case "wheeldown":
			return -3;
		default:
			return 0;
	}
}

function resolveRecentSessionDirectSelection(
	selector: string,
	displayedEntries: readonly RecentSessionEntry[],
	allRecentEntries: readonly RecentSessionEntry[],
): RecentSessionEntry | null {
	const idxText = selector.startsWith("#") ? selector.slice(1) : selector;
	const idx = Number.parseInt(idxText, 10);
	if (Number.isFinite(idx) && idx >= 1 && idx <= displayedEntries.length) {
		return displayedEntries[idx - 1] ?? null;
	}

	const exact = allRecentEntries.find((entry) => entry.recoveryData.sessionId.value === selector) ?? null;
	if (exact) return exact;

	const prefixMatches = allRecentEntries.filter((entry) => entry.recoveryData.sessionId.value.startsWith(selector));
	if (prefixMatches.length === 1) return prefixMatches[0]!;
	return null;
}

function writeSessionTranscriptPreview(output: OutputSink, entry: RecentSessionEntry): void {
	const preview = entry.recoveryData.metadata?.recentMessages ?? [];
	if (preview.length === 0) return;
	output.writeLine("Restored context:");
	for (const item of preview) {
		const label = item.role === "user" ? "User" : "Assistant";
		output.writeLine(`  ${label}: ${truncatePlainTerminalText(item.text, 88)}`);
	}
}

function resolveResumeBrowserSelectedIndex(
	hits: readonly RecentSessionSearchHit[],
	selectedSessionId: string | null,
	fallbackIndex: number,
): number {
	if (hits.length === 0) {
		return 0;
	}
	if (selectedSessionId) {
		const matchedIndex = hits.findIndex((hit) => hit.entry.recoveryData.sessionId.value === selectedSessionId);
		if (matchedIndex >= 0) {
			return matchedIndex;
		}
	}
	return moveResumeBrowserSelection(fallbackIndex, 0, hits.length);
}

export function createDebouncedCallback(
	callback: () => void,
	delayMs: number,
): {
	schedule(): void;
	cancel(): void;
} {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		schedule(): void {
			if (timer !== null) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = null;
				callback();
			}, delayMs);
			timer.unref?.();
		},
		cancel(): void {
			if (timer === null) {
				return;
			}
			clearTimeout(timer);
			timer = null;
		},
	};
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

export function formatTranscriptUserBlocks(content: string): readonly string[] {
	return content
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => formatTranscriptUserLine(part));
}

export function formatFullWidthTranscriptUserLine(content: string, width: number): string {
	const plain = content.replace(/\r?\n/g, " ");
	const visibleWidth = measureTerminalDisplayWidth(plain);
	const safeWidth = Math.max(1, width);
	const padded =
		visibleWidth >= safeWidth ? truncatePlainTerminalText(plain, safeWidth) : `${plain}${" ".repeat(safeWidth - visibleWidth)}`;
	return `${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg}${padded}${INTERACTIVE_THEME.reset}`;
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
	return computeFooterCursorColumnFromTuiCore(width, cursorColumn) - 1;
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

export function countRenderedTerminalRows(lines: readonly string[], width: number): number {
	return countRenderedTerminalRowsFromTuiCore(lines, width);
}

export function computePromptCursorRowsUp(lines: readonly string[], width: number, cursorColumn: number): number {
	return computePromptCursorRowsUpFromTuiCore(lines, width, cursorColumn);
}

export function computeFooterCursorRowsUp(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	return computeFooterCursorRowsUpFromTuiCore(lines, width, cursorLineIndex, cursorColumn);
}

export function computeFooterCursorRowsFromEnd(
	lines: readonly string[],
	width: number,
	cursorLineIndex: number,
	cursorColumn: number,
): number {
	return computeFooterCursorRowsFromEndFromTuiCore(lines, width, cursorLineIndex, cursorColumn);
}

export function computeInteractiveEphemeralRows(
	streaming: InteractiveStreamingRenderResult | null,
	footer: InteractiveFooterRenderResult | null,
): number {
	return computeEphemeralRows(streaming, footer);
}

export function fitTerminalLine(line: string, width: number): string {
	return fitTerminalLineFromTuiCore(line, width);
}

function truncatePlainTerminalText(text: string, width: number): string {
	return truncatePlainTextFromTuiCore(text, width);
}

export function formatTurnNotice(
	kind: "thinking" | "responding" | "tool" | "compacting",
	options: {
		readonly animationFrame?: number;
		readonly queuedCount?: number;
		readonly usage?: UsageSnapshot | null;
		readonly showPendingOutputIndicator?: boolean;
		readonly elapsedMs?: number | null;
		readonly toolLabel?: string | null;
	} = {},
): string {
	return formatTurnNoticeFromUi(kind, options);
}

function emptyUsageSnapshot(): UsageSnapshot {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function normalizeUsageSnapshot(usage: UsageSnapshot): UsageSnapshot {
	return {
		input: Math.max(0, usage.input),
		output: Math.max(0, usage.output),
		cacheRead: Math.max(0, usage.cacheRead),
		cacheWrite: Math.max(0, usage.cacheWrite),
		totalTokens: Math.max(0, usage.totalTokens),
	};
}

function addUsageSnapshots(left: UsageSnapshot, right: UsageSnapshot): UsageSnapshot {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
	};
}

function hasUsageSnapshot(usage: UsageSnapshot | null | undefined): usage is UsageSnapshot {
	if (!usage) {
		return false;
	}
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
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
	return wrapTranscriptContentFromTuiCore(content, width);
}

export function computeVisibleTranscriptLines(
	blocks: readonly string[],
	width: number,
	maxRows: number,
	offsetFromBottom = 0,
	unwrappedLeadingBlockCount = 0,
): readonly string[] {
	return computeVisibleViewportLines({
		blocks,
		width,
		maxRows,
		offsetFromBottom,
		unwrappedLeadingBlockCount,
		wrapLine: wrapTranscriptContent,
	});
}

export function extractPlainTextSelection(
	lines: readonly string[],
	selection: {
		startRow: number;
		startColumn: number;
		endRow: number;
		endColumn: number;
	},
): string {
	return extractPlainTextSelectionFromTuiCore(lines, selection);
}

function copyTextToClipboard(text: string): void {
	if (text.length === 0) {
		return;
	}
	if (process.platform === "darwin") {
		spawnSync("pbcopy", [], { input: text, stdio: ["pipe", "ignore", "ignore"] });
		return;
	}
	if (process.platform === "win32") {
		spawnSync("clip", [], { input: text, stdio: ["pipe", "ignore", "ignore"] });
		return;
	}
	spawnSync("sh", ["-c", "command -v wl-copy >/dev/null 2>&1 && wl-copy || xclip -selection clipboard"], {
		input: text,
		stdio: ["pipe", "ignore", "ignore"],
	});
}

export function computeTranscriptDisplayRows(
	blocks: readonly string[],
	width: number,
	unwrappedLeadingBlockCount = 0,
): number {
	return computeTranscriptDisplayRowsFromTuiCore(blocks, width, unwrappedLeadingBlockCount);
}

export function materializeAssistantTranscriptBlock(buffer: string): string | null {
	if (buffer.length === 0) {
		return null;
	}
	return formatTranscriptAssistantLine(buffer);
}

export function appendAssistantTranscriptBlock(blocks: readonly string[], assistantBlock: string): readonly string[] {
	return appendTranscriptBlockWithSpacer(blocks, assistantBlock);
}

export function appendTranscriptBlockWithSpacer(blocks: readonly string[], block: string): readonly string[] {
	if (block.length === 0) {
		return [...blocks];
	}
	const lastNonEmptyIndex = findLastNonEmptyBlockIndex(blocks);
	if (lastNonEmptyIndex === -1) {
		return [block];
	}
	const normalized = blocks.slice(0, lastNonEmptyIndex + 1);
	return [...normalized, "", block];
}

function findLastNonEmptyBlockIndex(blocks: readonly string[]): number {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		if ((blocks[index] ?? "").length > 0) {
			return index;
		}
	}
	return -1;
}

function isTranscriptUserBlock(block: string): boolean {
	return block.startsWith(`${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg} `);
}
