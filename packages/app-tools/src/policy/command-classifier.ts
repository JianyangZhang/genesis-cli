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

const SIMPLE_ARG_PATTERN = /^[./~:@A-Za-z0-9_=-]+$/;
const LS_SAFE_FLAG_CHARS = new Set(["a", "A", "l", "h", "F", "G", "1", "t", "r", "S", "d"]);
const PWD_SAFE_FLAG_CHARS = new Set(["L", "P"]);
const RG_SAFE_FLAGS = new Set([
	"-e",
	"--regexp",
	"-f",
	"-i",
	"--ignore-case",
	"-S",
	"--smart-case",
	"-F",
	"--fixed-strings",
	"-w",
	"--word-regexp",
	"-v",
	"--invert-match",
	"-c",
	"--count",
	"-l",
	"--files-with-matches",
	"--files-without-match",
	"-n",
	"--line-number",
	"-o",
	"--only-matching",
	"-A",
	"--after-context",
	"-B",
	"--before-context",
	"-C",
	"--context",
	"-H",
	"-h",
	"--heading",
	"--no-heading",
	"-q",
	"--quiet",
	"--column",
	"-g",
	"--glob",
	"-t",
	"--type",
	"-T",
	"--type-not",
	"--type-list",
	"--hidden",
	"--no-ignore",
	"-u",
	"-m",
	"--max-count",
	"--max-depth",
	"-L",
	"--follow",
	"--color",
	"--json",
	"--stats",
	"--help",
	"--version",
	"--debug",
	"--",
]);
const RG_FLAGS_WITH_VALUE = new Set([
	"-e",
	"--regexp",
	"-f",
	"-A",
	"--after-context",
	"-B",
	"--before-context",
	"-C",
	"--context",
	"-g",
	"--glob",
	"-t",
	"--type",
	"-T",
	"--type-not",
	"-m",
	"--max-count",
	"--max-depth",
	"--color",
]);
const READONLY_SHELL_COMMANDS = new Set(["cat", "head", "tail", "wc", "grep"]);

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
export function createCommandPolicy(command: string, cwd: string): CommandPolicy {
	const commandClass = classifyCommand(command);

	return {
		commandClass,
		cwd,
		blocking: commandClass !== "background_process",
		timeoutMs: TIMEOUT_DEFAULTS[commandClass],
		riskLevel: RISK_DEFAULTS[commandClass],
	};
}

export function isReadOnlyShellCommand(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (tokens === null || tokens.length === 0) {
		return false;
	}
	const head = tokens[0];
	if (head === "pwd") {
		return tokens.slice(1).every((token) => isSafeShortFlag(token, PWD_SAFE_FLAG_CHARS));
	}
	if (head === "ls") {
		return tokens.slice(1).every((token) => isSafeLsArg(token));
	}
	if (READONLY_SHELL_COMMANDS.has(head)) {
		return tokens.slice(1).every((token) => isSafeReadOnlyToken(token));
	}
	if (head === "rg") {
		return validateRipgrepArgs(tokens.slice(1));
	}
	return false;
}

function isSafeLsArg(token: string): boolean {
	return isSafeShortFlag(token, LS_SAFE_FLAG_CHARS) || SIMPLE_ARG_PATTERN.test(token);
}

function isSafeReadOnlyToken(token: string): boolean {
	return !hasUnsafeShellContent(token);
}

function isSafeShortFlag(token: string, allowedChars: ReadonlySet<string>): boolean {
	if (!token.startsWith("-") || token === "--") {
		return false;
	}
	for (const char of token.slice(1)) {
		if (!allowedChars.has(char)) {
			return false;
		}
	}
	return token.length > 1;
}

function validateRipgrepArgs(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		if (hasUnsafeShellContent(token)) {
			return false;
		}
		if (!token.startsWith("-") || token === "--") {
			continue;
		}
		const [flag, inlineValue] = token.split("=", 2);
		if (!RG_SAFE_FLAGS.has(flag)) {
			return false;
		}
		if (inlineValue !== undefined) {
			if (!RG_FLAGS_WITH_VALUE.has(flag) || hasUnsafeShellContent(inlineValue)) {
				return false;
			}
			continue;
		}
		if (RG_FLAGS_WITH_VALUE.has(flag)) {
			const next = args[index + 1];
			if (typeof next !== "string" || next.length === 0 || hasUnsafeShellContent(next)) {
				return false;
			}
			index += 1;
		}
	}
	return true;
}

function tokenizeShellCommand(command: string): string[] | null {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < trimmed.length; index += 1) {
		const char = trimmed[index] ?? "";
		if (quote !== null) {
			if (char === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && char === "\\") {
				const next = trimmed[index + 1];
				if (next !== undefined) {
					current += next;
					index += 1;
					continue;
				}
			}
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\") {
			const next = trimmed[index + 1];
			if (next === undefined) {
				return null;
			}
			current += next;
			index += 1;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		if ("|&;<>`()".includes(char)) {
			return null;
		}
		current += char;
	}
	if (quote !== null) {
		return null;
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

function hasUnsafeShellContent(token: string): boolean {
	if (/[\n\r`$]/.test(token)) {
		return true;
	}
	if (token.includes("{") && (token.includes(",") || token.includes(".."))) {
		return true;
	}
	return false;
}
