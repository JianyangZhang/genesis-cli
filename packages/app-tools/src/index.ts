// Tools — catalog, permissions, and execution wrappers.

// Audit
export { createAuditLog } from "./audit/audit-log.js";
export type { ToolCatalog } from "./catalog/tool-catalog.js";
// Catalog
export { createToolCatalog } from "./catalog/tool-catalog.js";
export type { MutationQueue } from "./mutation-queue/mutation-queue.js";
// Mutation queue
export { createMutationQueue } from "./mutation-queue/mutation-queue.js";
export { classifyCommand, createCommandPolicy, isReadOnlyShellCommand } from "./policy/command-classifier.js";
export type { PermissionEngine } from "./policy/permission-engine.js";
// Policy
export { createPermissionEngine } from "./policy/permission-engine.js";
export { classifyRisk, isDestructiveCommand } from "./policy/risk-classifier.js";
// Types
export type {
	ApprovalCacheEntry,
	AuditEntry,
	AuditLog,
	CommandClass,
	CommandPolicy,
	ConcurrencyModel,
	ConfirmationMode,
	EnqueueResult,
	McpServerDescriptor,
	McpToolEntry,
	McpTransportType,
	MutationTarget,
	OutputDescriptor,
	ParameterProperty,
	ParameterSchema,
	PermissionContext,
	PermissionDecision,
	PermissionVerdict,
	QueueConflict,
	RiskLevel,
	ToolCategory,
	ToolContract,
	ToolDefinition,
	ToolError,
	ToolErrorKind,
	ToolIdentity,
	ToolPolicy,
	ToolResultStatus,
} from "./types/index.js";
