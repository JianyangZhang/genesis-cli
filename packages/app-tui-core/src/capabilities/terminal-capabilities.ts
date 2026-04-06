import type { TerminalCapabilities, TerminalEnvironment, TerminalHostFamily } from "../types/index.js";

export function detectTerminalHostFamily(env: TerminalEnvironment): TerminalHostFamily {
	if (env.tmux) {
		return "tmux";
	}
	if (env.termProgram === "vscode") {
		return "vscode-xtermjs";
	}
	if (env.terminalEmulator === "JetBrains-JediTerm") {
		return "jetbrains-jediterm";
	}
	if (env.term && env.term !== "dumb") {
		return "native";
	}
	if (env.termProgram && env.termProgram.length > 0) {
		return "native";
	}
	return "native";
}

export function detectTerminalCapabilities(env: TerminalEnvironment): TerminalCapabilities {
	const hostFamily = detectTerminalHostFamily(env);
	const synchronizedOutput = supportsSynchronizedOutput(env, hostFamily);
	const extendedKeys = supportsExtendedKeys(env, hostFamily);

	return {
		hostFamily,
		alternateScreen: hostFamily !== "unknown",
		mouseTracking: hostFamily === "native",
		focusReporting: hostFamily === "native",
		bracketedPaste: true,
		synchronizedOutput,
		extendedKeys,
	};
}

function supportsSynchronizedOutput(env: TerminalEnvironment, hostFamily: TerminalHostFamily): boolean {
	if (hostFamily === "tmux") {
		return false;
	}
	if (hostFamily === "vscode-xtermjs") {
		return true;
	}

	const termProgram = env.termProgram ?? "";
	const term = env.term ?? "";
	return (
		termProgram === "iTerm.app" ||
		termProgram === "WezTerm" ||
		termProgram === "ghostty" ||
		termProgram === "alacritty" ||
		term.includes("kitty")
	);
}

function supportsExtendedKeys(env: TerminalEnvironment, hostFamily: TerminalHostFamily): boolean {
	if (hostFamily === "vscode-xtermjs" || hostFamily === "jetbrains-jediterm") {
		return false;
	}

	const termProgram = env.termProgram ?? "";
	const term = env.term ?? "";
	return (
		termProgram === "iTerm.app" ||
		termProgram === "WezTerm" ||
		termProgram === "ghostty" ||
		term.includes("kitty")
	);
}
