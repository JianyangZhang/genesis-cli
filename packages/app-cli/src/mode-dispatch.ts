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
	RuntimeEvent,
	SessionEngine,
	SessionFacade,
} from "@pickle-pee/runtime";
import {
	type ComposedScreen,
	clampScrollOffset,
	composePromptBlock,
	composeScreenWithFooter,
	composeSectionBlock,
	computeBodyViewportRows,
	computeFooterCursorColumn as computeFooterCursorColumnFromTuiCore,
	computeFooterStartRow as computeFooterStartRowFromTuiCore,
	computeMaxScrollOffset,
	computePromptCursorColumn as computePromptCursorColumnFromTuiCore,
	computeSelectionColumnsForRow,
	computeTranscriptDisplayRows as computeTranscriptDisplayRowsFromTuiCore,
	computeVisibleViewportLines,
	countRenderedTerminalRows as countRenderedTerminalRowsFromTuiCore,
	createInteractiveModePlan,
	createScreenFrame,
	detectTerminalCapabilities,
	diffScreenFrames,
	encodeFramePatches,
	encodeResetScrollRegion,
	encodeSetScrollRegion,
	ensureVisibleSelectionOffset,
	extractPlainTextSelection as extractPlainTextSelectionFromTuiCore,
	fitTerminalLine as fitTerminalLineFromTuiCore,
	materializeComposerBlock,
	materializeTextBlock,
	type RenderedComposerBlock,
	renderSelectedPlainLine,
	type ScreenFrame,
	stripAnsiControlSequences,
	summarizeFramePatches,
	summarizeScreenFrame,
	summarizeTerminalCapabilities,
	summarizeTerminalModePlan,
	type TerminalSelectionRange,
	truncatePlainText as truncatePlainTextFromTuiCore,
	wrapTranscriptContent as wrapTranscriptContentFromTuiCore,
} from "@pickle-pee/tui-core";
import type {
	InteractionState,
	InteractiveDetailPanelState,
	InteractiveInputAssistState,
	InteractiveOverlayState,
	InteractiveTurnPresenterState,
	OutputSink,
	SlashCommand,
	UsageSnapshot,
} from "@pickle-pee/ui";
import {
	acceptFirstSlashSuggestion,
	beginInteractiveTurn,
	beginInteractiveTurnFeedback,
	appendThinkingDetailText,
	beginResumeBrowserOverlaySearch,
	buildInteractiveFooterLeadingLines as buildInteractiveFooterLeadingLinesFromUi,
	buildRestoredContextLines,
	buildResumeBrowserBodyBlocks,
	buildResumeBrowserFooterHintLines,
	buildResumeBrowserHeaderLines,
	buildResumeBrowserResumedLines,
	clearInteractiveInputAssistState,
	clearPendingPermissionRequest,
	clearInteractiveTurnNotice,
	collapseInteractiveDetailPanel,
	closeResumeBrowserOverlay,
	completeResumeBrowserOverlaySearch,
	completeInteractiveTurn,
	computeInteractiveFooterSeparatorWidth,
	currentInteractiveTurnElapsedMs,
	currentInteractiveTurnUsage,
	formatSlashSuggestionHint,
	findInteractiveToolParameters,
	initialInteractiveInputAssistState,
	createInteractiveCommandRegistry,
	createInteractiveConversationState,
	drainQueuedInteractiveInputs,
	emptyUsageSnapshot,
	eventToJsonEnvelope,
	formatCompactionDetailText,
	formatEventAsText,
	formatFullWidthTranscriptUserLine,
	formatInteractiveErrorDetailLine,
	formatInteractiveErrorLine,
	formatInteractiveInfoLine,
	formatInteractiveInputSeparator,
	formatInteractivePromptBuffer,
	formatResumeBrowserTranscriptBlocks,
	formatTranscriptUserBlocks,
	INTERACTIVE_THEME,
	initialInteractiveDetailPanelState,
	initialInteractionState,
	initialInteractiveOverlayState,
	initialInteractiveTurnPresenterState,
	markResumeBrowserSubmitPending,
	materializeAssistantTranscriptBlock,
	movePendingPermissionSelection as movePendingPermissionSelectionFromUi,
	moveResumeBrowserOverlaySelection,
	openResumeBrowserOverlay,
	preserveThinkingNoticeForQueuedBacklog,
	queueInteractiveInput,
	registerInteractiveToolCall,
	reduceInteractionState,
	resetInteractiveDetailPanelState,
	resetInteractiveInputAssistState,
	resetInteractiveOverlayState,
	resetInteractiveTurnPresenterState,
	resolveRecentSessionDirectSelection,
	resolveResumeBrowserKeyAction,
	resolveResumeBrowserSubmitHit,
	setPendingPermissionRequest,
	setInteractiveDetailPanelScroll,
	setInteractiveTurnNotice,
	showCompactionDetailSummary,
	summarizeActiveInteractiveToolLabel,
	summarizeResumeBrowserHit,
	tickInteractiveTurnNoticeAnimation,
	toggleInteractiveDetailPanel,
	toggleResumeBrowserOverlayPreview,
	updateInteractiveTurnUsage,
	updateSlashCommandSuggestions,
	clearInteractiveToolCall,
} from "@pickle-pee/ui";
import { getActiveDebugLogger } from "./debug-logger.js";
import { createInteractiveHostState } from "./interactive-host-state.js";
import { executeInteractiveSlashCommand } from "./interactive-local-command-orchestrator.js";
import type { InputLoop } from "./input-loop.js";
import { createInputLoop } from "./input-loop.js";
import { createModelCommandHost, type ModelCommandHostOptions } from "./model-command-host.js";
import type { RpcServer } from "./rpc-server.js";
import { createRpcServer } from "./rpc-server.js";
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

export function createModeHandler(
	mode: CliMode,
	options?: { readonly modelHost?: ModelCommandHostOptions; readonly welcomeProvider?: string },
): ModeHandler {
	switch (mode) {
		case "interactive":
			return new InteractiveModeHandler(options?.modelHost, options?.welcomeProvider);
		case "print":
			return new PrintModeHandler();
		case "json":
			return new JsonModeHandler();
		case "rpc":
			return new RpcModeHandler();
	}
}

export async function runInteractiveStartupChecks(check: () => Promise<void>): Promise<void> {
	const handler = new InteractiveModeHandler();
	await handler.startStartupCheckScreen(check);
}

const RESIZE_REDRAW_DEBOUNCE_MS = 120;
const RENDER_DEBUG_SAME_FRAME_THROTTLE_MS = 250;

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

class InteractiveModeHandler implements ModeHandler {
	constructor(
		private readonly _modelHostOptions?: ModelCommandHostOptions,
		private readonly _welcomeProvider?: string,
	) {}

	private _activeTurn: Promise<void> | null = null;
	private readonly _prompt = "❯ ";
	private _inputState: { buffer: string; cursor: number } = { buffer: "", cursor: 0 };
	private readonly _history: string[] = [];
	private _historyIndex: number | null = null;
	private _lastError: string | null = null;
	private readonly _changedPaths = new Set<string>();
	private readonly _conversation = createInteractiveConversationState();
	private _turnNoticeTimer: ReturnType<typeof setInterval> | null = null;
	private _detailPanelState: InteractiveDetailPanelState = initialInteractiveDetailPanelState();
	private _inputAssistState: InteractiveInputAssistState = initialInteractiveInputAssistState();
	private _turnPresenterState: InteractiveTurnPresenterState = initialInteractiveTurnPresenterState();
	private _overlayState: InteractiveOverlayState = initialInteractiveOverlayState();
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
	private _resumeBrowserScrollOffset = 0;
	private _inputLoop: InputLoop | null = null;
	private readonly _hostState = createInteractiveHostState({
		onBusyLocalCommandFailed: (error) => {
			if (this._turnPresenterState.notice === "compacting") {
				this.stopTurnNoticeAnimation();
				this._turnPresenterState = clearInteractiveTurnNotice(this._turnPresenterState);
			}
			this._lastError = error instanceof Error ? error.message : String(error);
			getActiveDebugLogger()?.error("interactive.local_command", "Local command failed", { error });
			this._sink?.writeError(this._lastError);
		},
		onBusyLocalCommandSettled: () => {
			if (this._activeTurn !== null || this._turnPresenterState.notice === "compacting") {
				this.renderFooterRegion();
				return;
			}
			const queuedInputBatch = this.drainQueuedInputs();
			if (queuedInputBatch !== null && this._sessionRef !== null && this._sink !== null) {
				this.startQueuedContinueTurn(this._sessionRef.current, queuedInputBatch, this._sink);
				return;
			}
			this.fullRedrawInteractiveScreen();
		},
	});
	private _sessionEngine: SessionEngine | null = null;
	private _sessionRef: { current: SessionFacade } | null = null;
	private _sink: OutputSink | null = null;
	private _runtime: AppRuntime | null = null;
	private _recentSessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
	private _startupCheckScreenActive = false;
	private _lastRenderDebugKey: string | null = null;
	private _lastRenderDebugLoggedAt = 0;
	private _suppressedRenderDebugCount = 0;

	async start(runtime: AppRuntime): Promise<void> {
		const handler = this;
		const commandHost = createModelCommandHost(this._modelHostOptions ?? {});
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("Interactive mode requires a TTY. Use --mode print|json|rpc instead.");
		}

		let sessionTitle: string | undefined;
		const sessionEngine = runtime.createSessionEngine({
			titleResolver: () => sessionTitle,
		});
		const sessionRef: { current: SessionFacade } = { current: sessionEngine.createSession() };
		const sink: OutputSink = {
			write: (text) => {
				this.writeTranscriptText(text, false);
			},
			writeLine: (text) => {
				this.writeTranscriptText(text, true);
			},
			writeError: (text) => {
				this.writeTranscriptText(formatInteractiveErrorLine(text), true);
			},
		};
		this._sessionRef = sessionRef;
		this._sessionEngine = sessionEngine;
		this._sink = sink;
		this._runtime = runtime;

		let interactionState: InteractionState = initialInteractionState();
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
				join(sessionRef.current.context.workingDirectory, ".genesis-local", "agent")
			);
		};

		const attachSession = (next: SessionFacade): void => {
			detachSessionStateSubscription(detachSessionStateListener);
			detachSessionStateListener = null;
			sessionRef.current.events.removeAllListeners();
			sessionRef.current = next;
			this._overlayState = resetInteractiveOverlayState();
			this._activeTurn = null;
			this._historyIndex = null;
			this._lastError = null;
			this._changedPaths.clear();
			this._conversation.clear();
			this.stopTurnNoticeAnimation();
			this._turnPresenterState = resetInteractiveTurnPresenterState();
			this._detailPanelState = resetInteractiveDetailPanelState();
			this._inputAssistState = resetInteractiveInputAssistState();
			this._hostState.reset();
			this._renderedFooterUi = null;
			this._renderedFooterStartRow = null;
			this._lastScreenFrame = null;
			this._transcriptScrollOffset = 0;
			this._resumeBrowserScrollOffset = 0;
			if (this._recentSessionPersistTimer !== null) {
				clearTimeout(this._recentSessionPersistTimer);
				this._recentSessionPersistTimer = null;
			}
			this._sessionRef = sessionRef;
			this._sink = sink;
			this._runtime = runtime;
			sessionTitle = undefined;
			interactionState = initialInteractionState();

			sessionRef.current.events.onAny((event: RuntimeEvent) => {
				if (event.type === "permission_requested") {
					this._overlayState = setPendingPermissionRequest(this._overlayState, event.toolCallId, {
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						riskLevel: event.riskLevel,
						reason: (event as { reason?: string }).reason,
						targetPath: (event as { targetPath?: string }).targetPath,
					});
				}
				if (event.type === "permission_resolved") {
					this._overlayState = clearPendingPermissionRequest(this._overlayState, event.toolCallId);
				}
				if (event.type === "tool_started") {
					this._turnPresenterState = registerInteractiveToolCall(this._turnPresenterState, {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						parameters: event.parameters,
					});
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
					this._turnPresenterState = clearInteractiveToolCall(this._turnPresenterState, event.toolCallId);
					this._lastError = `${event.toolName}: ${event.reason}`;
				}
				if (event.type === "tool_completed" && event.status === "failure") {
					this._turnPresenterState = clearInteractiveToolCall(this._turnPresenterState, event.toolCallId);
					this._lastError = `${event.toolName}: ${event.result ?? "failure"}`;
				}
				if (event.type === "tool_completed" && event.status === "success") {
					this._turnPresenterState = clearInteractiveToolCall(this._turnPresenterState, event.toolCallId);
				}

				interactionState = reduceInteractionState(interactionState, event);
				this.handleTranscriptEvent(event);
				if (shouldPersistRecentSessionForEvent(event)) {
					this.scheduleRecentSessionPersist(runtime, sessionRef.current, event, sessionTitle);
				}
			});
			detachSessionStateListener = sessionRef.current.onStateChange((state) => {
				if (
					state.model.id !== sessionRef.current.state.model.id ||
					state.model.provider !== sessionRef.current.state.model.provider
				) {
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

		const registry = createInteractiveCommandRegistry({
			getCurrentSession: () => sessionRef.current,
			getSessionTitle: () => sessionTitle,
			setSessionTitle: (next) => {
				sessionTitle = next;
			},
			createSession: () => sessionEngine.createSession(),
			closeCurrentSession: async () => {
				await sessionEngine.closeSession(sessionRef.current.id.value);
			},
			requestExit: () => {
				exitRequested = true;
				inputLoop?.close();
			},
			isInteractionBusy: () => handler.isInteractionBusy(),
			hasPendingPermissionRequest: () => handler.pendingPermissionState() !== null,
			replaceSession: (next) => {
				switchInteractiveSession(next);
			},
			getAgentDir: () => resolveAgentDir(),
			getInteractionPhase: () => interactionState.phase,
			getLastError: () => handler._lastError,
			getChangedFileCount: () => handler._changedPaths.size,
			getPendingPermissionCallId: () => handler.pendingPermissionState()?.callId ?? null,
			getToolUsageSummary: () => {
				const entries = runtime.governor.audit.getAll();
				return {
					total: entries.length,
					success: entries.filter((e) => e.status === "success").length,
					failure: entries.filter((e) => e.status === "failure").length,
					denied: entries.filter((e) => e.status === "denied").length,
					recent: entries.slice(-10).map((entry) => ({
						status: entry.status,
						toolName: entry.toolName,
						riskLevel: entry.riskLevel,
						targetPath: entry.targetPath,
						durationMs: entry.durationMs,
					})),
				};
			},
			getConfigSnapshot: async (ctx) => {
				const sources = ctx.session.context.configSources ?? {};
				const agentDir = resolveAgentDir();
				const modelsPath = join(agentDir, "models.json");
				let raw = "";
				try {
					raw = await readFile(modelsPath, "utf8");
				} catch {
					return {
						sources: Object.keys(sources)
							.sort((a, b) => a.localeCompare(b))
							.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
						agentDir,
						modelsPath,
						error: "models.json not found. Run Genesis once or pass --agent-dir.",
					};
				}

				const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
				const providerKey = ctx.session.state.model.provider;
				const provider = parsed.providers?.[providerKey];
				if (!provider) {
					return {
						sources: Object.keys(sources)
							.sort((a, b) => a.localeCompare(b))
							.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
						agentDir,
						modelsPath,
						providerKey,
					};
				}

				const models = Array.isArray(provider.models) ? provider.models : [];
				const active = models.find((m: any) => m?.id === ctx.session.state.model.id);
				const apiKeyEnv = typeof provider.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
				return {
					sources: Object.keys(sources)
						.sort((a, b) => a.localeCompare(b))
						.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
					agentDir,
					modelsPath,
					providerKey,
					provider: {
						api: provider.api ?? "(missing)",
						baseUrl: provider.baseUrl ?? "(missing)",
						apiKeyEnv,
						apiKeyPresent: Boolean(process.env[apiKeyEnv]),
					},
					activeModel: active
						? {
								name: active.name ?? active.id,
								id: active.id,
								reasoning: Boolean(active.reasoning),
							}
						: null,
					modelError: active ? null : `Model not configured: ${ctx.session.state.model.id}`,
				};
			},
			getWorkingTreeSummary: async () => ({
				changedPaths: [...handler._changedPaths],
				snapshot: await inspectGitWorkingTree(sessionRef.current.context.workingDirectory),
			}),
			getGitDiff: async (target) => readGitDiff(sessionRef.current.context.workingDirectory, target),
			getDoctorSnapshot: async (ctx) => {
				const agentDir = resolveAgentDir();
				const modelsPath = join(agentDir, "models.json");
				let raw = "";
				try {
					raw = await readFile(modelsPath, "utf8");
				} catch {
					return null;
				}
				const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
				const providerKey = ctx.session.state.model.provider;
				const provider = parsed.providers?.[providerKey];
				const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
				const api = typeof provider?.api === "string" ? provider.api : "";
				const apiKeyEnv = typeof provider?.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
				const apiKey = process.env[apiKeyEnv];
				const snapshot = {
					providerKey,
					api,
					baseUrl,
					apiKeyEnv,
					apiKeyPresent: Boolean(apiKey),
				};
				if (!apiKey || !baseUrl || api !== "openai-completions") {
					return snapshot;
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
					if (!response.ok) {
						return { ...snapshot, httpStatus: response.status, errorText: await response.text() };
					}
					const payload = (await response.json()) as any;
					const text = payload?.choices?.[0]?.message?.content;
					return {
						...snapshot,
						httpStatus: response.status,
						responseText: typeof text === "string" ? text.trim() : null,
					};
				} catch (err) {
					return { ...snapshot, errorText: `  error: ${err instanceof Error ? err.message : String(err)}` };
				} finally {
					clearTimeout(timeout);
				}
			},
		});

		registry.register({
			name: "resume",
			description: "Show recent sessions or resume one",
			type: "local",
			visibility: "public",
			async execute(ctx) {
				if (handler.isInteractionBusy() || handler.pendingPermissionState() !== null) {
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

				const recovered = await sessionEngine.recoverSession(data, { closeActive: true });
				switchInteractiveSession(recovered);
				handler.closeResumeBrowser();
				for (const line of buildRestoredContextLines(directMatch)) {
					ctx.output.writeLine(line);
				}
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
				if (this.resumeBrowserState() !== null) {
					if (this._overlayState.resumeBrowserSubmitPending && state.buffer.length === 0) {
						this._overlayState = markResumeBrowserSubmitPending(this._overlayState, false);
						this.renderPromptLine();
						return;
					}
					this._inputAssistState = clearInteractiveInputAssistState(this._inputAssistState);
					void this.refreshResumeBrowserResults(runtime, state.buffer);
					return;
				}
				this._inputAssistState = updateSlashCommandSuggestions(this._inputAssistState, state.buffer, registry.listPublic());
				this.renderPromptLine();
			},
			onTabComplete: (state) => {
				if (this.resumeBrowserState() !== null) {
					return null;
				}
				if (this.pendingPermissionState() !== null) {
					return null;
				}
				const nextState = acceptFirstSlashSuggestion(state, this._inputAssistState.commandSuggestions);
				if (nextState) {
					this._inputState = nextState;
					this._inputAssistState = updateSlashCommandSuggestions(
						this._inputAssistState,
						nextState.buffer,
						registry.listPublic(),
					);
					this.renderPromptLine();
				}
				return nextState;
			},
			onKey: (key) => {
				if (key === "ctrlc") {
					const permissionState = this.pendingPermissionState();
					if (permissionState !== null) {
						const callId = permissionState.callId;
						this._overlayState = clearPendingPermissionRequest(this._overlayState, callId);
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
			onSubmit: (line) => {
				if (this.resumeBrowserState() !== null && line.length >= 0) {
					this._overlayState = markResumeBrowserSubmitPending(this._overlayState, true);
				}
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

				if (this.resumeBrowserState() !== null) {
					const handled = await this.handleResumeBrowserSubmit(
						line,
						runtime,
						sessionRef,
						sink,
						switchInteractiveSession,
					);
					if (handled) {
						if (exitRequested) {
							break;
						}
						line = await inputLoop.nextLine();
						continue;
					}
				}

				// Permission response
				const permissionState = this.pendingPermissionState();
				if (permissionState !== null) {
					const decision = parsePermissionDecision(trimmed, permissionState.selectedIndex);
					if (!decision) {
						sink.writeError("Permission: use 1/2/3, Enter, y/Y/n, or arrow keys/Tab to choose.");
						line = await inputLoop.nextLine();
						continue;
					}
					await sessionRef.current.resolvePermission(permissionState.callId, decision);
					this._overlayState = clearPendingPermissionRequest(this._overlayState, permissionState.callId);
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
					await executeInteractiveSlashCommand({
						resolution,
						runtime,
						session: sessionRef.current,
						output: sink,
						host: commandHost,
						isInteractionBusy: () => this.isInteractionBusy(),
						runLocalBusyCommand: (command) => {
							this._hostState.runLocalBusyCommand(command);
						},
						onError: (error) => {
							this._lastError = error instanceof Error ? error.message : String(error);
							getActiveDebugLogger()?.error("interactive.slash_command", "Slash command failed", {
								command: resolution.command.name,
								args: resolution.args,
								error,
							});
							sink.writeError(this._lastError);
						},
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
				if (this.isInteractionBusy()) {
					this._turnPresenterState = queueInteractiveInput(this._turnPresenterState, trimmed);
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
			await sessionEngine.closeAllSessions();
			sessionEngine.dispose();
			this._sessionEngine = null;
		}
	}

	async startStartupCheckScreen(check: () => Promise<void>): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			await check();
			return;
		}
		this._startupCheckScreenActive = true;
		this._lastError = null;
		this._inputState = { buffer: "", cursor: 0 };
		this._inputAssistState = resetInteractiveInputAssistState();
		this._welcomeLines = buildWelcomeLines({
			terminalWidth: process.stdout.columns ?? 80,
			version: readInteractiveCliPackageVersion(),
			model: "Startup checks",
			provider: "Genesis",
			greeting: pickWelcomeGreeting(),
			debugTraceId: getActiveDebugLogger()?.session.debugEnabled
				? getActiveDebugLogger()?.session.traceId
				: undefined,
		});

		const terminalCapabilities = detectTerminalCapabilities({
			term: process.env.TERM,
			termProgram: process.env.TERM_PROGRAM,
			terminalEmulator: process.env.TERMINAL_EMULATOR,
			tmux: process.env.TMUX,
		});
		const terminalModePlan = createInteractiveModePlan({
			...terminalCapabilities,
			bracketedPaste: false,
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

		const inputLoop = createInputLoop({
			prompt: this.currentPrompt(),
			input: process.stdin,
			output: process.stdout,
			rawMode: true,
			onInputStateChange: (state) => {
				this._inputState = state;
				this.renderPromptLine();
			},
			onKey: (key) => {
				if (key === "ctrlc") {
					inputLoop.close();
				}
			},
		});
		this._inputLoop = inputLoop;

		ttySession.enter();
		this.fullRedrawInteractiveScreen();

		try {
			for (;;) {
				this._lastError = null;
				this.writeTranscriptText(formatInteractiveInfoLine("Running startup checks..."), true);
				try {
					await check();
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this._lastError = message;
					getActiveDebugLogger()?.error("interactive.startup_check", "Interactive startup check failed", {
						error,
					});
					this.writeTranscriptText(formatInteractiveErrorLine("Startup checks failed"), true);
					this.writeTranscriptText(formatInteractiveErrorDetailLine(message), true);
					this.writeTranscriptText(
						formatInteractiveInfoLine("Fix the configuration, then press Enter to retry."),
						true,
					);
				}
				const line = await inputLoop.nextLine();
				if (line === null) {
					throw new Error(this._lastError ?? "Interactive startup checks aborted");
				}
				this._inputState = { buffer: "", cursor: 0 };
			}
		} finally {
			debouncedResizeRedraw.cancel();
			process.stdout.off("resize", onResize);
			inputLoop.close();
			this._inputLoop = null;
			this._startupCheckScreenActive = false;
			ttySession.restore();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		const debugTraceId = getActiveDebugLogger()?.session.debugEnabled
			? getActiveDebugLogger()?.session.traceId
			: undefined;
		this._welcomeLines = buildWelcomeLines({
			terminalWidth: process.stdout.columns ?? 80,
			version: readInteractiveCliPackageVersion(),
			model: session.state.model.displayName ?? session.state.model.id,
			provider: this._welcomeProvider ?? session.state.model.provider,
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
		if (this.resumeBrowserState() !== null) {
			const action = resolveResumeBrowserKeyAction(key, this.currentResumeBrowserBodyViewportRows());
			if (action?.type === "close") {
				this.closeResumeBrowser();
				return;
			}
			if (action?.type === "toggle_preview") {
				this.toggleResumeBrowserPreview();
				return;
			}
			if (action?.type === "move_selection") {
				this.moveResumeBrowserSelection(action.delta);
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
		if (key === "esc" && this._detailPanelState.expanded) {
			this._detailPanelState = collapseInteractiveDetailPanel(this._detailPanelState);
			this.renderFooterRegion();
			return;
		}
		if (this._detailPanelState.expanded) {
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
		if (this.pendingPermissionState() !== null) {
			if (key === "up" || key === "shifttab") {
				this._overlayState = movePendingPermissionSelectionFromUi(this._overlayState, -1);
				this.renderPermissionUi();
			} else if (key === "down" || key === "tab") {
				this._overlayState = movePendingPermissionSelectionFromUi(this._overlayState, 1);
				this.renderPermissionUi();
			}
			return;
		}
		if (key === "up" || key === "down") {
			this.navigateHistory(key === "up" ? -1 : 1);
		}
	}

	private renderPermissionUi(): void {
		if (this.pendingPermissionState() === null) {
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
			const text = formatInteractiveToolEvent(event, findInteractiveToolParameters(this._turnPresenterState, event.toolCallId));
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
				this._turnPresenterState = setInteractiveTurnNotice(this._turnPresenterState, "compacting", {
					startedAt: Date.now(),
				});
				this.startTurnNoticeAnimation();
			} else {
				this.stopTurnNoticeAnimation();
				this._turnPresenterState = clearInteractiveTurnNotice(this._turnPresenterState);
				this._detailPanelState = showCompactionDetailSummary(
					this._detailPanelState,
					formatCompactionDetailText(event.summary),
				);
				if (
					!this._hostState.hasActiveLocalCommand() &&
					this._activeTurn === null &&
					this._sessionRef !== null &&
					this._sink !== null
				) {
					const queuedInputBatch = this.drainQueuedInputs();
					if (queuedInputBatch !== null) {
						this.startQueuedContinueTurn(this._sessionRef.current, queuedInputBatch, this._sink);
						return;
					}
				}
			}
			this.renderPromptLine();
			return;
		}
		if (event.category === "session" && event.type === "session_error") {
			this._lastError = event.message;
			this._turnPresenterState = clearInteractiveTurnNotice(this._turnPresenterState);
			getActiveDebugLogger()?.error("interactive.session_error", "Interactive session reported an upstream error", {
				message: event.message,
				source: event.source,
				fatal: event.fatal,
			});
			this.flushAssistantBuffer(false);
			this.writeTranscriptText(formatInteractiveErrorLine(event.message), true);
			return;
		}
		if (!shouldRenderInteractiveTranscriptEvent(event)) {
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "thinking_delta") {
			this._detailPanelState = appendThinkingDetailText(this._detailPanelState, event.content);
			if (this._turnPresenterState.notice === null) {
				this.startTurnFeedback();
			}
			this.renderPromptLine();
			return;
		}
		if (event.category === "text" && event.type === "text_delta") {
			if (this._turnPresenterState.notice !== "responding") {
				this._turnPresenterState = setInteractiveTurnNotice(this._turnPresenterState, "responding");
				this.startTurnNoticeAnimation();
			}
			const previousRows = this.currentTranscriptDisplayRows();
			this._conversation.mergeAssistantDelta(event.content);
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
		if (!this._conversation.hasAssistantBuffer()) {
			if (redrawPrompt) {
				this.renderPromptLine();
			}
			return;
		}
		const assistantText = this._conversation.consumeAssistantBuffer();
		const assistantBlock = materializeAssistantTranscriptBlock(assistantText);
		if (assistantBlock !== null) {
			const previousRows = this.currentTranscriptDisplayRows();
			this.rememberAssistantTranscriptBlock(assistantBlock);
			this.adjustTranscriptScrollForGrowth(previousRows, this.currentTranscriptDisplayRows());
			if (this._runtime !== null && this._sessionRef !== null) {
				void this._runtime.recordRecentSessionAssistantText(this._sessionRef.current, assistantText);
			}
		}
		if (redrawPrompt) {
			this.renderPromptLine();
		}
	}

	private startTurnFeedback(): void {
		if (this._turnPresenterState.notice !== null) {
			return;
		}
		this._turnPresenterState = beginInteractiveTurnFeedback(this._turnPresenterState, Date.now());
		this.startTurnNoticeAnimation();
		this.renderPromptLine();
	}

	private startTurnNoticeAnimation(): void {
		if (this._turnNoticeTimer !== null) {
			return;
		}
		this._turnNoticeTimer = setInterval(() => {
			if (this._turnPresenterState.notice === null) {
				return;
			}
			this._turnPresenterState = tickInteractiveTurnNoticeAnimation(this._turnPresenterState);
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
		this._overlayState = openResumeBrowserOverlay(this._overlayState, initialQuery);
		this._detailPanelState = resetInteractiveDetailPanelState();
		this._transcriptScrollOffset = 0;
		this._resumeBrowserScrollOffset = 0;
		this.clearMouseSelection(false);
		this._inputAssistState = resetInteractiveInputAssistState();
		getActiveDebugLogger()?.debug("resume.browser.open", "Opened resume browser", {
			initialQuery,
			transcriptScrollOffset: this._transcriptScrollOffset,
		});
		if (this._inputLoop !== null) {
			this._inputLoop.setState({ buffer: initialQuery, cursor: initialQuery.length });
		} else {
			this._inputState = { buffer: initialQuery, cursor: initialQuery.length };
			await this.refreshResumeBrowserResults(runtime, initialQuery);
		}
		this.rerenderInteractiveRegions();
	}

	private closeResumeBrowser(): void {
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return;
		}
		getActiveDebugLogger()?.debug("resume.browser.close", "Closed resume browser", {
			query: browser.query,
			selectedIndex: browser.selectedIndex,
			resultCount: browser.hits.length,
			previewExpanded: browser.previewExpanded,
		});
		this._overlayState = closeResumeBrowserOverlay(this._overlayState);
		this._transcriptScrollOffset = 0;
		this._resumeBrowserScrollOffset = 0;
		this.clearMouseSelection(false);
		if (this._inputLoop !== null) {
			this._inputLoop.setState({ buffer: "", cursor: 0 });
		} else {
			this._inputState = { buffer: "", cursor: 0 };
			this._inputAssistState = resetInteractiveInputAssistState();
		}
		this.rerenderInteractiveRegions();
	}

	private async refreshResumeBrowserResults(runtime: AppRuntime, query: string): Promise<void> {
		const started = beginResumeBrowserOverlaySearch(this._overlayState, query);
		if (started === null) {
			return;
		}
		const nextQuery = query;
		this._overlayState = started.state;
		this.rerenderInteractiveRegions();
		const hits = await runtime.searchRecentSessions(nextQuery);
		if (this.resumeBrowserState() === null || started.requestId !== this._overlayState.resumeSearchRequestId) {
			return;
		}
		this._overlayState = completeResumeBrowserOverlaySearch(this._overlayState, {
			requestId: started.requestId,
			nextQuery,
			hits,
			selectedSessionId: started.selectedSessionId,
			fallbackIndex: started.previous.selectedIndex,
		});
		if (started.previous.query !== nextQuery) {
			this._resumeBrowserScrollOffset = 0;
		}
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return;
		}
		getActiveDebugLogger()?.debug("resume.browser.search", "Refreshed resume browser results", {
			query: nextQuery,
			requestId: started.requestId,
			resultCount: hits.length,
			selectedIndex: browser.selectedIndex,
			topHit: summarizeResumeBrowserHit(hits[0]),
			selectedHit: summarizeResumeBrowserHit(hits[browser.selectedIndex]),
			scrollOffset: this._resumeBrowserScrollOffset,
		});
		this.ensureResumeBrowserSelectionVisible();
		this.rerenderInteractiveRegions();
	}

	private moveResumeBrowserSelection(delta: number): void {
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return;
		}
		const nextState = moveResumeBrowserOverlaySelection(this._overlayState, delta);
		const nextBrowser = nextState.resumeBrowser;
		if (nextBrowser === null || nextBrowser.selectedIndex === browser.selectedIndex) {
			return;
		}
		this._overlayState = nextState;
		getActiveDebugLogger()?.debug("resume.browser.selection", "Moved resume browser selection", {
			delta,
			selectedIndex: nextBrowser.selectedIndex,
			selectedHit: summarizeResumeBrowserHit(nextBrowser.hits[nextBrowser.selectedIndex]),
			scrollOffset: this._resumeBrowserScrollOffset,
		});
		this.ensureResumeBrowserSelectionVisible();
		this.rerenderInteractiveRegions();
	}

	private toggleResumeBrowserPreview(): void {
		if (this.resumeBrowserState() === null) {
			return;
		}
		this._overlayState = toggleResumeBrowserOverlayPreview(this._overlayState);
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return;
		}
		getActiveDebugLogger()?.debug("resume.browser.preview", "Toggled resume browser preview", {
			previewExpanded: browser.previewExpanded,
			selectedIndex: browser.selectedIndex,
			selectedHit: summarizeResumeBrowserHit(browser.hits[browser.selectedIndex]),
		});
		this.ensureResumeBrowserSelectionVisible();
		this.rerenderInteractiveRegions();
	}

	private async handleResumeBrowserSubmit(
		line: string,
		runtime: AppRuntime,
		sessionRef: { current: SessionFacade },
		sink: OutputSink,
		switchInteractiveSession: (nextSession: SessionFacade) => void,
	): Promise<boolean> {
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return false;
		}
		getActiveDebugLogger()?.debug("resume.browser.submit", "Handling resume browser submit", {
			line,
			loading: browser.loading,
			selectedIndex: browser.selectedIndex,
			hitCount: browser.hits.length,
		});
		if (browser.loading) {
			return true;
		}
		const hit = resolveResumeBrowserSubmitHit(browser);
		if (!hit) {
			return true;
		}
		const data = hit.entry.recoveryData;
		getActiveDebugLogger()?.debug("resume.browser.resume", "Resuming selected session", {
			selectedIndex: browser.selectedIndex,
			selectedHit: summarizeResumeBrowserHit(hit),
		});
		this.closeResumeBrowser();
		const recovered = await this.requireSessionEngine().recoverSession(data, { closeActive: true });
		switchInteractiveSession(recovered);
		for (const line of buildResumeBrowserResumedLines(hit)) {
			sink.writeLine(line);
		}
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
		this._turnPresenterState = beginInteractiveTurn(this._turnPresenterState, Date.now());
		this._detailPanelState = resetInteractiveDetailPanelState();
		this.rememberHistory(input);
		if (this._runtime !== null) {
			void this._runtime.recordRecentSessionInput(session, input);
		}
		this._activeTurn = this.requireSessionEngine()
			.submit(input, { mode, sessionId: session.id.value })
			.catch((err: unknown) => {
				sink.writeError(`Error: ${err}`);
			})
			.finally(() => {
				this.stopTurnNoticeAnimation();
				this._activeTurn = null;
				this.flushAssistantBuffer(false);
				this._turnPresenterState = completeInteractiveTurn(this._turnPresenterState);
				this._detailPanelState = resetInteractiveDetailPanelState();
				const queuedInputBatch = this.drainQueuedInputs();
				if (queuedInputBatch !== null) {
					this.startQueuedContinueTurn(session, queuedInputBatch, sink);
					return;
				}
				this.fullRedrawInteractiveScreen();
			});
	}

	private requireSessionEngine(): SessionEngine {
		if (this._sessionEngine === null) {
			throw new Error("Interactive session engine is not initialized");
		}
		return this._sessionEngine;
	}

	private resumeBrowserState() {
		return this._overlayState.resumeBrowser;
	}

	private pendingPermissionState() {
		return this._overlayState.pendingPermission;
	}

	private drainQueuedInputs(): string | null {
		const drained = drainQueuedInteractiveInputs(this._turnPresenterState);
		this._turnPresenterState = drained.state;
		return drained.batch;
	}

	private preserveThinkingNoticeForQueuedBacklog(): void {
		if (this._activeTurn === null && this._turnPresenterState.notice !== "compacting") {
			return;
		}
		this._turnPresenterState = preserveThinkingNoticeForQueuedBacklog(this._turnPresenterState, Date.now());
		if (this._turnPresenterState.notice !== null) {
			this.startTurnNoticeAnimation();
		}
	}

	private isInteractionBusy(): boolean {
		return (
			this._activeTurn !== null ||
			this._hostState.hasActiveLocalCommand() ||
			this._turnPresenterState.notice === "compacting"
		);
	}

	private scheduleRecentSessionPersist(
		runtime: AppRuntime,
		session: SessionFacade,
		event: RuntimeEvent,
		title?: string,
	): void {
		if (this._recentSessionPersistTimer !== null) {
			clearTimeout(this._recentSessionPersistTimer);
		}
		this._recentSessionPersistTimer = setTimeout(() => {
			this._recentSessionPersistTimer = null;
			void this.enqueueRecentSessionPersist(runtime, session, event, title);
		}, 120);
	}

	private async enqueueRecentSessionPersist(
		runtime: AppRuntime,
		session: SessionFacade,
		event: RuntimeEvent,
		title?: string,
	): Promise<void> {
		try {
			await runtime.recordRecentSessionEvent(session, event, { title });
			getActiveDebugLogger()?.debug("resume.history.persist", "Persisted runtime-owned session history update", {
				sessionId: session.id.value,
				category: event.category,
				type: event.type,
			});
		} catch (error) {
			getActiveDebugLogger()?.error(
				"resume.history.persist",
				"Failed to persist runtime-owned session history update",
				{
					error,
					sessionId: session.id.value,
					category: event.category,
					type: event.type,
				},
			);
		}
	}

	private ensureResumeBrowserSelectionVisible(): void {
		if (this.resumeBrowserState() === null) {
			return;
		}
		this._resumeBrowserScrollOffset = ensureVisibleSelectionOffset({
			currentOffset: this._resumeBrowserScrollOffset,
			viewportRows: this.currentResumeBrowserBodyViewportRows(),
			selectedRange: this.currentResumeBrowserSelectedRowRange(),
		});
		this.clampResumeBrowserScrollOffset();
	}

	private toggleDetailPanel(): void {
		if (this.currentDetailPanelContentLines().length === 0) {
			return;
		}
		this._detailPanelState = toggleInteractiveDetailPanel(this._detailPanelState, {
			hasContent: this.currentDetailPanelContentLines().length > 0,
		});
		this.renderFooterRegion();
	}

	private scrollDetailPanel(delta: number): void {
		const viewport = this.currentDetailPanelViewport();
		if (viewport.totalLines <= viewport.viewportSize) {
			return;
		}
		const maxScroll = Math.max(0, viewport.totalLines - viewport.viewportSize);
		const next = Math.max(0, Math.min(maxScroll, this._detailPanelState.scrollOffset + delta));
		if (next === this._detailPanelState.scrollOffset) {
			return;
		}
		this._detailPanelState = setInteractiveDetailPanelScroll(this._detailPanelState, next);
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
		const activeToolLabel = summarizeActiveInteractiveToolLabel(this._turnPresenterState);
		const detailPanel = this.currentDetailPanelViewport();
		const pendingPermission = this.pendingPermissionState();
		return formatInteractiveFooter({
			terminalWidth: process.stdout.columns ?? 80,
			prompt: this.currentPrompt(),
			buffer: this._inputState.buffer,
			cursor: this._inputState.cursor,
			suggestions: this._inputAssistState.commandSuggestions,
			turnNotice: activeToolLabel !== null ? "tool" : this._turnPresenterState.notice,
			turnNoticeAnimationFrame: this._turnPresenterState.noticeAnimationFrame,
			elapsedMs: this.currentTurnElapsedMs(),
			currentTurnUsage: this.currentTurnUsage(),
			lastTurnUsage: this._turnPresenterState.lastTurnUsage,
			sessionUsage: this._turnPresenterState.sessionUsageTotals,
			activeToolLabel,
			showPendingOutputIndicator: this.shouldShowPendingOutputIndicator(activeToolLabel),
			detailPanelExpanded: this._detailPanelState.expanded,
			detailPanelLines: detailPanel.lines,
			detailPanelSummary: detailPanel.summary,
			queuedInputs: this._turnPresenterState.queuedInputs,
			permission:
				pendingPermission !== null
					? {
							details: pendingPermission.details,
							selectedIndex: pendingPermission.selectedIndex,
						}
					: null,
		});
	}

	private currentDetailPanelContentLines(): readonly string[] {
		if (this._detailPanelState.thinkingText.trim().length > 0) {
			return wrapTranscriptContentFromTuiCore(this._detailPanelState.thinkingText.trim(), this.terminalWidth());
		}
		if (this._detailPanelState.compactionDetailText.trim().length > 0) {
			return wrapTranscriptContentFromTuiCore(this._detailPanelState.compactionDetailText.trim(), this.terminalWidth());
		}
		return [];
	}

	private currentPrompt(): string {
		if (this._startupCheckScreenActive) {
			return this._lastError ? "Press Enter to retry " : "Running startup checks ";
		}
		return this.resumeBrowserState() === null ? this._prompt : "Search> ";
	}

	private shouldShowPendingOutputIndicator(activeToolLabel: string | null): boolean {
		if (this._conversation.hasAssistantBuffer()) {
			return true;
		}
		if (activeToolLabel === null) {
			return false;
		}
		const lastBlock = this._conversation.getLatestTranscriptBlock();
		if (lastBlock === null) {
			return false;
		}
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
		if (!this._detailPanelState.expanded) {
			return {
				lines: [],
				summary: "ctrl+o to expand",
				viewportSize: 0,
				totalLines: lines.length,
			};
		}
		const viewportSize = Math.max(3, this.terminalHeight() - 8);
		const maxScroll = Math.max(0, lines.length - viewportSize);
		const start = Math.max(0, Math.min(this._detailPanelState.scrollOffset, maxScroll));
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
		if (this.resumeBrowserState() !== null) {
			this.clampResumeBrowserScrollOffset();
		} else {
			this.clampTranscriptScrollOffset();
		}
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
		this._turnPresenterState = updateInteractiveTurnUsage(this._turnPresenterState, usage, isFinal);
	}

	private currentTurnUsage(): UsageSnapshot | null {
		return currentInteractiveTurnUsage(this._turnPresenterState);
	}

	private currentTurnElapsedMs(): number | null {
		return currentInteractiveTurnElapsedMs(this._turnPresenterState, Date.now());
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
			computeFooterStartRowFromTuiCore(
				this.terminalHeight(),
				footerUi.lines.length,
				this.currentTranscriptDisplayRows(),
			) - 1;
		return Math.max(0, transcriptBottomRow - transcriptTopRow + 1);
	}

	private currentResumeBrowserTopLines(): readonly string[] {
		const browser = this.resumeBrowserState();
		return browser === null ? [] : buildResumeBrowserHeaderLines(browser);
	}

	private currentResumeBrowserBodyBlocks(): readonly string[] {
		const browser = this.resumeBrowserState();
		return browser === null ? [] : buildResumeBrowserBodyBlocks(browser);
	}

	private buildResumeBrowserFooterUi(): InteractiveFooterRenderResult {
		const terminalWidth = this.terminalWidth();
		const separator = formatInteractiveInputSeparator(computeInteractiveFooterSeparatorWidth(terminalWidth));
		const layout = composePromptBlock({
			leadingLines: buildResumeBrowserFooterHintLines(),
			separator,
			prompt: "Search> ",
			buffer: formatInteractivePromptBuffer(this._inputState.buffer, false),
			cursor: this._inputState.cursor,
		});
		return materializeComposerBlock(layout, terminalWidth);
	}

	private currentResumeBrowserBodyViewportRows(): number {
		const footerHeight = this.buildResumeBrowserFooterUi().lines.length;
		const topHeight = Math.min(
			this.currentResumeBrowserTopLines().length,
			Math.max(0, this.terminalHeight() - footerHeight),
		);
		return computeBodyViewportRows(this.terminalHeight(), topHeight, footerHeight);
	}

	private currentResumeBrowserBodyDisplayRows(): number {
		return this.currentResumeBrowserBodyBlocks().reduce(
			(total, block) => total + countRenderedTerminalRowsFromTuiCore(block.split("\n"), this.terminalWidth()),
			0,
		);
	}

	private currentResumeBrowserBodyMaxScroll(): number {
		return computeMaxScrollOffset(
			this.currentResumeBrowserBodyDisplayRows(),
			this.currentResumeBrowserBodyViewportRows(),
		);
	}

	private clampResumeBrowserScrollOffset(): void {
		this._resumeBrowserScrollOffset = clampScrollOffset(
			this._resumeBrowserScrollOffset,
			this.currentResumeBrowserBodyMaxScroll(),
		);
	}

	private currentResumeBrowserSelectedRowRange(): { start: number; end: number } | null {
		const browser = this.resumeBrowserState();
		if (browser === null) {
			return null;
		}
		const blocks = this.currentResumeBrowserBodyBlocks();
		const selectedBlock = blocks[browser.selectedIndex];
		if (!selectedBlock) {
			return null;
		}
		let start = 0;
		for (let index = 0; index < browser.selectedIndex; index += 1) {
			start += countRenderedTerminalRowsFromTuiCore((blocks[index] ?? "").split("\n"), this.terminalWidth());
		}
		let end =
			start + Math.max(0, countRenderedTerminalRowsFromTuiCore(selectedBlock.split("\n"), this.terminalWidth()) - 1);
		const previewBlock = blocks[browser.selectedIndex + 1];
		if (browser.previewExpanded && previewBlock?.startsWith("Preview\n")) {
			end += countRenderedTerminalRowsFromTuiCore(previewBlock.split("\n"), this.terminalWidth());
		}
		return {
			start,
			end,
		};
	}

	private currentTranscriptMaxScroll(): number {
		return computeMaxScrollOffset(this.currentTranscriptDisplayRows(), this.currentTranscriptViewportRows());
	}

	private clampTranscriptScrollOffset(): void {
		this._transcriptScrollOffset = clampScrollOffset(this._transcriptScrollOffset, this.currentTranscriptMaxScroll());
	}

	private isTranscriptMouseRow(row: number): boolean {
		if (this.resumeBrowserState() !== null) {
			return false;
		}
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
		return extractPlainTextSelectionFromTuiCore(this._renderedTranscriptViewportLines, {
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
		this._conversation.rememberTranscriptBlock(block, true);
	}

	private rememberAssistantTranscriptBlock(block: string): void {
		this._conversation.rememberAssistantTranscriptBlock(block);
	}

	private fullRedrawInteractiveScreen(): void {
		this.renderInteractiveScreenState({ resetScrollRegion: true });
	}

	private renderTranscriptViewport(): void {
		this.renderInteractiveScreenState();
	}

	private renderInteractiveScreenState(options: { readonly resetScrollRegion?: boolean } = {}): void {
		const browser = this.resumeBrowserState();
		if (browser !== null) {
			this.clampResumeBrowserScrollOffset();
		} else {
			this.clampTranscriptScrollOffset();
		}
		if (options.resetScrollRegion) {
			process.stdout.write(encodeResetScrollRegion());
		}
		const next = this.buildInteractiveScreenFrame();
		const patches = diffScreenFrames(this._lastScreenFrame, next.frame);
		const patchSummary = summarizeFramePatches(patches);
		const renderDebug = this.prepareRenderDebugRecord({
			resetScrollRegion: options.resetScrollRegion ?? false,
			footerStartRow: next.footerStartRow,
			pinFooterToBottom: next.pinFooterToBottom,
			footerLineCount: next.footerUi.lines.length,
			transcriptViewportLineCount: this._renderedTranscriptViewportLines.length,
			frame: summarizeScreenFrame(next.frame),
			patches: patchSummary,
		});
		if (renderDebug !== null) {
			getActiveDebugLogger()?.debug("tui.render", "Rendered interactive screen frame", renderDebug);
		}
		if (browser !== null) {
			getActiveDebugLogger()?.debug("resume.browser.layout", "Rendered resume browser layout", {
				headerLineCount: this.currentResumeBrowserTopLines().length,
				bodyViewportRows: this.currentResumeBrowserBodyViewportRows(),
				bodyDisplayRows: this.currentResumeBrowserBodyDisplayRows(),
				scrollOffset: this._resumeBrowserScrollOffset,
				selectedIndex: browser.selectedIndex,
				previewExpanded: browser.previewExpanded,
				footerStartRow: next.footerStartRow,
			});
		}
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
		process.stdout.write(encodeFramePatches([{ type: "move-cursor", cursor: next.frame.cursor }], next.frame.width));
		process.stdout.write(ansiShowCursor());
		this._renderedFooterUi = next.footerUi;
		this._renderedFooterStartRow = next.footerStartRow;
		this._lastScreenFrame = next.frame;
	}

	private prepareRenderDebugRecord(record: {
		readonly resetScrollRegion: boolean;
		readonly footerStartRow: number;
		readonly pinFooterToBottom: boolean;
		readonly footerLineCount: number;
		readonly transcriptViewportLineCount: number;
		readonly frame: ReturnType<typeof summarizeScreenFrame>;
		readonly patches: ReturnType<typeof summarizeFramePatches>;
	}):
		| (typeof record & {
				readonly suppressedSinceLast?: number;
		  })
		| null {
		if (record.resetScrollRegion) {
			const next = {
				...record,
				...(this._suppressedRenderDebugCount > 0 ? { suppressedSinceLast: this._suppressedRenderDebugCount } : {}),
			};
			this._suppressedRenderDebugCount = 0;
			this._lastRenderDebugKey = null;
			this._lastRenderDebugLoggedAt = Date.now();
			return next;
		}

		const key = JSON.stringify({
			footerStartRow: record.footerStartRow,
			pinFooterToBottom: record.pinFooterToBottom,
			footerLineCount: record.footerLineCount,
			transcriptViewportLineCount: record.transcriptViewportLineCount,
			nonEmptyRows: record.frame.nonEmptyRows,
			writeLineCount: record.patches.writeLineCount,
			clearLineCount: record.patches.clearLineCount,
			moveCursorCount: record.patches.moveCursorCount,
		});
		const now = Date.now();
		if (
			this._lastRenderDebugKey === key &&
			now - this._lastRenderDebugLoggedAt < RENDER_DEBUG_SAME_FRAME_THROTTLE_MS
		) {
			this._suppressedRenderDebugCount += 1;
			return null;
		}
		const next = {
			...record,
			...(this._suppressedRenderDebugCount > 0 ? { suppressedSinceLast: this._suppressedRenderDebugCount } : {}),
		};
		this._suppressedRenderDebugCount = 0;
		this._lastRenderDebugKey = key;
		this._lastRenderDebugLoggedAt = now;
		return next;
	}

	private buildInteractiveScreenFrame(): {
		readonly frame: ScreenFrame;
		readonly footerUi: InteractiveFooterRenderResult;
		readonly footerStartRow: number;
		readonly pinFooterToBottom: boolean;
	} {
		const terminalWidth = this.terminalWidth();
		const terminalHeight = this.terminalHeight();
		if (this.resumeBrowserState() !== null) {
			return this.buildResumeBrowserScreenFrame(terminalWidth, terminalHeight);
		}
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
					: fitTerminalLineFromTuiCore(visibleLine, terminalWidth)
				: renderSelectedPlainLine(
						plainLine,
						selectionColumns.startColumn,
						selectionColumns.endColumn,
						terminalWidth,
					);
		});

		const composed = composeScreenWithFooter({
			width: terminalWidth,
			height: terminalHeight,
			bodyLines,
			footer: {
				lines: footerUi.lines.map((line: string) => fitTerminalLineFromTuiCore(line ?? "", terminalWidth)),
				cursorLineIndex: footerUi.cursorLineIndex,
				cursorColumn: footerUi.cursorColumn,
			},
		});

		return materializeInteractiveScreenFrame(composed, footerUi, terminalWidth);
	}

	private buildResumeBrowserScreenFrame(
		terminalWidth: number,
		terminalHeight: number,
	): {
		readonly frame: ScreenFrame;
		readonly footerUi: InteractiveFooterRenderResult;
		readonly footerStartRow: number;
		readonly pinFooterToBottom: boolean;
	} {
		const footerUi = this.buildResumeBrowserFooterUi();
		const headerLines = this.currentResumeBrowserTopLines();
		const topHeight = Math.min(headerLines.length, Math.max(0, terminalHeight - footerUi.lines.length));
		const topVisibleLines = headerLines
			.slice(0, topHeight)
			.map((line) => fitTerminalLineFromTuiCore(line, terminalWidth));
		const availableBodyRows = Math.max(0, terminalHeight - topVisibleLines.length - footerUi.lines.length);
		const totalBodyRows = this.currentResumeBrowserBodyDisplayRows();
		const maxTopOffset = Math.max(0, totalBodyRows - availableBodyRows);
		const topOffset = Math.max(0, Math.min(this._resumeBrowserScrollOffset, maxTopOffset));
		const bodyVisibleLines = computeVisibleTranscriptLines(
			this.currentResumeBrowserBodyBlocks(),
			terminalWidth,
			availableBodyRows,
			Math.max(0, maxTopOffset - topOffset),
			0,
		).map((line) => fitTerminalLineFromTuiCore(line, terminalWidth));
		this._renderedTranscriptViewportLines = bodyVisibleLines.map((line) => stripAnsiWelcome(line));
		const footerStartRow = Math.max(1, terminalHeight - footerUi.lines.length + 1);
		const screenLines = Array.from({ length: terminalHeight }, () => "");
		for (const [index, line] of topVisibleLines.entries()) {
			screenLines[index] = line;
		}
		for (const [index, line] of bodyVisibleLines.entries()) {
			const row = topVisibleLines.length + index;
			if (row >= footerStartRow - 1) {
				break;
			}
			screenLines[row] = line;
		}
		for (const [index, line] of footerUi.lines.entries()) {
			const row = footerStartRow - 1 + index;
			if (row >= 0 && row < screenLines.length) {
				screenLines[row] = fitTerminalLineFromTuiCore(line ?? "", terminalWidth);
			}
		}
		return {
			frame: createScreenFrame({
				width: terminalWidth,
				height: terminalHeight,
				lines: screenLines,
				cursor: {
					row: footerStartRow + footerUi.cursorLineIndex,
					column: computeFooterCursorColumnFromTuiCore(terminalWidth, footerUi.cursorColumn),
				},
			}),
			footerUi: { ...footerUi, renderedWidth: terminalWidth },
			footerStartRow,
			pinFooterToBottom: true,
		};
	}

	private selectionColumnsForRow(row: number): { startColumn: number; endColumn: number } | null {
		return computeSelectionColumnsForRow(this.currentSelectionRange(), row, this.terminalWidth());
	}

	private currentSelectionRange(): TerminalSelectionRange | null {
		if (this.resumeBrowserState() !== null) {
			return null;
		}
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
		return computeTranscriptDisplayRowsFromTuiCore(
			this.currentRenderedTranscriptBlocks(),
			this.terminalWidth(),
			this.currentWelcomeLineCount(),
		);
	}

	private currentRenderedTranscriptBlocks(): readonly string[] {
		const browser = this.resumeBrowserState();
		if (browser !== null) {
			return formatResumeBrowserTranscriptBlocks(browser);
		}
		return this._conversation.renderedTranscriptBlocks(this._welcomeLines);
	}

	private currentWelcomeLineCount(): number {
		return this.resumeBrowserState() === null ? this._welcomeLines.length : 0;
	}
}

// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------

class PrintModeHandler implements ModeHandler {
	async start(runtime: AppRuntime): Promise<void> {
		const sessionEngine = runtime.createSessionEngine();
		const session = sessionEngine.createSession();

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
				await sessionEngine.submit(line.trim(), { sessionId: session.id.value, mode: "prompt" });
			}
		} finally {
			inputLoop.close();
			await sessionEngine.closeAllSessions();
			sessionEngine.dispose();
		}
	}
}

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

class JsonModeHandler implements ModeHandler {
	async start(runtime: AppRuntime): Promise<void> {
		const sessionEngine = runtime.createSessionEngine();
		const session = sessionEngine.createSession();

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
				await sessionEngine.submit(line.trim(), { sessionId: session.id.value, mode: "prompt" });
			}
		} finally {
			inputLoop.close();
			await sessionEngine.closeAllSessions();
			sessionEngine.dispose();
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
	const [status, diffStat] = await Promise.all([
		runGit(cwd, ["status", "--porcelain"]),
		runGit(cwd, ["diff", "--stat"]),
	]);
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

function readGitDiff(
	cwd: string,
	target: string | null,
): Promise<{ type: "ok"; stdout: string; stderr: string } | { type: "error" }> {
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
	provider?: string;
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
	const modelLine = input.provider
		? `${CYAN}${input.model}${RESET} ${DIM}via${RESET} ${input.provider}`
		: `${CYAN}${input.model}${RESET}`;
	return [
		formatWelcomeTopBorder(width, input.version),
		fill(),
		center(`${BOLD}${input.greeting}${RESET}`),
		fill(),
		center(`${DIM}        ${GREEN}✦${RESET}        ${RESET}`),
		center(`${CYAN}      ──╂──      ${RESET}`),
		center(`${DIM}        ${CYAN}│${RESET}        ${RESET}`),
		fill(),
		center(modelLine),
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
	const leadingLines = buildInteractiveFooterLeadingLinesFromUi({
		...state,
		truncateText: truncatePlainTerminalText,
	});
	if (state.permission !== null) {
		const prompt = "choice [Enter/1/2/3]> ";
		const layout = composePromptBlock({
			leadingLines,
			separator,
			bodyLines: formatInteractivePermissionBodyLines(state.permission.details, state.permission.selectedIndex),
			prompt,
			buffer: state.buffer,
			cursor: state.cursor,
		});
		return materializeComposerBlock(layout, state.terminalWidth);
	}
	const hint = formatSlashSuggestionHint(
		state.suggestions,
		state.terminalWidth - computePromptCursorColumnFromTuiCore(state.prompt, state.buffer, state.buffer.length),
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

function shouldPersistRecentSessionForEvent(event: RuntimeEvent): boolean {
	switch (event.category) {
		case "compaction":
			return event.type === "compaction_completed";
		case "session":
			return event.type === "session_resumed";
		default:
			return false;
	}
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

function ansiShowCursor(): string {
	return "\x1b[?25h";
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

function truncatePlainTerminalText(text: string, width: number): string {
	return truncatePlainTextFromTuiCore(text, width);
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
		wrapLine: wrapTranscriptContentFromTuiCore,
	});
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

function isTranscriptUserBlock(block: string): boolean {
	return block.startsWith(`${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg} `);
}
