import type { AppRuntime, SessionFacade } from "@pickle-pee/runtime";
import type { OutputSink, SlashCommand, SlashCommandHost } from "@pickle-pee/ui";
import { describe, expect, it, vi } from "vitest";
import { executeInteractiveSlashCommand } from "../interactive-local-command-orchestrator.js";

function createOutput(): OutputSink {
	return {
		write: () => {},
		writeLine: () => {},
		writeError: () => {},
	};
}

describe("interactive local command orchestrator", () => {
	it("blocks slash command execution while interaction is busy", async () => {
		const output = createOutput();
		const writeError = vi.spyOn(output, "writeError");
		const execute = vi.fn();

		await executeInteractiveSlashCommand({
			resolution: {
				type: "command",
				command: { name: "status", description: "", type: "local", execute },
				args: "",
			},
			runtime: {} as AppRuntime,
			session: {} as SessionFacade,
			output,
			host: {} as SlashCommandHost,
			isInteractionBusy: () => true,
			runLocalBusyCommand: () => {
				throw new Error("should not run");
			},
			onError: () => {
				throw new Error("should not fail");
			},
		});

		expect(writeError).toHaveBeenCalledWith("Session is busy.");
		expect(execute).not.toHaveBeenCalled();
	});

	it("routes /compact through busy local command execution", async () => {
		const output = createOutput();
		const execute = vi.fn().mockResolvedValue(undefined);
		const runLocalBusyCommand = vi.fn(async (command: Promise<void>) => {
			await command;
		});

		await executeInteractiveSlashCommand({
			resolution: {
				type: "command",
				command: { name: "compact", description: "", type: "local", execute } satisfies SlashCommand,
				args: "",
			},
			runtime: {} as AppRuntime,
			session: {} as SessionFacade,
			output,
			host: {} as SlashCommandHost,
			isInteractionBusy: () => false,
			runLocalBusyCommand,
			onError: () => {
				throw new Error("should not fail");
			},
		});

		expect(runLocalBusyCommand).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
