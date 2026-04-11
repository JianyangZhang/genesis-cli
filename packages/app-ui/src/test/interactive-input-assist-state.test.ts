import type { SlashCommand } from "../types/index.js";
import { describe, expect, it } from "vitest";
import {
	acceptFirstSlashSuggestion,
	computeSlashSuggestions,
	formatSlashSuggestionHint,
	initialInteractiveInputAssistState,
	updateSlashCommandSuggestions,
} from "../services/interactive-input-assist-state.js";

describe("interactive input assist state", () => {
	const commands: readonly SlashCommand[] = [
		{ name: "help", description: "", type: "local" },
		{ name: "review", description: "", type: "local" },
		{ name: "status", description: "", type: "local" },
		{ name: "resume", description: "", type: "local" },
	];

	it("suggests commands when the user types a slash prefix", () => {
		expect(computeSlashSuggestions("/", commands)).toEqual(["help", "resume", "review", "status"]);
		expect(computeSlashSuggestions("/st", commands)).toEqual(["status"]);
	});

	it("does not suggest commands after arguments begin", () => {
		expect(computeSlashSuggestions("/status now", commands)).toEqual([]);
	});

	it("formats a dim inline hint for matching commands", () => {
		const hint = formatSlashSuggestionHint(["help", "status"], 30);
		expect(hint).toContain("/help");
		expect(hint).toContain("/status");
	});

	it("accepts the first slash suggestion on tab", () => {
		expect(acceptFirstSlashSuggestion({ buffer: "/st", cursor: 3 }, ["status", "review"])).toEqual({
			buffer: "/status ",
			cursor: 8,
		});
	});

	it("does not accept a suggestion once arguments have started", () => {
		expect(acceptFirstSlashSuggestion({ buffer: "/status now", cursor: 11 }, ["status"])).toBeNull();
	});

	it("updates state suggestions from input", () => {
		const state = updateSlashCommandSuggestions(initialInteractiveInputAssistState(), "/re", commands);
		expect(state.commandSuggestions).toEqual(["resume", "review"]);
	});
});
