/**
 * Standardized product-layer event taxonomy.
 *
 * All events consumed by UI, tools, and extensions must be one of these types.
 * Raw upstream events from pi-mono are translated here by the EventNormalizer —
 * they are never exposed directly.
 *
 * Events use a dual discriminant: `category` (broad area) and `type` (specific event).
 * Consumers can filter at either granularity.
 */

import type {
	CompactionSummary,
	ModelDescriptor,
	PlanSummary,
	SessionId,
	SessionRecoveryData,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Fields shared by every product-layer event. */
export interface BaseEvent {
	readonly id: string;
	readonly timestamp: number;
	readonly sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// 1. Session Lifecycle
// ---------------------------------------------------------------------------

export interface SessionCreatedEvent extends BaseEvent {
	readonly category: "session";
	readonly type: "session_created";
	readonly model: ModelDescriptor;
	readonly toolSet: readonly string[];
}

export interface SessionResumedEvent extends BaseEvent {
	readonly category: "session";
	readonly type: "session_resumed";
	readonly recoveryData: SessionRecoveryData;
}

export interface SessionSuspendedEvent extends BaseEvent {
	readonly category: "session";
	readonly type: "session_suspended";
}

export interface SessionClosingEvent extends BaseEvent {
	readonly category: "session";
	readonly type: "session_closing";
}

export interface SessionClosedEvent extends BaseEvent {
	readonly category: "session";
	readonly type: "session_closed";
}

export type SessionLifecycleEvent =
	| SessionCreatedEvent
	| SessionResumedEvent
	| SessionSuspendedEvent
	| SessionClosingEvent
	| SessionClosedEvent;

// ---------------------------------------------------------------------------
// 2. Tool Execution
// ---------------------------------------------------------------------------

export interface ToolStartedEvent extends BaseEvent {
	readonly category: "tool";
	readonly type: "tool_started";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolUpdateEvent extends BaseEvent {
	readonly category: "tool";
	readonly type: "tool_update";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly update: string;
}

export interface ToolCompletedEvent extends BaseEvent {
	readonly category: "tool";
	readonly type: "tool_completed";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly status: "success" | "failure";
	readonly result?: string;
	readonly durationMs: number;
}

export interface ToolDeniedEvent extends BaseEvent {
	readonly category: "tool";
	readonly type: "tool_denied";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly reason: string;
}

export type ToolExecutionEvent = ToolStartedEvent | ToolUpdateEvent | ToolCompletedEvent | ToolDeniedEvent;

// ---------------------------------------------------------------------------
// 3. Plan Progress — types only; emission is P4.
// ---------------------------------------------------------------------------

export interface PlanCreatedEvent extends BaseEvent {
	readonly category: "plan";
	readonly type: "plan_created";
	readonly planId: string;
	readonly goal: string;
	readonly stepCount: number;
}

export interface PlanStepStartedEvent extends BaseEvent {
	readonly category: "plan";
	readonly type: "plan_step_started";
	readonly planId: string;
	readonly stepId: string;
	readonly stepDescription: string;
}

export interface PlanStepCompletedEvent extends BaseEvent {
	readonly category: "plan";
	readonly type: "plan_step_completed";
	readonly planId: string;
	readonly stepId: string;
	readonly success: boolean;
}

export interface PlanCompletedEvent extends BaseEvent {
	readonly category: "plan";
	readonly type: "plan_completed";
	readonly planId: string;
	readonly goal: string;
	readonly success: boolean;
	readonly summary: PlanSummary;
}

export type PlanProgressEvent = PlanCreatedEvent | PlanStepStartedEvent | PlanStepCompletedEvent | PlanCompletedEvent;

// ---------------------------------------------------------------------------
// 4. Compaction
// ---------------------------------------------------------------------------

export interface CompactionStartedEvent extends BaseEvent {
	readonly category: "compaction";
	readonly type: "compaction_started";
}

export interface CompactionCompletedEvent extends BaseEvent {
	readonly category: "compaction";
	readonly type: "compaction_completed";
	readonly summary: CompactionSummary;
}

export type CompactionEvent = CompactionStartedEvent | CompactionCompletedEvent;

// ---------------------------------------------------------------------------
// 5. Permission Decision
// ---------------------------------------------------------------------------

export interface PermissionRequestedEvent extends BaseEvent {
	readonly category: "permission";
	readonly type: "permission_requested";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly riskLevel: string;
}

export interface PermissionResolvedEvent extends BaseEvent {
	readonly category: "permission";
	readonly type: "permission_resolved";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly decision: "allow" | "allow_for_session" | "allow_once" | "deny";
}

export type PermissionDecisionEvent = PermissionRequestedEvent | PermissionResolvedEvent;

// ---------------------------------------------------------------------------
// 6. Text Stream
// ---------------------------------------------------------------------------

export interface TextDeltaEvent extends BaseEvent {
	readonly category: "text";
	readonly type: "text_delta";
	readonly content: string;
}

export interface ThinkingDeltaEvent extends BaseEvent {
	readonly category: "text";
	readonly type: "thinking_delta";
	readonly content: string;
}

export type TextStreamEvent = TextDeltaEvent | ThinkingDeltaEvent;

// ---------------------------------------------------------------------------
// Union of all product-layer events
// ---------------------------------------------------------------------------

export type RuntimeEvent =
	| SessionLifecycleEvent
	| ToolExecutionEvent
	| PlanProgressEvent
	| CompactionEvent
	| PermissionDecisionEvent
	| TextStreamEvent;
