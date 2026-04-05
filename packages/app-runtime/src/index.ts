// Runtime — the shared product-layer runtime.

export {
	bridgePiMonoEvent,
	createInitialBridgeState,
	type PiMonoBridgeResult,
	type PiMonoBridgeState,
	PiMonoSessionAdapter,
	type PiMonoSessionAdapterOptions,
} from "./adapters/index.js";
// Adapters
export type { KernelSessionAdapter, RawUpstreamEvent } from "./adapters/kernel-session-adapter.js";
export type { AppRuntime, AppRuntimeConfig } from "./create-app-runtime.js";
// Entry point
export { createAppRuntime } from "./create-app-runtime.js";
export type { EventBus, EventListener, Unsubscribe } from "./events/event-bus.js";
// Events
export { createEventBus } from "./events/event-bus.js";
// Event types — re-export all
export type {
	BaseEvent,
	CompactionCompletedEvent,
	CompactionEvent,
	CompactionStartedEvent,
	PermissionDecisionEvent,
	PermissionRequestedEvent,
	PermissionResolvedEvent,
	PlanCompletedEvent,
	PlanCreatedEvent,
	PlanProgressEvent,
	PlanReworkEvent,
	PlanStepCompletedEvent,
	PlanStepFailedEvent,
	PlanStepStartedEvent,
	RuntimeEvent,
	SessionClosedEvent,
	SessionClosingEvent,
	SessionCreatedEvent,
	SessionLifecycleEvent,
	SessionResumedEvent,
	SessionSuspendedEvent,
	TextDeltaEvent,
	TextStreamEvent,
	ThinkingDeltaEvent,
	ToolCompletedEvent,
	ToolDeniedEvent,
	ToolExecutionEvent,
	ToolStartedEvent,
	ToolUpdateEvent,
} from "./events/runtime-event.js";
export type {
	GovernorDecision,
	ToolExecutionContext,
	ToolExecutionResult,
	ToolGovernor,
} from "./governance/tool-governor.js";
// Governance
export { createToolGovernor } from "./governance/tool-governor.js";
export type { Plan, PlanEngine } from "./planning/plan-engine.js";
// Planning
export { createPlanEngine } from "./planning/plan-engine.js";
export {
	planCompleted,
	planCreated,
	planRework,
	planStepCompleted,
	planStepFailed,
	planStepStarted,
} from "./planning/plan-events.js";
export type { PlanOrchestrator } from "./planning/plan-orchestrator.js";
export { createPlanOrchestrator } from "./planning/plan-orchestrator.js";
// Planning types
export type {
	PlanOutcomeReason,
	PlanStatus,
	PlanStep,
	PlanStepDetail,
	PlanStepStatus,
	PlanSummary,
} from "./planning/plan-types.js";
// Context
export type { RuntimeContextParams } from "./runtime-context.js";
export { createRuntimeContext, updateTaskState } from "./runtime-context.js";
// Services
export { EventNormalizer } from "./services/event-normalizer.js";
// Session events
export { generateEventId, sessionClosed, sessionCreated, sessionResumed } from "./session/session-events.js";
// Session
export type { SessionFacade } from "./session/session-facade.js";
export { SessionFacadeImpl } from "./session/session-facade.js";
export {
	createInitialSessionState,
	recoverSessionState,
	serializeForRecovery,
	updateCompactionSummary,
	updatePlanSummary,
	updateSessionStatus,
	updateTaskState as updateSessionTaskState,
} from "./session/session-state.js";
// Subagent — aggregation
export { aggregateResults, decideRework } from "./subagent/aggregation.js";
// Subagent — path scope
export { isPathAllowed, isPathForbidden, scopesOverlap, wouldViolateBoundary } from "./subagent/path-scope.js";
// Subagent — types
export type {
	AggregationResult,
	ReworkDecision,
	SubagentResult,
	SubagentResultStatus,
	SubagentRuntimeSnapshot,
	TaskRisk,
	VerificationResult,
} from "./subagent/result-types.js";
// Subagent — stop condition
export type { SubagentRuntimeState } from "./subagent/stop-condition.js";
export {
	createInitialRuntimeState,
	evaluateStopConditions,
	recordBoundaryViolation,
	recordError,
	recordModification,
	updateElapsedTime,
} from "./subagent/stop-condition.js";
export type {
	PathScope,
	StopCondition,
	StopConditionType,
	SubagentTask,
	TaskInputs,
	Verification,
	VerificationType,
} from "./subagent/task-types.js";
// Subagent — validation
export type { ValidationResult } from "./subagent/task-validator.js";
export { hasConsistentScope, hasRequiredFields, validateTask } from "./subagent/task-validator.js";
// Subagent — verification
export type { VerificationEvaluation } from "./subagent/verification.js";
export { evaluateVerifications, isVerificationTrustworthy } from "./subagent/verification.js";
// Types — re-export all public types
export type {
	CliMode,
	CompactionSummary,
	ModelDescriptor,
	RuntimeContext,
	SessionId,
	SessionRecoveryData,
	SessionState,
	SessionStatus,
	TaskState,
	TaskStatus,
	ToolSetDescriptor,
} from "./types/index.js";
