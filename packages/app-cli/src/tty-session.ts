import { spawnSync } from "node:child_process";
import {
	createInteractiveModePlan,
	type TerminalModePlan,
} from "@pickle-pee/tui-core";

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
	readonly onResume?: () => void;
	readonly modePlan?: TerminalModePlan;
}

export interface TtySession {
	enter(): void;
	refresh(options?: { readonly reenterAlternateScreen?: boolean }): void;
	restore(): void;
}

export function createTtySession(options: TtySessionOptions = {}): TtySession {
	const input = options.input ?? (process.stdin as TtyInput);
	const output = options.output ?? (process.stdout as TtyOutput);
	const restoreTermios = options.restoreTermios ?? defaultRestoreTermios;
	const onResume = options.onResume;
	const modePlan =
		options.modePlan ??
		createInteractiveModePlan({
			hostFamily: "native",
			alternateScreen: true,
			mouseTracking: true,
			focusReporting: true,
			bracketedPaste: false,
			synchronizedOutput: false,
			extendedKeys: false,
		});
	let active = false;
	let restored = false;

	const signalHandlers = new Map<NodeJS.Signals, () => void>();

	const removeSignalHandlers = (): void => {
		for (const [signal, listener] of signalHandlers) {
			process.off(signal, listener);
		}
		signalHandlers.clear();
	};

	const writeModeSequence = (sequence: string): void => {
		if (sequence.length > 0) {
			output.write(sequence);
		}
	};

	return {
		enter(): void {
			if (active || restored) {
				return;
			}
			active = true;
			writeModeSequence(modePlan.enter);

			for (const signal of ["SIGINT", "SIGTERM", "SIGCONT"] as const) {
				const listener = () => {
					if (signal === "SIGCONT") {
						this.refresh({ reenterAlternateScreen: true });
						onResume?.();
						return;
					}
					this.restore();
				};
				signalHandlers.set(signal, listener);
				if (signal === "SIGCONT") {
					process.on(signal, listener);
				} else {
					process.once(signal, listener);
				}
			}
		},

		refresh({ reenterAlternateScreen = false }: { readonly reenterAlternateScreen?: boolean } = {}): void {
			if (restored) {
				return;
			}
			active = true;
			try {
				input.resume?.();
			} catch {}
			try {
				input.setRawMode?.(true);
			} catch {}
			writeModeSequence(reenterAlternateScreen ? modePlan.reenter : modePlan.refresh);
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
				writeModeSequence(modePlan.exit);
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
