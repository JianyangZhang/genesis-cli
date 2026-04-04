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
	createAuditLog,
	createMutationQueue,
	createPermissionEngine,
	createToolCatalog,
} from "@genesis-cli/tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for a pre-execution governance check. */
export interface ToolExecutionContext {
	readonly toolName: string;
	readonly toolCallId: string;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolGovernor(): ToolGovernor {
	const catalog = createToolCatalog();
	const permissions = createPermissionEngine();
	const mutations = createMutationQueue();
	const audit = createAuditLog();

	return {
		beforeExecution(context: ToolExecutionContext): GovernorDecision {
			const { toolName, toolCallId, targetPath, commandDigest } = context;

			// 1. Look up tool in catalog
			const toolDef: ToolDefinition | undefined = catalog.get(toolName);
			if (!toolDef) {
				return {
					type: "deny",
					reason: `Tool "${toolName}" is not registered in the catalog`,
					riskLevel: "L4",
				};
			}

			// 2. Build PermissionContext from tool definition + execution context
			const permContext: PermissionContext = {
				toolIdentity: toolDef.identity,
				toolPolicy: toolDef.policy,
				targetPath,
				commandDigest,
				workingDirectory: "",  // Set by the session facade
				sessionMode: "",       // Set by the session facade
				isSubAgent: false,     // Set by the session facade
				toolCallId,
			};

			// 3. Evaluate permission
			const decision = permissions.evaluate(permContext);
			if (decision.verdict === "deny") {
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

			// 4. Check mutation queue for per_target concurrency
			if (toolDef.policy.concurrency === "per_target" && targetPath) {
				const enqueueResult = mutations.enqueue({
					filePath: targetPath,
					toolCallId,
				});
				if (enqueueResult.type === "conflict") {
					return {
						type: "deny",
						reason: enqueueResult.message,
						riskLevel: toolDef.policy.riskLevel,
					};
				}
			}

			return { type: "allow" };
		},

		afterExecution(result: ToolExecutionResult): void {
			const { toolCallId, toolName, status, targetPath, durationMs } = result;

			// 1. Release mutation queue entry if applicable
			const toolDef = catalog.get(toolName);
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
				riskLevel: toolDef?.policy.riskLevel ?? "L4",
				startedAt: durationMs ? now - durationMs : now,
				completedAt: now,
				durationMs: durationMs ?? 0,
				targetPath,
			};
			audit.record(entry);
		},

		recordSessionApproval(entry: ApprovalCacheEntry): void {
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
