/**
 * Core type definitions for the product-layer runtime.
 *
 * All public types consumed by app-tools, app-ui, app-extensions,
 * app-evaluation, and app-cli are defined here.
 */

// ---------------------------------------------------------------------------
// CLI Mode — canonically defined here to avoid circular dependencies.
// app-cli re-exports from this package.
// ---------------------------------------------------------------------------

/** Determines how input is received and output is formatted. All modes share the same runtime. */
export type CliMode = "interactive" | "print" | "json" | "rpc";

// ---------------------------------------------------------------------------
// Session identifiers
// ---------------------------------------------------------------------------

/** Branded session identifier for type-safe session references. */
export interface SessionId {
	readonly value: string;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export type SessionStatus = "creating" | "active" | "suspended" | "recovering" | "closing" | "closed";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Describes the active LLM model for a session. */
export interface ModelDescriptor {
	readonly id: string;
	readonly provider: string;
	readonly displayName?: string;
}

// ---------------------------------------------------------------------------
// Tool set
// ---------------------------------------------------------------------------

/** Set of enabled tool names. ReadonlySet ensures immutability at the type level. */
export type ToolSetDescriptor = ReadonlySet<string>;

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

export type TaskStatus = "idle" | "running" | "paused" | "completed" | "failed";

export interface TaskState {
	readonly status: TaskStatus;
	readonly currentTaskId: string | null;
	readonly startedAt: number | null;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Summary of the most recent context compaction operation. */
export interface CompactionSummary {
	readonly compressedAt: number;
	readonly originalMessageCount: number;
	readonly retainedMessageCount: number;
	readonly estimatedTokensSaved: number;
	readonly compactedSummary?: string;
}

export interface SessionTranscriptMessagePreview {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface SessionRecoveryMetadata {
	readonly summary?: string;
	readonly firstPrompt?: string;
	readonly messageCount: number;
	readonly fileSizeBytes: number;
	readonly recentMessages: readonly SessionTranscriptMessagePreview[];
}

export interface RecentSessionEntry {
	readonly recoveryData: SessionRecoveryData;
	readonly title?: string;
	readonly updatedAt: number;
}

export type RecentSessionMatchSource =
	| "title"
	| "first_prompt"
	| "summary"
	| "recent_user_message"
	| "recent_assistant_message"
	| "session_id";

export interface RecentSessionSearchHit {
	readonly entry: RecentSessionEntry;
	readonly headline: string;
	readonly snippet: string;
	readonly matchSource: RecentSessionMatchSource;
}

// ---------------------------------------------------------------------------
// Plan — canonical types live in planning/plan-types.ts. Re-exported here for
// backward compatibility so that consumers importing from types/index.js
// continue to resolve PlanStatus, PlanSummary, and PlanStep.
// ---------------------------------------------------------------------------

export type {
	PlanOutcomeReason,
	PlanStatus,
	PlanStep,
	PlanStepDetail,
	PlanStepStatus,
	PlanSummary,
} from "../planning/plan-types.js";

// Import locally for use in SessionState and SessionRecoveryData below.
// This avoids a circular dependency because plan-types.ts does not import from this file.
import type { PlanSummary as _PlanSummary } from "../planning/plan-types.js";

// ---------------------------------------------------------------------------
// SessionState — full runtime snapshot
// ---------------------------------------------------------------------------

export interface SessionState {
	readonly id: SessionId;
	readonly status: SessionStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly model: ModelDescriptor;
	readonly toolSet: ToolSetDescriptor;
	readonly planSummary: _PlanSummary | null;
	readonly compactionSummary: CompactionSummary | null;
	readonly taskState: TaskState;
}

// ---------------------------------------------------------------------------
// Session recovery — JSON-serializable payload
// ---------------------------------------------------------------------------

/**
 * Serializable snapshot used to persist and restore a session.
 *
 * Uses `readonly string[]` for the tool set instead of `ReadonlySet`
 * so that the payload can round-trip through `JSON.stringify`.
 */
export interface SessionRecoveryData {
	readonly sessionId: SessionId;
	readonly model: ModelDescriptor;
	readonly toolSet: readonly string[];
	readonly planSummary: _PlanSummary | null;
	readonly compactionSummary: CompactionSummary | null;
	readonly metadata?: SessionRecoveryMetadata | null;
	readonly taskState: TaskState;
	readonly workingDirectory?: string;
	readonly sessionFile?: string;
	readonly agentDir?: string;
}

// ---------------------------------------------------------------------------
// RuntimeContext — available to all runtime consumers
// ---------------------------------------------------------------------------

export interface RuntimeContext {
	readonly sessionId: SessionId;
	readonly workingDirectory: string;
	readonly agentDir?: string;
	readonly configSources?: Readonly<Record<string, { layer: string; detail: string }>>;
	readonly mode: CliMode;
	readonly model: ModelDescriptor;
	readonly toolSet: ToolSetDescriptor;
	readonly taskState: TaskState;
}
