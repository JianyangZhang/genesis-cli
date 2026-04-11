import type { InteractiveInputAssistState, SlashCommand } from "../types/index.js";

export function initialInteractiveInputAssistState(): InteractiveInputAssistState {
	return {
		commandSuggestions: [],
	};
}

export function resetInteractiveInputAssistState(): InteractiveInputAssistState {
	return initialInteractiveInputAssistState();
}

export function clearInteractiveInputAssistState(
	current: InteractiveInputAssistState,
): InteractiveInputAssistState {
	if (current.commandSuggestions.length === 0) {
		return current;
	}
	return {
		...current,
		commandSuggestions: [],
	};
}

export function updateSlashCommandSuggestions(
	current: InteractiveInputAssistState,
	input: string,
	commands: readonly SlashCommand[],
): InteractiveInputAssistState {
	return {
		...current,
		commandSuggestions: computeSlashSuggestions(input, commands),
	};
}

export function computeSlashSuggestions(input: string, commands: readonly SlashCommand[]): readonly string[] {
	const trimmed = input.trimStart();
	if (!trimmed.startsWith("/")) return [];
	const body = trimmed.slice(1);
	if (body.includes(" ")) return [];
	const query = body.toLowerCase();
	return commands
		.map((command) => command.name)
		.filter((name) => query.length === 0 || name.startsWith(query))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, 6);
}

export function formatSlashSuggestionHint(suggestions: readonly string[], remainingWidth: number): string {
	if (suggestions.length === 0 || remainingWidth < 6) return "";
	const DIM = "\x1b[2m";
	const RESET = "\x1b[0m";
	let hint = "";
	for (const name of suggestions) {
		const segment = `${hint.length === 0 ? "  " : "  "}/${name}`;
		if (segmentDisplayWidth(hint + segment) > remainingWidth) {
			break;
		}
		hint += segment;
	}
	return hint.length > 0 ? `${DIM}${hint}${RESET}` : "";
}

export function acceptFirstSlashSuggestion(
	state: { buffer: string; cursor: number },
	suggestions: readonly string[],
): { buffer: string; cursor: number } | null {
	if (suggestions.length === 0) return null;
	if (state.cursor !== state.buffer.length) return null;
	const trimmed = state.buffer.trimStart();
	if (!trimmed.startsWith("/")) return null;
	if (trimmed.includes(" ")) return null;
	const nextBuffer = `/${suggestions[0]} `;
	return { buffer: nextBuffer, cursor: nextBuffer.length };
}

function segmentDisplayWidth(text: string): number {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").length;
}
