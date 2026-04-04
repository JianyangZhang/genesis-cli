/**
 * Event-to-text formatter for Print mode.
 *
 * Pure functions — no I/O, no side effects.
 * Produces human-readable text lines from RuntimeEvents.
 */

import type {
	CompactionCompletedEvent,
	PermissionRequestedEvent,
	PlanCompletedEvent,
	PlanCreatedEvent,
	PlanReworkEvent,
	PlanStepCompletedEvent,
	PlanStepFailedEvent,
	PlanStepStartedEvent,
	PlanSummary,
	RuntimeEvent,
	ToolCompletedEvent,
	ToolDeniedEvent,
	ToolStartedEvent,
} from "@genesis-cli/runtime";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a RuntimeEvent as a human-readable text line.
 * Returns an empty string for events that produce no visible output.
 */
export function formatEventAsText(event: RuntimeEvent): string {
	switch (event.category) {
		case "session":
			return formatSessionEvent(event);
		case "tool":
			return formatToolEvent(event);
		case "plan":
			return formatPlanEvent(event);
		case "compaction":
			return formatCompactionEvent(event);
		case "permission":
			return formatPermissionEvent(event);
		case "text":
			return formatTextEvent(event);
		default:
			return "";
	}
}

/**
 * Format a tool_started event with a step indicator.
 * Example: `[1/3] Reading file src/main.ts...`
 */
export function formatToolStep(event: ToolStartedEvent, index: number, total: number): string {
	const tool = event.toolName;
	const params = formatParams(event.parameters);
	return `${DIM}[${index}/${total}]${RESET} ${CYAN}${tool}${RESET}${params ? ` ${params}` : ""}...`;
}

/**
 * Format a plan summary as text.
 */
export function formatPlanSummaryText(summary: PlanSummary): string {
	const parts = [`Plan: ${summary.completedSteps}/${summary.stepCount} steps completed`];
	return parts.join(", ");
}

/**
 * Format a permission request as a prompt line.
 */
export function formatPermissionPrompt(event: PermissionRequestedEvent): string {
	return `${YELLOW}Permission required${RESET} (${event.riskLevel}): ${event.toolName} — allow? [y/n]`;
}

// ---------------------------------------------------------------------------
// Internal formatters
// ---------------------------------------------------------------------------

function formatSessionEvent(event: RuntimeEvent): string {
	switch (event.type) {
		case "session_created":
			return `${GREEN}Session created${RESET}`;
		case "session_resumed":
			return `${GREEN}Session resumed${RESET}`;
		case "session_closed":
			return `${DIM}Session closed${RESET}`;
		default:
			return "";
	}
}

function formatToolEvent(event: RuntimeEvent): string {
	switch (event.type) {
		case "tool_started":
			return formatToolStarted(event as ToolStartedEvent);
		case "tool_completed":
			return formatToolCompleted(event as ToolCompletedEvent);
		case "tool_denied":
			return formatToolDenied(event as ToolDeniedEvent);
		case "tool_update":
			return `${DIM}  ${(event as { update: string }).update}${RESET}`;
		default:
			return "";
	}
}

function formatToolStarted(event: ToolStartedEvent): string {
	const params = formatParams(event.parameters);
	return `${CYAN}${event.toolName}${RESET}${params ? ` ${params}` : ""}`;
}

function formatToolCompleted(event: ToolCompletedEvent): string {
	const status = event.status === "success" ? `${GREEN}ok${RESET}` : `${RED}failed${RESET}`;
	const duration = formatDuration(event.durationMs);
	const result = event.result ? ` — ${truncate(event.result, 80)}` : "";
	return `  → ${status} (${duration})${result}`;
}

function formatToolDenied(event: ToolDeniedEvent): string {
	return `  → ${RED}denied${RESET}: ${event.reason}`;
}

function formatPlanEvent(event: RuntimeEvent): string {
	switch (event.type) {
		case "plan_created":
			return formatPlanCreated(event as PlanCreatedEvent);
		case "plan_step_started":
			return formatPlanStepStarted(event as PlanStepStartedEvent);
		case "plan_step_completed":
			return formatPlanStepCompleted(event as PlanStepCompletedEvent);
		case "plan_step_failed":
			return formatPlanStepFailed(event as PlanStepFailedEvent);
		case "plan_rework":
			return formatPlanRework(event as PlanReworkEvent);
		case "plan_completed":
			return formatPlanCompleted(event as PlanCompletedEvent);
		default:
			return "";
	}
}

function formatPlanCreated(event: PlanCreatedEvent): string {
	return `${CYAN}Plan${RESET}: ${event.goal} (${event.stepCount} steps)`;
}

function formatPlanStepStarted(event: PlanStepStartedEvent): string {
	return `  ${DIM}▸${RESET} ${event.stepDescription}`;
}

function formatPlanStepCompleted(event: PlanStepCompletedEvent): string {
	const icon = event.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
	return `  ${icon} step ${event.stepId}`;
}

function formatPlanStepFailed(event: PlanStepFailedEvent): string {
	const rework = event.reworkScheduled ? " (rework scheduled)" : "";
	return `  ${RED}✗${RESET} step ${event.stepId}: ${event.reason}${rework}`;
}

function formatPlanRework(event: PlanReworkEvent): string {
	return `  ${YELLOW}⟳${RESET} rework #${event.reworkAttempt}: ${event.focusAreas.join(", ")}`;
}

function formatPlanCompleted(event: PlanCompletedEvent): string {
	const icon = event.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
	return `${icon} Plan ${event.planId}: ${event.success ? "completed" : "failed"}`;
}

function formatCompactionEvent(event: RuntimeEvent): string {
	if (event.type === "compaction_started") {
		return `${YELLOW}Compacting context...${RESET}`;
	}
	const completed = event as CompactionCompletedEvent;
	const saved = completed.summary.estimatedTokensSaved;
	return `${GREEN}Compacted${RESET} (${saved} tokens saved)`;
}

function formatPermissionEvent(event: RuntimeEvent): string {
	if (event.type === "permission_requested") {
		return formatPermissionPrompt(event as PermissionRequestedEvent);
	}
	// permission_resolved — no visible output needed
	return "";
}

function formatTextEvent(event: RuntimeEvent): string {
	if (event.type === "text_delta") {
		return (event as { content: string }).content;
	}
	// thinking_delta — not shown in print mode by default
	return "";
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatParams(params: Readonly<Record<string, unknown>>): string {
	const entries = Object.entries(params);
	if (entries.length === 0) return "";
	const summary = entries
		.slice(0, 3)
		.map(([k, v]) => `${k}=${truncate(String(v), 30)}`)
		.join(", ");
	return entries.length > 3 ? `${summary} ...` : summary;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 1)}…`;
}
