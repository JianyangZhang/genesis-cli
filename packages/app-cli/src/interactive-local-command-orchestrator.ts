import type { AppRuntime, SessionFacade } from "@pickle-pee/runtime";
import type { OutputSink, SlashCommandHost, SlashCommandResolution } from "@pickle-pee/ui";

export interface ExecuteInteractiveSlashCommandArgs {
	readonly resolution: Extract<SlashCommandResolution, { readonly type: "command" }>;
	readonly runtime: AppRuntime;
	readonly session: SessionFacade;
	readonly output: OutputSink;
	readonly host: SlashCommandHost;
	readonly isInteractionBusy: () => boolean;
	readonly runLocalBusyCommand: (command: Promise<void>) => void;
	readonly onError: (error: unknown) => void;
}

export async function executeInteractiveSlashCommand(
	args: ExecuteInteractiveSlashCommandArgs,
): Promise<{ readonly handled: true }> {
	if (args.isInteractionBusy()) {
		args.output.writeError("Session is busy.");
		return { handled: true };
	}

	const executeCommand = async (): Promise<void> => {
		await args.resolution.command.execute?.({
			args: args.resolution.args,
			runtime: args.runtime,
			session: args.session,
			output: args.output,
			host: args.host,
		});
	};

	try {
		if (args.resolution.command.name === "compact") {
			args.runLocalBusyCommand(executeCommand());
		} else {
			await executeCommand();
		}
	} catch (error) {
		args.onError(error);
	}

	return { handled: true };
}
