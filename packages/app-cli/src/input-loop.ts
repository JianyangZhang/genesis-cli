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
	/** Enable raw-mode line editing when TTY is available. Defaults to false. */
	readonly rawMode?: boolean;
	/** Called whenever the current input state changes (rawMode only). */
	readonly onInputStateChange?: (state: { buffer: string; cursor: number }) => void;
	/** Called for special keys (rawMode only). */
	readonly onKey?: (
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
			| "ctrlc"
			| "ctrlo",
	) => void;
	/** Called when Tab is pressed in rawMode; may replace the current buffer. */
	readonly onTabComplete?: (state: { buffer: string; cursor: number }) => { buffer: string; cursor: number } | null;
	/** Called for terminal focus changes (rawMode only). */
	readonly onTerminalEvent?: (event: "focusin" | "focusout") => void;
	/** Called for mouse button events (rawMode only). */
	readonly onMouse?: (event: {
		kind: "leftdown" | "leftdrag" | "leftup";
		row: number;
		column: number;
	}) => void;
	/** Whether pressing Enter should emit a terminal newline in raw mode. Defaults to true. */
	readonly submitNewline?: boolean;
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
	const { prompt = "> ", input = process.stdin, output = process.stdout, rawMode = false } = options;

	if (rawMode && isTtyReadable(input) && isTtyWritable(output)) {
		return createRawInputLoop({
			prompt,
			input,
			output,
			onInputStateChange: options.onInputStateChange,
			onKey: options.onKey,
			onTabComplete: options.onTabComplete,
			onTerminalEvent: options.onTerminalEvent,
			onMouse: options.onMouse,
			submitNewline: options.submitNewline,
		});
	}

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

function createRawInputLoop(options: {
	readonly prompt: string;
	readonly input: NodeJS.ReadableStream & {
		isTTY?: boolean;
		setRawMode?: (enabled: boolean) => void;
		resume(): void;
		pause?: () => void;
	};
	readonly output: NodeJS.WritableStream & { isTTY?: boolean };
	readonly onInputStateChange?: (state: { buffer: string; cursor: number }) => void;
	readonly onKey?: (
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
			| "ctrlc"
			| "ctrlo",
	) => void;
	readonly onTabComplete?: (state: { buffer: string; cursor: number }) => { buffer: string; cursor: number } | null;
	readonly onTerminalEvent?: (event: "focusin" | "focusout") => void;
	readonly onMouse?: (event: {
		kind: "leftdown" | "leftdrag" | "leftup";
		row: number;
		column: number;
	}) => void;
	readonly submitNewline?: boolean;
}): InputLoop {
	const {
		prompt,
		input,
		output,
		onInputStateChange,
		onKey,
		onTabComplete,
		onTerminalEvent,
		onMouse,
		submitNewline = true,
	} = options;
	const sgrMousePattern = new RegExp(`^${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

	let closed = false;
	let buffer = "";
	let cursor = 0;
	let pendingResolve: ((value: string | null) => void) | null = null;
	let escapeBuffer = "";
	let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

	const emitState = (): void => {
		onInputStateChange?.({ buffer, cursor });
	};

	const setState = (next: { buffer: string; cursor: number }): void => {
		buffer = next.buffer;
		cursor = Math.max(0, Math.min(next.cursor, buffer.length));
		emitState();
	};

	const flushPrompt = (): void => {
		output.write(prompt);
		if (buffer.length > 0) {
			output.write(buffer);
		}
	};

	const insertText = (text: string): void => {
		const next = `${buffer.slice(0, cursor)}${text}${buffer.slice(cursor)}`;
		setState({ buffer: next, cursor: cursor + text.length });
	};

	const backspace = (): void => {
		if (cursor <= 0) return;
		const next = `${buffer.slice(0, cursor - 1)}${buffer.slice(cursor)}`;
		setState({ buffer: next, cursor: cursor - 1 });
	};

	const moveCursor = (delta: number): void => {
		setState({ buffer, cursor: cursor + delta });
	};

	const setCursor = (next: number): void => {
		setState({ buffer, cursor: next });
	};

	const clearBuffer = (): void => {
		setState({ buffer: "", cursor: 0 });
	};

	const handleEscapeSequence = (seq: string): void => {
		if (seq === "\u001b[A") {
			onKey?.("up");
			return;
		}
		if (seq === "\u001b[B") {
			onKey?.("down");
			return;
		}
		if (seq === "\u001b[D") {
			moveCursor(-1);
			return;
		}
		if (seq === "\u001b[C") {
			moveCursor(1);
			return;
		}
		if (seq === "\u001b[H" || seq === "\u001b[1~") {
			setCursor(0);
			return;
		}
		if (seq === "\u001b[F" || seq === "\u001b[4~") {
			setCursor(buffer.length);
			return;
		}
		if (seq === "\u001b[5~") {
			onKey?.("pageup");
			return;
		}
		if (seq === "\u001b[6~") {
			onKey?.("pagedown");
			return;
		}
		if (seq === "\u001b[Z") {
			onKey?.("shifttab");
			return;
		}
		if (seq === "\u001b[I") {
			onTerminalEvent?.("focusin");
			return;
		}
		if (seq === "\u001b[O") {
			onTerminalEvent?.("focusout");
			return;
		}
		const sgrMouse = sgrMousePattern.exec(seq);
		if (sgrMouse) {
			const button = Number.parseInt(sgrMouse[1] ?? "", 10);
			const column = Number.parseInt(sgrMouse[2] ?? "", 10);
			const row = Number.parseInt(sgrMouse[3] ?? "", 10);
			const final = sgrMouse[4] ?? "M";
			if ((button & 0x43) === 0x40) {
				onKey?.("wheelup");
			} else if ((button & 0x43) === 0x41) {
				onKey?.("wheeldown");
			} else if (Number.isFinite(column) && Number.isFinite(row)) {
				const baseButton = button & 0x03;
				const isMotion = (button & 0x20) !== 0;
				if (final === "m" && baseButton === 0) {
					onMouse?.({ kind: "leftup", row, column });
				} else if (isMotion && baseButton === 0) {
					onMouse?.({ kind: "leftdrag", row, column });
				} else if (!isMotion && final === "M" && baseButton === 0) {
					onMouse?.({ kind: "leftdown", row, column });
				}
			}
			return;
		}
		if (seq.length === 6 && seq.startsWith("\u001b[M")) {
			const button = seq.charCodeAt(3) - 32;
			if ((button & 0x43) === 0x40) {
				onKey?.("wheelup");
			} else if ((button & 0x43) === 0x41) {
				onKey?.("wheeldown");
			}
			return;
		}
		if (seq === "\u001b[3~") {
			if (cursor >= buffer.length) return;
			const next = `${buffer.slice(0, cursor)}${buffer.slice(cursor + 1)}`;
			setState({ buffer: next, cursor });
			return;
		}
	};

	const onData = (chunk: Buffer): void => {
		if (closed) return;

		const str = chunk.toString("utf8");
		for (const ch of str) {
			if (escapeBuffer.length > 0) {
				escapeBuffer += ch;
				if (isEscapeSequenceComplete(escapeBuffer)) {
					handleEscapeSequence(escapeBuffer);
					escapeBuffer = "";
				}
				continue;
			}

			const code = ch.charCodeAt(0);
			if (code === 3) {
				if (onKey) {
					onKey("ctrlc");
					clearBuffer();
					return;
				}
				close();
				return;
			}
			if (code === 9) {
				const nextState = onTabComplete?.({ buffer, cursor });
				if (nextState) {
					setState(nextState);
				} else {
					onKey?.("tab");
				}
				continue;
			}
			if (code === 15) {
				onKey?.("ctrlo");
				continue;
			}
			if (code === 27) {
				escapeBuffer = ch;
				if (escapeTimeout) {
					clearTimeout(escapeTimeout);
				}
				escapeTimeout = setTimeout(() => {
					if (escapeBuffer === "\u001b") {
						escapeBuffer = "";
						onKey?.("esc");
						clearBuffer();
					}
				}, 25);
				continue;
			}
			if (ch === "\r" || ch === "\n") {
				if (pendingResolve) {
					const resolve = pendingResolve;
					pendingResolve = null;
					const line = buffer;
					clearBuffer();
					if (submitNewline) {
						output.write("\n");
					}
					resolve(line);
				}
				continue;
			}
			if (code === 127) {
				backspace();
				continue;
			}
			if (code >= 32) {
				insertText(ch);
			}
		}
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (pendingResolve) {
			const resolve = pendingResolve;
			pendingResolve = null;
			resolve(null);
		}
		try {
			input.setRawMode?.(false);
		} catch {}
		try {
			input.pause?.();
		} catch {}
		if (escapeTimeout) {
			clearTimeout(escapeTimeout);
			escapeTimeout = null;
		}
		input.off("data", onData);
	};

	input.setRawMode?.(true);
	input.resume();
	input.on("data", onData);

	return {
		nextLine(): Promise<string | null> {
			if (closed) return Promise.resolve(null);
			if (pendingResolve) return Promise.resolve(null);
			return new Promise<string | null>((resolve) => {
				pendingResolve = resolve;
				emitState();
				flushPrompt();
			});
		},
		close,
	};
}

function isTtyReadable(stream: NodeJS.ReadableStream): stream is NodeJS.ReadableStream & { isTTY: boolean } {
	return Boolean((stream as { isTTY?: boolean }).isTTY);
}

function isTtyWritable(stream: NodeJS.WritableStream): stream is NodeJS.WritableStream & { isTTY: boolean } {
	return Boolean((stream as { isTTY?: boolean }).isTTY);
}

function isEscapeSequenceComplete(sequence: string): boolean {
	if (sequence === "\u001b") {
		return false;
	}
	return new RegExp(`${String.fromCharCode(27)}\\[[0-9;<?]*[ -/]*[@-~]$`).test(sequence);
}
