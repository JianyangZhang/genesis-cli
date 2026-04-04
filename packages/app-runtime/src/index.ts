// Runtime — the shared product-layer runtime.

// Adapters
export type { KernelSessionAdapter, RawUpstreamEvent } from "./adapters/kernel-session-adapter.js";
export type { AppRuntime, AppRuntimeConfig } from "./create-app-runtime.js";
// Entry point
export { createAppRuntime } from "./create-app-runtime.js";
export type { EventBus, EventListener, Unsubscribe } from "./events/event-bus.js";
// Events
export { createEventBus } from "./events/event-bus.js";
// Governance
export { createToolGovernor } from "./governance/tool-governor.js";
export type { ToolGovernor, ToolExecutionContext, ToolExecutionResult, GovernorDecision } from "./governance/tool-governor.js";
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
	PlanStepCompletedEvent,
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
export type { RuntimeContextParams } from "./runtime-context.js";
// Context
export { createRuntimeContext, updateTaskState } from "./runtime-context.js";
// Services
export { EventNormalizer } from "./services/event-normalizer.js";
export { generateEventId, sessionClosed, sessionCreated, sessionResumed } from "./session/session-events.js";
export type { SessionFacade } from "./session/session-facade.js";
// Session
export { SessionFacadeImpl } from "./session/session-facade.js";
export {
	createInitialSessionState,
	recoverSessionState,
	serializeForRecovery,
	updateCompactionSummary,
	updateSessionStatus,
	updateTaskState as updateSessionTaskState,
} from "./session/session-state.js";
// Types — re-export all public types
export type {
	CliMode,
	CompactionSummary,
	ModelDescriptor,
	PlanStatus,
	PlanStep,
	PlanSummary,
	RuntimeContext,
	SessionId,
	SessionRecoveryData,
	SessionState,
	SessionStatus,
	TaskState,
	TaskStatus,
	ToolSetDescriptor,
} from "./types/index.js";
