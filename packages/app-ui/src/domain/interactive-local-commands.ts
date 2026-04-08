import type { SlashCommand, SlashCommandContext } from "../types/index.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";

export interface InteractiveLocalCommandDeps {
	readonly registry: SlashCommandRegistry;
	readonly setSessionTitle: (title: string) => void;
	readonly requestExit: () => void;
}

export function createInteractiveLocalCommands(deps: InteractiveLocalCommandDeps): SlashCommand[] {
	return [
		createTitleCommand(deps),
		createHelpCommand(deps.registry),
		createExitCommand("exit", "Exit the interactive session", deps),
		createExitCommand("quit", "Exit the interactive session (alias of /exit)", deps),
	];
}

function createTitleCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "title",
		description: "Set the current session title",
		type: "local",
		visibility: "internal",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const next = ctx.args.trim();
			if (next.length === 0) {
				ctx.output.writeError("Usage: /title <text>");
				return undefined;
			}
			deps.setSessionTitle(next);
			ctx.output.writeLine(`Title: ${next}`);
			return undefined;
		},
	};
}

function createHelpCommand(registry: SlashCommandRegistry): SlashCommand {
	return {
		name: "help",
		description: "Show available commands",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const query = ctx.args.trim().replace(/^\/+/, "");
			const all = registry.listPublic().slice();

			if (query.length > 0) {
				const cmd = all.find((command) => command.name === query) ?? null;
				if (!cmd) {
					ctx.output.writeError(`Unknown command: /${query}`);
					ctx.output.writeLine("Type /help to see all commands.");
					return undefined;
				}
				ctx.output.writeLine(`/${cmd.name}`);
				ctx.output.writeLine(`  ${cmd.description}`);
				ctx.output.writeLine(`  Type: ${cmd.type}`);
				return undefined;
			}

			ctx.output.writeLine("Commands:");
			renderHelpGroup(ctx, "Local", registry.listByType("local", "public"));
			renderHelpGroup(ctx, "Prompt", registry.listByType("prompt", "public"));
			renderHelpGroup(ctx, "UI", registry.listByType("ui", "public"));

			ctx.output.writeLine("\nTips:");
			ctx.output.writeLine("  /help <name>  Show details for a command");
			ctx.output.writeLine("  Ctrl+C        Abort the current turn (or exit if idle)");
			return undefined;
		},
	};
}

function createExitCommand(
	name: "exit" | "quit",
	description: string,
	deps: InteractiveLocalCommandDeps,
): SlashCommand {
	return {
		name,
		description,
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			deps.requestExit();
			ctx.output.writeLine("Bye.");
			return undefined;
		},
	};
}

function renderHelpGroup(ctx: SlashCommandContext, label: string, commands: readonly SlashCommand[]): void {
	const sorted = commands.slice().sort((a, b) => a.name.localeCompare(b.name));
	if (sorted.length === 0) {
		return;
	}
	ctx.output.writeLine(`\n${label} (${sorted.length}):`);
	for (const command of sorted) {
		ctx.output.writeLine(`  /${command.name} — ${command.description}`);
	}
}
