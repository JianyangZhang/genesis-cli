/**
 * Command classifier — categorizes shell commands into four types.
 *
 * The classification drives timeout defaults, approval policy, and
 * resource management. Classification is heuristic-based and extensible.
 */

import type { CommandClass, CommandPolicy } from "../types/command-policy.js";

// ---------------------------------------------------------------------------
// Heuristic patterns
// ---------------------------------------------------------------------------

/** Keywords that suggest a web server or dev server. */
const WEB_SERVER_PATTERNS: readonly RegExp[] = [
	/\bserve\b/,
	/\bdev\b/,
	/\bstart\b/,
	/\blisten\b/,
	/\bhttp-server\b/,
	/\bwebpack-dev-server\b/,
	/\bvite\b/,
	/\bnext\b/,
];

/** Patterns that indicate a background process. */
const BACKGROUND_PATTERNS: readonly RegExp[] = [
	/\bnohup\b/,
	/\bdisown\b/,
	/\bgunicorn\b.*--daemon/,
	/&\s*$/, // trailing &
];

/** Keywords for long-running tasks. */
const LONG_TASK_PATTERNS: readonly RegExp[] = [
	/\bbuild\b/,
	/\bcompile\b/,
	/\btest\b/,
	/\bbundle\b/,
	/\binstall\b/,
	/\bdeploy\b/,
	/\bmigrate\b/,
];

// ---------------------------------------------------------------------------
// Timeout defaults per command class (ms)
// ---------------------------------------------------------------------------

const TIMEOUT_DEFAULTS: Readonly<Record<CommandClass, number>> = {
	short_command: 30_000,
	long_task: 300_000,
	web_server: 0,
	background_process: 0,
};

const RISK_DEFAULTS: Readonly<Record<CommandClass, string>> = {
	short_command: "L2",
	long_task: "L2",
	web_server: "L3",
	background_process: "L3",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a command string into one of four command classes.
 *
 * Evaluation order:
 *   1. background patterns (trailing &, nohup, etc.)
 *   2. web server patterns (serve, dev, start, etc.)
 *   3. long task patterns (build, test, compile, etc.)
 *   4. default: short_command
 */
export function classifyCommand(command: string): CommandClass {
	if (BACKGROUND_PATTERNS.some((p) => p.test(command))) {
		return "background_process";
	}

	if (WEB_SERVER_PATTERNS.some((p) => p.test(command))) {
		return "web_server";
	}

	if (LONG_TASK_PATTERNS.some((p) => p.test(command))) {
		return "long_task";
	}

	return "short_command";
}

/**
 * Build a full CommandPolicy for a command, including classification,
 * timeout defaults, and risk level.
 */
export function createCommandPolicy(
	command: string,
	cwd: string,
): CommandPolicy {
	const commandClass = classifyCommand(command);

	return {
		commandClass,
		cwd,
		blocking: commandClass !== "background_process",
		timeoutMs: TIMEOUT_DEFAULTS[commandClass],
		riskLevel: RISK_DEFAULTS[commandClass],
	};
}
