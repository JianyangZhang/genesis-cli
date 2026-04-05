/**
 * ToolGovernor — the runtime integration point for tool governance.
 *
 * Wraps ToolCatalog, PermissionEngine, MutationQueue, and AuditLog into a
 * single object that the SessionFacade uses to enforce governance on every
 * tool execution event. The governor is created once per AppRuntime and
 * shared across all sessions.
 *
 * Lifecycle:
 *   1. beforeExecution()  — called when a tool_starts event arrives
 *   2. afterExecution()   — called when a tool_completed event arrives
 *   3. recordSessionApproval() — called when user grants session approval
 */

import { createHash } from "node:crypto";
import type {
	ApprovalCacheEntry,
	AuditEntry,
	AuditLog,
	MutationQueue,
	PermissionContext,
	PermissionEngine,
	RiskLevel,
	ToolCatalog,
	ToolDefinition,
} from "@genesis-cli/tools";
import {
	classifyRisk,
	createAuditLog,
	createMutationQueue,
	createPermissionEngine,
	createToolCatalog,
	isDestructiveCommand,
} from "@genesis-cli/tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for a pre-execution governance check. */
export interface ToolExecutionContext {
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolCallId: string;
	readonly workingDirectory: string;
	readonly sessionMode: string;
	readonly isSubAgent: boolean;
	readonly targetPath?: string;
	readonly commandDigest?: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
}

/** Input for a post-execution governance record. */
export interface ToolExecutionResult {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly status: "success" | "failure";
	readonly targetPath?: string;
	readonly durationMs?: number;
}

/** Outcome of a pre-execution governance check. */
export type GovernorDecision =
	| { readonly type: "allow" }
	| { readonly type: "deny"; readonly reason: string; readonly riskLevel: RiskLevel }
	| { readonly type: "ask_user"; readonly reason: string; readonly riskLevel: RiskLevel };

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ToolGovernor {
	/** Check whether a tool invocation is permitted before execution. */
	beforeExecution(context: ToolExecutionContext): GovernorDecision;

	/** Record the outcome of a tool invocation after execution. */
	afterExecution(result: ToolExecutionResult): void;

	/** Record a session-scoped user approval. */
	recordSessionApproval(entry: ApprovalCacheEntry): void;

	/** Tool catalog — callers may register tools or query definitions. */
	readonly catalog: ToolCatalog;

	/** Permission engine — direct access for advanced use. */
	readonly permissions: PermissionEngine;

	/** Mutation queue — direct access for advanced use. */
	readonly mutations: MutationQueue;

	/** Audit log — query past tool invocations. */
	readonly audit: AuditLog;
}

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
// Factory
// ---------------------------------------------------------------------------

export function createToolGovernor(): ToolGovernor {
	const catalog = createToolCatalog();
	const permissions = createPermissionEngine();
	const mutations = createMutationQueue();
	const audit = createAuditLog();
	const activeExecutions = new Map<string, { toolName: string; targetPath?: string; riskLevel: RiskLevel }>();
	const sessionApprovals: ApprovalCacheEntry[] = [];

	function deriveCommandDigest(
		parameters: Readonly<Record<string, unknown>> | undefined,
		explicitDigest: string | undefined,
	): string | undefined {
		if (explicitDigest) return explicitDigest;

		const command = parameters?.command;
		if (typeof command !== "string" || command.length === 0) {
			return undefined;
		}

		return `sha256:${createHash("sha256").update(command).digest("hex")}`;
	}

	function recordDeniedAudit(
		toolName: string,
		toolCallId: string,
		riskLevel: RiskLevel,
		reason: string,
		targetPath?: string,
	): void {
		const toolDef = catalog.get(toolName);
		const now = Date.now();
		const entry: AuditEntry = {
			id: `audit_${toolCallId}`,
			toolCallId,
			toolName,
			category: toolDef?.identity.category ?? "unknown",
			status: "denied",
			riskLevel,
			startedAt: now,
			completedAt: now,
			durationMs: 0,
			targetPath,
			error: reason,
			permissionDecision: "deny",
		};
		audit.record(entry);
	}

	return {
		beforeExecution(context: ToolExecutionContext): GovernorDecision {
			const {
				sessionId,
				toolName,
				toolCallId,
				workingDirectory,
				sessionMode,
				isSubAgent,
				targetPath,
				commandDigest,
				parameters,
			} = context;

			// 1. Look up tool in catalog
			const toolDef: ToolDefinition | undefined = catalog.get(toolName);
			if (!toolDef) {
				recordDeniedAudit(
					toolName,
					toolCallId,
					"L4",
					`Tool "${toolName}" is not registered in the catalog`,
					targetPath,
				);
				return {
					type: "deny",
					reason: `Tool "${toolName}" is not registered in the catalog`,
					riskLevel: "L4",
				};
			}

			// 2. Build PermissionContext from tool definition + execution context
			const command = parameters?.command;
			const effectiveRiskLevel =
				typeof command === "string" && isDestructiveCommand(command) ? "L4" : classifyRisk(toolDef, parameters);
			const effectiveCommandDigest = deriveCommandDigest(parameters, commandDigest);
			const autoAllowReadOnlyBash =
				toolName === "bash" && typeof command === "string" && isAutoAllowedReadOnlyBashCommand(command);
			if (autoAllowReadOnlyBash) {
				activeExecutions.set(toolCallId, { toolName, targetPath, riskLevel: effectiveRiskLevel });
				return { type: "allow" };
			}
			const matchingSessionApproval = sessionApprovals.find((entry) =>
				matchesSessionApproval(entry, sessionId, toolName, effectiveRiskLevel, targetPath, effectiveCommandDigest),
			);
			const permContext: PermissionContext = {
				sessionId,
				toolIdentity: toolDef.identity,
				toolPolicy: { ...toolDef.policy, riskLevel: effectiveRiskLevel },
				targetPath,
				commandDigest: effectiveCommandDigest,
				workingDirectory,
				sessionMode,
				isSubAgent,
				toolCallId,
			};

			// 3. Evaluate permission
			if (!matchingSessionApproval) {
				const decision = permissions.evaluate(permContext);
				if (decision.verdict === "deny") {
					recordDeniedAudit(
						toolName,
						toolCallId,
						decision.riskLevel,
						decision.reason ?? "Permission denied",
						targetPath,
					);
					return {
						type: "deny",
						reason: decision.reason ?? `Permission denied for "${toolName}"`,
						riskLevel: decision.riskLevel,
					};
				}
				if (decision.verdict === "ask_user") {
					return {
						type: "ask_user",
						reason: decision.reason ?? `Tool "${toolName}" requires confirmation`,
						riskLevel: decision.riskLevel,
					};
				}
			}

			// 4. Check mutation queue for per_target concurrency
			if (toolDef.policy.concurrency === "per_target" && targetPath) {
				const enqueueResult = mutations.enqueue({
					filePath: targetPath,
					toolCallId,
				});
				if (enqueueResult.type === "conflict") {
					recordDeniedAudit(toolName, toolCallId, effectiveRiskLevel, enqueueResult.message, targetPath);
					return {
						type: "deny",
						reason: enqueueResult.message,
						riskLevel: effectiveRiskLevel,
					};
				}
			}

			activeExecutions.set(toolCallId, { toolName, targetPath, riskLevel: effectiveRiskLevel });
			return { type: "allow" };
		},

		afterExecution(result: ToolExecutionResult): void {
			const { toolCallId, toolName, status, targetPath, durationMs } = result;
			const active = activeExecutions.get(toolCallId);

			// 1. Release mutation queue entry if applicable
			const toolDef = catalog.get(active?.toolName ?? toolName);
			if (toolDef?.policy.concurrency === "per_target") {
				mutations.complete(toolCallId);
			}

			// 2. Record in audit log
			const now = Date.now();
			const entry: AuditEntry = {
				id: `audit_${toolCallId}`,
				toolCallId,
				toolName,
				category: toolDef?.identity.category ?? "unknown",
				status,
				riskLevel: active?.riskLevel ?? toolDef?.policy.riskLevel ?? "L4",
				startedAt: durationMs ? now - durationMs : now,
				completedAt: now,
				durationMs: durationMs ?? 0,
				targetPath: targetPath ?? active?.targetPath,
			};
			audit.record(entry);
			activeExecutions.delete(toolCallId);
		},

		recordSessionApproval(entry: ApprovalCacheEntry): void {
			sessionApprovals.push(entry);
			permissions.recordApproval(entry);
		},

		get catalog(): ToolCatalog {
			return catalog;
		},

		get permissions(): PermissionEngine {
			return permissions;
		},

		get mutations(): MutationQueue {
			return mutations;
		},

		get audit(): AuditLog {
			return audit;
		},
	};
}

function isAutoAllowedReadOnlyBashCommand(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (tokens === null || tokens.length === 0) {
		return false;
	}
	const head = tokens[0];
	if (head === "pwd") {
		return tokens.slice(1).every((token) => isSafeShortFlag(token, PWD_SAFE_FLAG_CHARS));
	}
	if (head === "ls") {
		return tokens
			.slice(1)
			.every((token) => isSafeShortFlag(token, LS_SAFE_FLAG_CHARS) || SIMPLE_ARG_PATTERN.test(token));
	}
	if (READONLY_SHELL_COMMANDS.has(head)) {
		return tokens.slice(1).every((token) => !hasUnsafeShellContent(token));
	}
	if (head === "rg") {
		return validateRipgrepArgs(tokens.slice(1));
	}
	return false;
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

function matchesSessionApproval(
	entry: ApprovalCacheEntry,
	sessionId: string,
	toolName: string,
	riskLevel: RiskLevel,
	targetPath: string | undefined,
	commandDigest: string | undefined,
): boolean {
	return (
		entry.sessionId === sessionId &&
		entry.toolName === toolName &&
		entry.riskLevel === riskLevel &&
		matchesTargetPattern(entry.targetPattern, targetPath) &&
		matchesCommandDigest(entry.commandDigest, commandDigest)
	);
}

function matchesTargetPattern(targetPattern: string, targetPath: string | undefined): boolean {
	if (targetPath === undefined) {
		return targetPattern === "*";
	}
	if (targetPattern === "*") {
		return false;
	}
	if (targetPattern.endsWith("/**")) {
		const prefix = targetPattern.slice(0, -3);
		return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
	}
	return targetPath === targetPattern;
}

function matchesCommandDigest(expected: string | undefined, actual: string | undefined): boolean {
	if (expected === undefined) {
		return actual === undefined;
	}
	return expected === actual;
}
