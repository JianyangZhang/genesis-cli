/**
 * Mode dispatch — demonstrates how all 4 CLI modes share the same runtime.
 *
 * Each mode handler receives an identical AppRuntime and creates sessions
 * from it. Mode-specific behavior is isolated to how events are rendered.
 * Real implementations are P5 scope; this is a wiring skeleton.
 */

import type { AppRuntime, CliMode } from "@anthropic-ai/claude-code-pi-runtime";

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
// Stub implementations — P5 fills in real behavior
// ---------------------------------------------------------------------------

class InteractiveModeHandler implements ModeHandler {
	async start(_runtime: AppRuntime): Promise<void> {
		// P5: will launch TUI with streaming events, permission prompts, plan view
	}
}

class PrintModeHandler implements ModeHandler {
	async start(_runtime: AppRuntime): Promise<void> {
		// P5: will format output as plain text for stdout
	}
}

class JsonModeHandler implements ModeHandler {
	async start(_runtime: AppRuntime): Promise<void> {
		// P5: will emit structured JSON events to stdout
	}
}

class RpcModeHandler implements ModeHandler {
	async start(_runtime: AppRuntime): Promise<void> {
		// P5: will use stdin/stdout JSONL protocol for IDE embedding
	}
}
