/**
 * TUI renderer — converts layout models to ANSI escape sequences.
 *
 * Pure functions — no I/O, no terminal state mutation.
 * Produces strings that the mode handler writes to stdout.
 *
 * Uses basic ANSI escape sequences only, no external TUI framework.
 */

import type {
	ConversationLine,
	HeaderRegion,
	StatusLineRegion,
	ToolCallDisplayStatus,
	TuiScreenLayout,
} from "./tui-layout.js";

// ---------------------------------------------------------------------------
// ANSI constants
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BG_DARK = "\x1b[48;5;236m";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render the full TUI screen layout as an ANSI string. */
export function renderScreen(layout: TuiScreenLayout, terminalWidth: number): string {
	const parts: string[] = [];

	// Header
	parts.push(renderHeader(layout.header, terminalWidth));

	// Conversation
	parts.push(renderConversation(layout.conversation.lines, terminalWidth));

	// Status line
	parts.push(renderStatusLine(layout.statusLine, terminalWidth));

	return parts.join("\n");
}

/** Render the header bar. */
export function renderHeader(header: HeaderRegion, width: number): string {
	const model = `${BOLD}${header.modelName}${RESET}`;
	const status = `${DIM}${header.sessionStatus}${RESET}`;
	const plan = header.planStatus ? `${CYAN}${header.planStatus}${RESET}` : "";

	const content = [model, status, plan].filter(Boolean).join(" │ ");
	return truncateToWidth(content, width);
}

/** Render the status line bar at the bottom. */
export function renderStatusLine(status: StatusLineRegion, width: number): string {
	const icon = phaseToIcon(status.phase);
	const phaseText = phaseLabel(status.phase);
	const tool = status.activeTool ? ` │ ${CYAN}${status.activeTool}${RESET}` : "";
	const plan = status.planProgress ? ` │ ${YELLOW}${status.planProgress}${RESET}` : "";

	const content = `${BG_DARK}${icon} ${phaseText}${tool}${plan}${RESET}`;
	return truncateToWidth(content, width);
}

// ---------------------------------------------------------------------------
// Conversation rendering
// ---------------------------------------------------------------------------

function renderConversation(lines: readonly ConversationLine[], width: number): string {
	return lines.map((line) => renderConversationLine(line, width)).join("\n");
}

function renderConversationLine(line: ConversationLine, width: number): string {
	switch (line.type) {
		case "text":
			return renderTextLine(line);
		case "tool_call":
			return renderToolCallLine(line);
		case "permission_prompt":
			return renderPermissionLine(line);
		case "permission_result":
			return renderPermissionResultLine(line);
		case "plan_step":
			return renderPlanStepLine(line);
		case "divider":
			return `${DIM}${"─".repeat(Math.min(width, 40))}${RESET}`;
	}
}

function renderTextLine(line: { readonly role: "user" | "assistant"; readonly content: string }): string {
	const label = line.role === "user" ? `${BOLD}You:${RESET}` : `${GREEN}Assistant:${RESET}`;
	return `${label} ${line.content}`;
}

function renderToolCallLine(line: {
	readonly toolName: string;
	readonly status: ToolCallDisplayStatus;
	readonly durationMs?: number;
	readonly summary?: string;
}): string {
	const icon = toolStatusIcon(line.status);
	const name = `${CYAN}${line.toolName}${RESET}`;
	const duration = line.durationMs ? ` (${line.durationMs}ms)` : "";
	const summary = line.summary ? ` — ${truncate(line.summary, 60)}` : "";
	return `  ${icon} ${name}${duration}${summary}`;
}

function renderPermissionLine(line: {
	readonly toolName: string;
	readonly riskLevel: string;
	readonly reason?: string;
	readonly targetPath?: string;
}): string {
	const path = line.targetPath ? ` ${DIM}${line.targetPath}${RESET}` : "";
	const reason = line.reason ? ` — ${truncate(line.reason, 60)}` : "";
	return `${YELLOW}⚠ Permission required${RESET} (${line.riskLevel}): ${line.toolName}${path}${reason}`;
}

function renderPermissionResultLine(line: {
	readonly toolName: string;
	readonly decision: "allow" | "allow_for_session" | "allow_once" | "deny";
}): string {
	const decision =
		line.decision === "allow_for_session"
			? "allowed (session)"
			: line.decision === "allow_once"
				? "allowed (once)"
				: line.decision === "deny"
					? "denied"
					: "allowed";
	return `${DIM}Permission ${decision}:${RESET} ${CYAN}${line.toolName}${RESET}`;
}

function renderPlanStepLine(line: { readonly description: string; readonly status: string }): string {
	const icon = planStepIcon(line.status);
	return `  ${icon} ${line.description}`;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

/** Move cursor up N lines. */
export function ansiMoveUp(lines: number): string {
	return `${ESC}${lines}A`;
}

export function ansiMoveRight(columns: number): string {
	return `${ESC}${columns}C`;
}

export function ansiMoveLeft(columns: number): string {
	return `${ESC}${columns}D`;
}

/** Clear the current line. */
export function ansiClearLine(): string {
	return `${ESC}2K\r`;
}

/** Reset cursor to the beginning of the line. */
export function ansiResetCursor(): string {
	return "\r";
}

/** Save cursor position. */
export function ansiSaveCursor(): string {
	return `${ESC}s`;
}

/** Restore cursor position. */
export function ansiRestoreCursor(): string {
	return `${ESC}u`;
}

/** Clear from cursor to end of screen. */
export function ansiClearBelow(): string {
	return `${ESC}J`;
}

/** Hide the cursor. */
export function ansiHideCursor(): string {
	return `${ESC}?25l`;
}

/** Show the cursor. */
export function ansiShowCursor(): string {
	return `${ESC}?25h`;
}

export function ansiEnterAlternateScreen(): string {
	return `${ESC}?1049h`;
}

export function ansiExitAlternateScreen(): string {
	return `${ESC}?1049l`;
}

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function phaseToIcon(phase: string): string {
	switch (phase) {
		case "idle":
			return `${GREEN}●${RESET}`;
		case "thinking":
			return `${YELLOW}◐${RESET}`;
		case "streaming":
			return `${GREEN}◉${RESET}`;
		case "tool_executing":
			return `${CYAN}⚙${RESET}`;
		case "waiting_permission":
			return `${YELLOW}⚠${RESET}`;
		case "compacting":
			return `${MAGENTA}⟳${RESET}`;
		default:
			return "·";
	}
}

function phaseLabel(phase: string): string {
	switch (phase) {
		case "idle":
			return "Ready";
		case "thinking":
			return "Thinking...";
		case "streaming":
			return "Streaming";
		case "tool_executing":
			return "Executing tool";
		case "waiting_permission":
			return "Awaiting permission";
		case "compacting":
			return "Compacting";
		default:
			return phase;
	}
}

function toolStatusIcon(status: ToolCallDisplayStatus): string {
	switch (status) {
		case "running":
			return `${YELLOW}⠋${RESET}`;
		case "success":
			return `${GREEN}✓${RESET}`;
		case "failure":
			return `${RED}✗${RESET}`;
		case "denied":
			return `${RED}⊘${RESET}`;
	}
}

function planStepIcon(status: string): string {
	switch (status) {
		case "completed":
			return `${GREEN}✓${RESET}`;
		case "failed":
			return `${RED}✗${RESET}`;
		case "in_progress":
			return `${YELLOW}▸${RESET}`;
		case "skipped":
			return `${DIM}○${RESET}`;
		default:
			return "·";
	}
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

function truncateToWidth(text: string, maxWidth: number): string {
	// Strip ANSI for length calculation — approximate, good enough for P5.
	// Using String.fromCharCode(27) to avoid control character in regex literal.
	const ESC = String.fromCharCode(27);
	const ansiPattern = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");
	const stripped = text.replace(ansiPattern, "");
	if (stripped.length <= maxWidth) return text;
	// For simplicity, just return the text — truncation with ANSI is complex.
	return text;
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 1)}…`;
}
