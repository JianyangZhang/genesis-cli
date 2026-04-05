/**
 * Event-to-layout accumulator — builds TuiScreenLayout from RuntimeEvents.
 *
 * Maintains internal state as events are pushed, and produces snapshots
 * of the current screen layout on demand. No I/O.
 */

import type { RuntimeEvent, SessionState } from "@genesis-cli/runtime";
import { initialInteractionState, reduceInteractionState } from "../services/interaction-state.js";
import type { InteractionPhase } from "../types/index.js";
import type {
	ConversationLine,
	HeaderRegion,
	StatusLineRegion,
	ToolCallDisplayStatus,
	TuiScreenLayout,
} from "./tui-layout.js";

// ---------------------------------------------------------------------------
// Accumulator interface
// ---------------------------------------------------------------------------

export interface LayoutAccumulator {
	/** Push a new event into the accumulator. */
	push(event: RuntimeEvent): void;

	/** Append a locally generated transcript line, such as user input. */
	appendText(line: Omit<Extract<ConversationLine, { type: "text" }>, "type">): void;

	/** Get the current screen layout snapshot. */
	snapshot(): TuiScreenLayout;

	/** Clear the conversation area (e.g. on /clear). */
	reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLayoutAccumulator(sessionState: SessionState | (() => SessionState)): LayoutAccumulator {
	let interactionState = initialInteractionState();
	const lines: ConversationLine[] = [];
	// Track active tool calls so we can update their status on completion.
	const activeToolCalls = new Map<string, number>(); // toolCallId → index in lines[]
	const getSessionState = typeof sessionState === "function" ? sessionState : () => sessionState;

	return {
		push(event: RuntimeEvent): void {
			interactionState = reduceInteractionState(interactionState, event);
			accumulateEvent(event, lines, activeToolCalls);
		},

		appendText(line): void {
			appendOrExtendText(lines, line.role, line.content, line.timestamp, line.authorName);
		},

		snapshot(): TuiScreenLayout {
			return buildLayout(getSessionState(), interactionState, lines);
		},

		reset(): void {
			lines.length = 0;
			activeToolCalls.clear();
			interactionState = initialInteractionState();
		},
	};
}

// ---------------------------------------------------------------------------
// Event accumulation
// ---------------------------------------------------------------------------

function accumulateEvent(event: RuntimeEvent, lines: ConversationLine[], activeToolCalls: Map<string, number>): void {
	switch (event.category) {
		case "text": {
			if (event.type === "text_delta") {
				appendOrExtendText(
					lines,
					"assistant",
					(event as { content: string }).content,
					event.timestamp,
					"Assistant",
				);
			}
			break;
		}

		case "tool": {
			switch (event.type) {
				case "tool_started": {
					const line: ConversationLine = {
						type: "tool_call",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						status: "running" as ToolCallDisplayStatus,
					};
					activeToolCalls.set(event.toolCallId, lines.length);
					lines.push(line);
					break;
				}
				case "tool_completed": {
					const idx = activeToolCalls.get(event.toolCallId);
					if (idx !== undefined) {
						const existing = lines[idx] as {
							type: "tool_call";
							toolName: string;
							toolCallId: string;
							status: ToolCallDisplayStatus;
							durationMs?: number;
							summary?: string;
						};
						lines[idx] = {
							...existing,
							status: event.status === "success" ? "success" : "failure",
							durationMs: event.durationMs,
							summary: event.result ? truncate(event.result, 80) : undefined,
						};
						activeToolCalls.delete(event.toolCallId);
					}
					break;
				}
				case "tool_denied": {
					const idx2 = activeToolCalls.get(event.toolCallId);
					if (idx2 !== undefined) {
						const existing = lines[idx2] as {
							type: "tool_call";
							toolName: string;
							toolCallId: string;
							status: ToolCallDisplayStatus;
						};
						lines[idx2] = { ...existing, status: "denied" };
						activeToolCalls.delete(event.toolCallId);
					}
					break;
				}
				// tool_update — no layout change needed
			}
			break;
		}

		case "plan": {
			switch (event.type) {
				case "plan_step_started":
					lines.push({
						type: "plan_step",
						planId: event.planId,
						stepId: event.stepId,
						description: event.stepDescription,
						status: "in_progress",
					});
					break;
				case "plan_step_completed": {
					updatePlanStepStatus(lines, event.stepId, event.success ? "completed" : "failed");
					break;
				}
				case "plan_step_failed":
					updatePlanStepStatus(lines, event.stepId, "failed");
					break;
			}
			break;
		}

		case "permission": {
			if (event.type === "permission_requested") {
				lines.push({
					type: "permission_prompt",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					riskLevel: event.riskLevel,
					reason: (event as { reason?: string }).reason,
					targetPath: (event as { targetPath?: string }).targetPath,
				});
				break;
			}
			if (event.type === "permission_resolved") {
				lines.push({
					type: "permission_result",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					decision: event.decision,
				});
			}
			break;
		}

		// session, compaction — no conversation lines needed
	}
}

// ---------------------------------------------------------------------------
// Layout construction
// ---------------------------------------------------------------------------

function buildLayout(
	sessionState: SessionState,
	interactionState: { phase: InteractionPhase; activeToolName: string | null },
	lines: ConversationLine[],
): TuiScreenLayout {
	return {
		mode: "interactive",
		header: buildHeader(sessionState),
		conversation: { lines: [...lines] },
		statusLine: buildStatusLine(sessionState, interactionState),
	};
}

function buildHeader(state: SessionState): HeaderRegion {
	return {
		modelName: state.model.displayName ?? state.model.id,
		sessionStatus: state.status,
		planStatus: state.planSummary ? `Plan: ${state.planSummary.goal}` : null,
	};
}

function buildStatusLine(
	state: SessionState,
	interaction: { phase: InteractionPhase; activeToolName: string | null },
): StatusLineRegion {
	let planProgress: string | null = null;
	if (state.planSummary) {
		planProgress = `Plan: ${state.planSummary.completedSteps}/${state.planSummary.stepCount}`;
	}

	return {
		phase: interaction.phase,
		activeTool: interaction.activeToolName,
		planProgress,
		scrollPosition: null,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendOrExtendText(
	lines: ConversationLine[],
	role: "user" | "assistant",
	content: string,
	timestamp: number,
	authorName?: string,
): void {
	const last = lines[lines.length - 1];
	if (last && last.type === "text" && last.role === role) {
		// Extend the existing text line
		lines[lines.length - 1] = { ...last, content: last.content + content };
	} else {
		lines.push({ type: "text", role, content, timestamp, authorName });
	}
}

function updatePlanStepStatus(lines: ConversationLine[], stepId: string, status: "completed" | "failed"): void {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.type === "plan_step" && line.stepId === stepId) {
			lines[i] = { ...line, status };
			return;
		}
	}
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 1)}…`;
}
