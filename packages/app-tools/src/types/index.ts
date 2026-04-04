/**
 * Risk levels for tool invocations.
 *
 * L0 — read-only, no side effects
 * L1 — low-impact writes (e.g., create new file)
 * L2 — moderate impact (e.g., edit existing file)
 * L3 — high impact (e.g., execute shell command)
 * L4 — destructive (e.g., force push, drop table)
 */
export type RiskLevel = "L0" | "L1" | "L2" | "L3" | "L4";

/**
 * Outcome of a tool invocation.
 */
export type ToolResultStatus = "success" | "failure" | "denied";

/**
 * Unique identity for a tool in the catalog.
 */
export interface ToolIdentity {
	readonly name: string;
	readonly category: string;
}

// ---------------------------------------------------------------------------
// Re-exports from sub-modules
// ---------------------------------------------------------------------------

export type { ToolCategory } from "./tool-category.js";
export type {
	ParameterSchema,
	ParameterProperty,
	OutputDescriptor,
	ToolErrorKind,
	ToolError,
	ToolContract,
} from "./tool-contract.js";
export type { ConfirmationMode, ConcurrencyModel, ToolPolicy } from "./tool-policy.js";
export type { ToolDefinition } from "./tool-definition.js";
export type {
	PermissionVerdict,
	PermissionDecision,
	PermissionContext,
	ApprovalCacheEntry,
} from "./permission.js";
export type { CommandClass, CommandPolicy } from "./command-policy.js";
export type { AuditEntry, AuditLog } from "./audit.js";
export type { MutationTarget, QueueConflict, EnqueueResult } from "./mutation.js";
export type { McpTransportType, McpServerDescriptor, McpToolEntry } from "./mcp.js";
