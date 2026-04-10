import { createBuiltinCommands } from "./builtin-commands.js";
import { createInteractiveLocalCommands, type InteractiveLocalCommandDeps } from "./interactive-local-commands.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";
import { createSlashCommandRegistry } from "./slash-command-registry.js";

export function createBuiltinCommandRegistry(): SlashCommandRegistry {
	const registry = createSlashCommandRegistry();
	for (const command of createBuiltinCommands()) {
		registry.register(command);
	}
	return registry;
}

export function createInteractiveCommandRegistry(
	deps: Omit<InteractiveLocalCommandDeps, "registry">,
): SlashCommandRegistry {
	const registry = createBuiltinCommandRegistry();
	for (const command of createInteractiveLocalCommands({ ...deps, registry })) {
		registry.register(command);
	}
	return registry;
}
