/**
 * TUI layout model — defines the information architecture for the interactive screen.
 *
 * The layout is a data structure, not rendering logic.
 * It describes WHAT information is on screen, not HOW it is drawn.
 */

import type { InteractionPhase, OutputMode } from "../types/index.js";

// ---------------------------------------------------------------------------
// Screen layout
// ---------------------------------------------------------------------------

/** Complete screen layout for the interactive TUI. */
export interface TuiScreenLayout {
	readonly mode: OutputMode;
	readonly header: HeaderRegion;
	readonly conversation: ConversationRegion;
	readonly statusLine: StatusLineRegion;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface HeaderRegion {
	/** Display name of the active model. */
	readonly modelName: string;
	/** Session status string. */
	readonly sessionStatus: string;
	/** Active plan description or null. */
	readonly planStatus: string | null;
}

// ---------------------------------------------------------------------------
// Conversation area
// ---------------------------------------------------------------------------

export interface ConversationRegion {
	readonly lines: readonly ConversationLine[];
}

/** A single line in the conversation area. */
export type ConversationLine =
	| TextLine
	| ToolCallLine
	| PermissionPromptLine
	| PermissionResultLine
	| PlanStepLine
	| DividerLine;

export interface TextLine {
	readonly type: "text";
	readonly role: "user" | "assistant";
	readonly timestamp: number;
	readonly authorName?: string;
	readonly content: string;
}

export interface ToolCallLine {
	readonly type: "tool_call";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly status: ToolCallDisplayStatus;
	readonly durationMs?: number;
	readonly summary?: string;
}

export type ToolCallDisplayStatus = "running" | "success" | "failure" | "denied";

export interface PermissionPromptLine {
	readonly type: "permission_prompt";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly riskLevel: string;
	readonly reason?: string;
	readonly targetPath?: string;
}

export interface PermissionResultLine {
	readonly type: "permission_result";
	readonly toolName: string;
	readonly toolCallId: string;
	readonly decision: "allow" | "allow_for_session" | "allow_once" | "deny";
}

export interface PlanStepLine {
	readonly type: "plan_step";
	readonly planId: string;
	readonly stepId: string;
	readonly description: string;
	readonly status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

export interface DividerLine {
	readonly type: "divider";
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface StatusLineRegion {
	readonly phase: InteractionPhase;
	readonly activeTool: string | null;
	/** Plan progress string, e.g. "Plan: 2/5 steps". */
	readonly planProgress: string | null;
	/** Scroll position indicator, e.g. "Lines 20-40/80". */
	readonly scrollPosition: string | null;
}
