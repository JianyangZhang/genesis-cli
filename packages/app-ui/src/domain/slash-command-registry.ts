/**
 * Slash command registry — registration, lookup, and input parsing.
 *
 * Commands are registered with a SlashCommand descriptor and resolved
 * from raw user input (e.g. "/model sonnet" → command "model" + args "sonnet").
 */

import type { SlashCommand } from "../types/index.js";

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

export type SlashCommandResolution =
	| { readonly type: "command"; readonly command: SlashCommand; readonly args: string }
	| { readonly type: "not_found"; readonly name: string };

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface SlashCommandRegistry {
	/** Register a command. Overwrites if a command with the same name exists. */
	register(command: SlashCommand): void;

	/** Look up a command by name (without the leading `/`). */
	get(name: string): SlashCommand | undefined;

	/** List all registered commands. */
	listAll(): readonly SlashCommand[];

	/**
	 * Resolve raw user input to a command.
	 * Returns `null` if the input does not start with `/`.
	 * Returns `{ type: "not_found" }` if the command name is unknown.
	 */
	resolve(input: string): SlashCommandResolution | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSlashCommandRegistry(): SlashCommandRegistry {
	const commands = new Map<string, SlashCommand>();

	return {
		register(command: SlashCommand): void {
			commands.set(command.name, command);
		},

		get(name: string): SlashCommand | undefined {
			return commands.get(name);
		},

		listAll(): readonly SlashCommand[] {
			return [...commands.values()];
		},

		resolve(input: string): SlashCommandResolution | null {
			const trimmed = input.trimStart();
			if (!trimmed.startsWith("/")) return null;

			// Strip the leading "/"
			const body = trimmed.slice(1);
			if (body.length === 0) return null;

			// Split into name and remaining args text
			const spaceIdx = body.indexOf(" ");
			const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
			const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trimStart();

			const command = commands.get(name);
			if (!command) {
				return { type: "not_found", name };
			}

			return { type: "command", command, args };
		},
	};
}
