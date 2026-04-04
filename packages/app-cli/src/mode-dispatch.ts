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
	ansiHideCursor,
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

	async start(runtime: AppRuntime): Promise<void> {
		const session = runtime.createSession();
		const sink = createStdoutSink();

		// Slash command registry
		const registry = createSlashCommandRegistry();
		for (const cmd of createBuiltinCommands()) {
			registry.register(cmd);
		}

		// Layout accumulator for TUI
		const accumulator = createLayoutAccumulator(session.state);
		let interactionState: InteractionState = initialInteractionState();

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
			prompt: "genesis> ",
		});

		process.stdout.write(ansiHideCursor());
		this.renderWelcome(session);

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
						session.resolvePermission(this._pendingPermissionCallId, "allow_once");
					} else {
						session.resolvePermission(this._pendingPermissionCallId, "deny");
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
				try {
					await session.prompt(trimmed);
				} catch (err) {
					sink.writeError(`Error: ${err}`);
				}

				line = await inputLoop.nextLine();
			}
		} finally {
			inputLoop.close();
			process.stdout.write(ansiShowCursor());
			await session.close();
		}
	}

	private renderWelcome(session: SessionFacade): void {
		const model = session.state.model.displayName ?? session.state.model.id;
		process.stdout.write(`\nGenesis CLI — model: ${model}\n`);
		process.stdout.write("Type /help for commands, or start chatting.\n\n");
	}

	private renderScreenUpdate(snapshot: TuiScreenLayout): void {
		const width = process.stdout.columns ?? 80;
		if (this._lastRenderedLines > 0) {
			process.stdout.write(ansiMoveUp(this._lastRenderedLines));
		}
		process.stdout.write(ansiClearBelow());
		const rendered = renderScreen(snapshot, width);
		process.stdout.write(`${rendered}\n`);
		this._lastRenderedLines = rendered.split("\n").length;
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
