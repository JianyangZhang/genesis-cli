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
import type { InteractionState, OutputSink, SlashCommand, TuiScreenLayout } from "@genesis-cli/ui";
import {
	ansiClearBelow,
	ansiClearLine,
	ansiEnterAlternateScreen,
	ansiExitAlternateScreen,
	ansiHideCursor,
	ansiMoveRight,
	ansiMoveUp,
	ansiShowCursor,
	createBuiltinCommands,
	createLayoutAccumulator,
	createSlashCommandRegistry,
	eventToJsonEnvelope,
	formatEventAsText,
	initialInteractionState,
	reduceInteractionState,
	renderScreen,
} from "@genesis-cli/ui";
import type { InputLoop } from "./input-loop.js";
import { createInputLoop } from "./input-loop.js";
import type { RpcServer } from "./rpc-server.js";
import { createRpcServer } from "./rpc-server.js";
import { getSessionStoreDir, readLastSession, readRecentSessions, writeLastSession } from "./session-store.js";

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
// Output sink implementations
// ---------------------------------------------------------------------------

function createStdoutSink(): OutputSink {
	return {
		write(text: string): void {
			process.stdout.write(text);
		},
		writeLine(text: string): void {
			process.stdout.write(`${text}\n`);
		},
		writeError(text: string): void {
			process.stderr.write(`${text}\n`);
		},
	};
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

class InteractiveModeHandler implements ModeHandler {
	private _lastRenderedLines = 0;
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
	private _viewportOffsetFromBottom = 0;
	private _terminalRows = process.stdout.rows ?? 24;
	private readonly _history: string[] = [];
	private _historyIndex: number | null = null;
	private _suppressPersistOnce = false;
	private _lastError: string | null = null;
	private readonly _changedPaths = new Set<string>();

	async start(runtime: AppRuntime): Promise<void> {
		const handler = this;
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("Interactive mode requires a TTY. Use --mode print|json|rpc instead.");
		}

		const sessionRef: { current: SessionFacade } = { current: runtime.createSession() };
		const sink = createStdoutSink();

		// Slash command registry
		const registry = createSlashCommandRegistry();
		for (const cmd of createBuiltinCommands()) {
			registry.register(cmd);
		}

		// Layout accumulator for TUI
		const accumulator = createLayoutAccumulator(() => sessionRef.current.state);
		let interactionState: InteractionState = initialInteractionState();
		let sessionTitle: string | undefined;
		let exitRequested = false;
		let inputLoop: InputLoop | null = null;
		const onResize = (): void => {
			this._terminalRows = process.stdout.rows ?? 24;
			this.renderScreenUpdate(accumulator.snapshot());
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
			this._viewportOffsetFromBottom = 0;
			this._historyIndex = null;
			this._lastError = null;
			this._changedPaths.clear();
			sessionTitle = undefined;
			interactionState = initialInteractionState();
			accumulator.reset();

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

				accumulator.push(event);
				interactionState = reduceInteractionState(interactionState, event);

				if (interactionState.phase === "waiting_permission" && interactionState.activeToolCallId) {
					this._pendingPermissionCallId = interactionState.activeToolCallId;
				} else if (interactionState.phase !== "waiting_permission") {
					this._pendingPermissionCallId = null;
				}

				const snapshot = accumulator.snapshot();
				this.renderScreenUpdate(snapshot);
			});
		};

		const register = (command: SlashCommand): void => {
			registry.register(command);
		};

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
				const all = registry
					.listAll()
					.slice()
					.sort((a, b) => a.name.localeCompare(b.name));
				ctx.output.writeLine("Commands:");
				for (const cmd of all) {
					ctx.output.writeLine(`  /${cmd.name} — ${cmd.description}`);
				}
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
			async execute() {
				accumulator.reset();
				handler._viewportOffsetFromBottom = 0;
				handler.renderScreenUpdate(accumulator.snapshot());
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
				ctx.output.writeLine("Recent sessions:");
				for (const entry of recent) {
					const id = entry.recoveryData.sessionId.value;
					const model = entry.recoveryData.model.id;
					const title = entry.title ? ` — ${entry.title}` : "";
					ctx.output.writeLine(`  ${id} (${model})${title}`);
				}
				return undefined;
			},
		});

		register({
			name: "changes",
			description: "Show changed files and diff summary",
			type: "local",
			async execute(ctx) {
				const cwd = ctx.session.context.workingDirectory;
				if (handler._changedPaths.size > 0) {
					ctx.output.writeLine("Changed files (observed):");
					for (const path of [...handler._changedPaths].sort((a, b) => a.localeCompare(b))) {
						ctx.output.writeLine(`  ${path}`);
					}
				} else {
					ctx.output.writeLine("Changed files (observed): none");
				}

				const status = await runGit(cwd, ["status", "--porcelain"]);
				if (status.type === "ok") {
					ctx.output.writeLine("git status:");
					ctx.output.writeLine(status.stdout.trim().length > 0 ? status.stdout.trimEnd() : "  clean");
				}
				const stat = await runGit(cwd, ["diff", "--stat"]);
				if (stat.type === "ok" && stat.stdout.trim().length > 0) {
					ctx.output.writeLine("git diff --stat:");
					ctx.output.writeLine(stat.stdout.trimEnd());
				}
				if (status.type === "error" || stat.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
				}
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
				const args = target.length > 0 ? ["diff", "--", target] : ["diff"];
				const diff = await runGit(cwd, args);
				if (diff.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					return undefined;
				}
				ctx.output.writeLine(diff.stdout.trimEnd().length > 0 ? diff.stdout.trimEnd() : "(no diff)");
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
					return undefined;
				}
				const result = await runGit(cwd, ["checkout", "--", arg]);
				if (result.type === "error") {
					ctx.output.writeError("git not available in this working directory.");
					return undefined;
				}
				handler._changedPaths.delete(arg);
				ctx.output.writeLine(`Reverted: ${arg}`);
				return undefined;
			},
		});

		register({
			name: "review",
			description: "Review changes and decide to keep or revert",
			type: "local",
			async execute(ctx) {
				await registry.get("changes")!.execute?.(ctx);
				ctx.output.writeLine("Next: /diff [file] to inspect, /revert <file> to undo, or continue chatting.");
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
				const data =
					selector.length === 0
						? await readLastSession(dir)
						: ((await readRecentSessions(dir)).find((entry) => entry.recoveryData.sessionId.value === selector)
								?.recoveryData ?? null);

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
				handler.renderScreenUpdate(accumulator.snapshot());
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
				const snapshot = accumulator.snapshot();
				this.handleSpecialKey(key, snapshot);
			},
		});

		process.stdout.write(ansiEnterAlternateScreen());
		this.renderWelcome(sessionRef.current);
		this.renderScreenUpdate(accumulator.snapshot());

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
					sink.writeError(`Unknown command: /${resolution.name}`);
					line = await inputLoop.nextLine();
					continue;
				}

				// Regular prompt
				if (this._activeTurn !== null) {
					sink.writeError("Session is busy. Wait for the active turn or answer the permission prompt.");
					line = await inputLoop.nextLine();
					continue;
				}
				this.rememberHistory(trimmed);
				this._activeTurn = sessionRef.current
					.prompt(trimmed)
					.catch((err) => {
						sink.writeError(`Error: ${err}`);
					})
					.finally(() => {
						this._activeTurn = null;
					});

				line = await inputLoop.nextLine();
			}
		} finally {
			process.stdout.off("resize", onResize);
			inputLoop.close();
			process.stdout.write(ansiShowCursor());
			process.stdout.write(ansiExitAlternateScreen());
			sessionRef.current.events.removeAllListeners();
			await sessionRef.current.close();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		const model = session.state.model.displayName ?? session.state.model.id;
		process.stdout.write(ansiHideCursor());
		process.stdout.write(ansiClearBelow());
		process.stdout.write(`Genesis CLI — model: ${model}\n`);
		process.stdout.write("Type /help for commands, or start chatting.\n");
	}

	private renderScreenUpdate(snapshot: TuiScreenLayout): void {
		const width = process.stdout.columns ?? 80;
		if (this._lastRenderedLines > 0) {
			process.stdout.write(ansiMoveUp(this._lastRenderedLines));
		}
		process.stdout.write(ansiClearBelow());
		const rendered = renderScreen(this.applyViewport(snapshot), width);
		process.stdout.write(ansiHideCursor());
		process.stdout.write(`${rendered}\n`);
		this._lastRenderedLines = rendered.split("\n").length + 1;
		this.renderPromptLine();
	}

	private applyViewport(snapshot: TuiScreenLayout): TuiScreenLayout {
		const maxConversationLines = Math.max(0, this._terminalRows - 3);
		const lines = snapshot.conversation.lines;
		if (lines.length <= maxConversationLines) {
			return snapshot;
		}
		const maxOffset = Math.max(0, lines.length - maxConversationLines);
		const offset = Math.max(0, Math.min(this._viewportOffsetFromBottom, maxOffset));
		const start = Math.max(0, lines.length - maxConversationLines - offset);
		const end = Math.min(lines.length, start + maxConversationLines);
		return {
			...snapshot,
			conversation: {
				...snapshot.conversation,
				lines: lines.slice(start, end),
			},
		};
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
		process.stdout.write(ansiMoveRight(prompt.length + this._inputState.cursor));
		process.stdout.write(ansiShowCursor());
	}

	private handleSpecialKey(
		key: "up" | "down" | "pageup" | "pagedown" | "home" | "end" | "esc",
		snapshot: TuiScreenLayout,
	): void {
		const maxConversationLines = Math.max(0, this._terminalRows - 3);
		const maxOffset = Math.max(0, snapshot.conversation.lines.length - maxConversationLines);

		if (key === "up" || key === "down") {
			if (this._inputState.buffer.length > 0 || this._history.length > 0) {
				this.navigateHistory(key === "up" ? -1 : 1);
				return;
			}
		}
		if (this._inputState.buffer.length > 0) {
			return;
		}
		if (key === "up") {
			this._viewportOffsetFromBottom = Math.min(maxOffset, this._viewportOffsetFromBottom + 1);
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "down") {
			this._viewportOffsetFromBottom = Math.max(0, this._viewportOffsetFromBottom - 1);
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "pageup") {
			this._viewportOffsetFromBottom = Math.min(
				maxOffset,
				this._viewportOffsetFromBottom + Math.max(1, Math.floor(maxConversationLines / 2)),
			);
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "pagedown") {
			this._viewportOffsetFromBottom = Math.max(
				0,
				this._viewportOffsetFromBottom - Math.max(1, Math.floor(maxConversationLines / 2)),
			);
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "end") {
			this._viewportOffsetFromBottom = 0;
			this.renderScreenUpdate(snapshot);
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
