/**
 * Mode dispatch — four CLI mode handlers sharing the same AppRuntime.
 *
 * Each mode handler receives an identical AppRuntime and creates sessions
 * from it. Mode-specific behavior is isolated to how events are rendered.
 */

import type { AppRuntime, CliMode, RuntimeEvent, SessionFacade } from "@genesis-cli/runtime";
import type { InteractionState, OutputSink, TuiScreenLayout } from "@genesis-cli/ui";
import {
	ansiClearBelow,
	ansiClearLine,
	ansiEnterAlternateScreen,
	ansiExitAlternateScreen,
	ansiHideCursor,
	ansiMoveUp,
	ansiMoveRight,
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
	private _activeTurn: Promise<void> | null = null;
	private readonly _prompt = "genesis> ";
	private _inputState: { buffer: string; cursor: number } = { buffer: "", cursor: 0 };
	private _viewportOffsetFromBottom = 0;
	private _terminalRows = process.stdout.rows ?? 24;

	async start(runtime: AppRuntime): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("Interactive mode requires a TTY. Use --mode print|json|rpc instead.");
		}

		const session = runtime.createSession();
		const sink = createStdoutSink();

		// Slash command registry
		const registry = createSlashCommandRegistry();
		for (const cmd of createBuiltinCommands()) {
			registry.register(cmd);
		}

		// Layout accumulator for TUI
		const accumulator = createLayoutAccumulator(() => session.state);
		let interactionState: InteractionState = initialInteractionState();
		const onResize = (): void => {
			this._terminalRows = process.stdout.rows ?? 24;
			this.renderScreenUpdate(accumulator.snapshot());
		};
		process.stdout.on("resize", onResize);

		// Subscribe to session events
		session.events.onCategory("*", (event: RuntimeEvent) => {
			accumulator.push(event);
			interactionState = reduceInteractionState(interactionState, event);

			// Track pending permission requests
			if (interactionState.phase === "waiting_permission" && interactionState.activeToolCallId) {
				this._pendingPermissionCallId = interactionState.activeToolCallId;
			} else if (interactionState.phase !== "waiting_permission") {
				this._pendingPermissionCallId = null;
			}

			// Re-render full screen on each event
			const snapshot = accumulator.snapshot();
			this.renderScreenUpdate(snapshot);
		});

		// Input loop
		const inputLoop: InputLoop = createInputLoop({
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
		this.renderWelcome(session);
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
					const response = trimmed.toLowerCase();
					if (response === "y" || response === "yes") {
						await session.resolvePermission(this._pendingPermissionCallId, "allow_once");
					} else {
						await session.resolvePermission(this._pendingPermissionCallId, "deny");
					}
					this._pendingPermissionCallId = null;
					line = await inputLoop.nextLine();
					continue;
				}

				// Check for slash commands
				const resolution = registry.resolve(trimmed);
				if (resolution && resolution.type === "command") {
					await resolution.command.execute?.({
						args: resolution.args,
						runtime,
						session,
						output: sink,
					});
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
				this._activeTurn = session
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
			await session.close();
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
		process.stdout.write(this._prompt);
		if (buffer.length > 0) {
			process.stdout.write(buffer);
		}
		process.stdout.write("\r");
		process.stdout.write(ansiMoveRight(this._prompt.length + this._inputState.cursor));
		process.stdout.write(ansiShowCursor());
	}

	private handleSpecialKey(key: "up" | "down" | "pageup" | "pagedown" | "home" | "end" | "esc", snapshot: TuiScreenLayout): void {
		const maxConversationLines = Math.max(0, this._terminalRows - 3);
		const maxOffset = Math.max(0, snapshot.conversation.lines.length - maxConversationLines);

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
			this._viewportOffsetFromBottom = Math.min(maxOffset, this._viewportOffsetFromBottom + Math.max(1, Math.floor(maxConversationLines / 2)));
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "pagedown") {
			this._viewportOffsetFromBottom = Math.max(0, this._viewportOffsetFromBottom - Math.max(1, Math.floor(maxConversationLines / 2)));
			this.renderScreenUpdate(snapshot);
			return;
		}
		if (key === "end") {
			this._viewportOffsetFromBottom = 0;
			this.renderScreenUpdate(snapshot);
		}
	}
}

// ---------------------------------------------------------------------------
// Print mode
// ---------------------------------------------------------------------------

class PrintModeHandler implements ModeHandler {
	async start(runtime: AppRuntime): Promise<void> {
		const session = runtime.createSession();

		// Subscribe to events and format as text
		session.events.onCategory("*", (event: RuntimeEvent) => {
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
		session.events.onCategory("*", (event: RuntimeEvent) => {
			const envelope = eventToJsonEnvelope(event);
			process.stdout.write(`${JSON.stringify(envelope)}\n`);
		});

		// Also forward global events
		runtime.events.onCategory("*", (event: RuntimeEvent) => {
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
