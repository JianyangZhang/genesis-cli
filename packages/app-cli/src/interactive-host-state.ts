export interface InteractiveHostState {
	hasActiveLocalCommand(): boolean;
	reset(): void;
	runLocalBusyCommand(command: Promise<void>): void;
}

export interface InteractiveHostStateHooks {
	readonly onBusyLocalCommandFailed: (error: unknown) => void;
	readonly onBusyLocalCommandSettled: () => void;
}

export function createInteractiveHostState(hooks: InteractiveHostStateHooks): InteractiveHostState {
	let activeLocalCommand: Promise<void> | null = null;

	return {
		hasActiveLocalCommand(): boolean {
			return activeLocalCommand !== null;
		},

		reset(): void {
			activeLocalCommand = null;
		},

		runLocalBusyCommand(command: Promise<void>): void {
			activeLocalCommand = command
				.catch((error: unknown) => {
					hooks.onBusyLocalCommandFailed(error);
				})
				.finally(() => {
					activeLocalCommand = null;
					hooks.onBusyLocalCommandSettled();
				});
		},
	};
}
