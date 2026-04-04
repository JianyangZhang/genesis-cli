/**
 * Input loop — async line reader wrapping Node.js readline.
 *
 * Provides a clean async interface for reading lines from a stream,
 * used by all mode handlers that accept user input.
 */

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InputLoopOptions {
	/** The prompt string displayed before each input. */
	readonly prompt?: string;
	/** Input stream. Defaults to process.stdin. */
	readonly input?: NodeJS.ReadableStream;
	/** Output stream for prompt display. Defaults to process.stdout. */
	readonly output?: NodeJS.WritableStream;
}

export interface InputLoop {
	/** Read the next line. Returns null on EOF or after close(). */
	nextLine(): Promise<string | null>;
	/** Close the readline interface and release resources. */
	close(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInputLoop(options: InputLoopOptions = {}): InputLoop {
	const { prompt = "> ", input = process.stdin, output = process.stdout } = options;

	let closed = false;
	const rl = readline.createInterface({
		input: input as NodeJS.ReadableStream,
		output: output as NodeJS.WritableStream,
		prompt,
		terminal: true,
	});

	// Pending line resolvers — only one active at a time.
	let pendingResolve: ((value: string | null) => void) | null = null;

	rl.on("line", (line: string) => {
		if (pendingResolve) {
			const resolve = pendingResolve;
			pendingResolve = null;
			resolve(line);
		}
	});

	rl.on("close", () => {
		if (pendingResolve) {
			const resolve = pendingResolve;
			pendingResolve = null;
			resolve(null);
		}
		closed = true;
	});

	return {
		nextLine(): Promise<string | null> {
			if (closed) return Promise.resolve(null);
			if (pendingResolve) {
				// Should not happen in normal usage; return null as safety.
				return Promise.resolve(null);
			}
			return new Promise<string | null>((resolve) => {
				pendingResolve = resolve;
				rl.prompt();
			});
		},

		close(): void {
			if (!closed) {
				closed = true;
				rl.close();
			}
		},
	};
}
