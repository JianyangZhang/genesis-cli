// domain/ — Output models, interaction state, slash commands.
export type {
	OutputMode,
	OutputSink,
	RenderContext,
	SlashCommand,
	SlashCommandContext,
	SlashCommandResult,
	SlashCommandType,
} from "../types/index.js";
export { createBuiltinCommands } from "./builtin-commands.js";
export type { InteractiveLocalCommandDeps } from "./interactive-local-commands.js";
export { createInteractiveLocalCommands, renderWorkingTreeSummary } from "./interactive-local-commands.js";
export type { SlashCommandRegistry, SlashCommandResolution } from "./slash-command-registry.js";
export { createSlashCommandRegistry } from "./slash-command-registry.js";
