// Tools — catalog, permissions, and execution wrappers.

// Types
export type {
	RiskLevel,
	ToolIdentity,
	ToolResultStatus,
	ToolCategory,
	ParameterSchema,
	ParameterProperty,
	OutputDescriptor,
	ToolErrorKind,
	ToolError,
	ToolContract,
	ConfirmationMode,
	ConcurrencyModel,
	ToolPolicy,
	ToolDefinition,
	PermissionVerdict,
	PermissionDecision,
	PermissionContext,
	ApprovalCacheEntry,
	CommandClass,
	CommandPolicy,
	AuditEntry,
	AuditLog,
	MutationTarget,
	QueueConflict,
	EnqueueResult,
	McpTransportType,
	McpServerDescriptor,
	McpToolEntry,
} from "./types/index.js";

// Catalog
export { createToolCatalog } from "./catalog/tool-catalog.js";
export type { ToolCatalog } from "./catalog/tool-catalog.js";

// Policy
export { createPermissionEngine } from "./policy/permission-engine.js";
export type { PermissionEngine } from "./policy/permission-engine.js";
export { classifyRisk, isDestructiveCommand } from "./policy/risk-classifier.js";
export { classifyCommand, createCommandPolicy } from "./policy/command-classifier.js";

// Mutation queue
export { createMutationQueue } from "./mutation-queue/mutation-queue.js";
export type { MutationQueue } from "./mutation-queue/mutation-queue.js";

// Audit
export { createAuditLog } from "./audit/audit-log.js";
