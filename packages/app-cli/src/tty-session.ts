import { spawnSync } from "node:child_process";
import {
	ansiDisableMouseTracking,
	ansiEnableMouseTracking,
	ansiEnterAlternateScreen,
	ansiExitAlternateScreen,
	ansiHideCursor,
	ansiShowCursor,
} from "@genesis-cli/ui";

type TtyInput = NodeJS.ReadableStream & {
	isTTY?: boolean;
	setRawMode?: (enabled: boolean) => void;
	pause?: () => void;
};

type TtyOutput = NodeJS.WritableStream & {
	isTTY?: boolean;
	write(chunk: string): boolean;
};

interface TtySessionOptions {
	readonly input?: TtyInput;
	readonly output?: TtyOutput;
	readonly restoreTermios?: () => void;
}

export interface TtySession {
	enter(): void;
	restore(): void;
}

export function createTtySession(options: TtySessionOptions = {}): TtySession {
	const input = options.input ?? (process.stdin as TtyInput);
	const output = options.output ?? (process.stdout as TtyOutput);
	const restoreTermios = options.restoreTermios ?? defaultRestoreTermios;
	let active = false;
	let restored = false;

	const signalHandlers = new Map<NodeJS.Signals, () => void>();

	const removeSignalHandlers = (): void => {
		for (const [signal, listener] of signalHandlers) {
			process.off(signal, listener);
		}
		signalHandlers.clear();
	};

	return {
		enter(): void {
			if (active || restored) {
				return;
			}
			active = true;
			output.write(ansiEnterAlternateScreen());
			output.write(ansiEnableMouseTracking());
			output.write(ansiHideCursor());

			for (const signal of ["SIGINT", "SIGTERM"] as const) {
				const listener = () => {
					this.restore();
				};
				signalHandlers.set(signal, listener);
				process.once(signal, listener);
			}
		},

		restore(): void {
			if (restored) {
				return;
			}
			restored = true;
			active = false;
			removeSignalHandlers();
			try {
				input.setRawMode?.(false);
			} catch {}
			try {
				input.pause?.();
			} catch {}
			try {
				output.write(ansiShowCursor());
				output.write(ansiDisableMouseTracking());
				output.write(ansiExitAlternateScreen());
			} catch {}
			try {
				restoreTermios();
			} catch {}
		},
	};
}

function defaultRestoreTermios(): void {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return;
	}
	spawnSync("stty", ["sane"], {
		stdio: ["inherit", "ignore", "ignore"],
	});
}
