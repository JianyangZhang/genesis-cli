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
	parts.push(renderRule(terminalWidth));

	// Conversation
	parts.push(renderConversation(layout.conversation.lines, terminalWidth));

	// Status line
	parts.push(renderStatusLine(layout.statusLine, terminalWidth));

	return parts.join("\n");
}

/** Render the header bar. */
export function renderHeader(header: HeaderRegion, width: number): string {
	const title = `${BOLD}Genesis CLI${RESET}`;
	const model = `${BOLD}${header.modelName}${RESET}`;
	const status = `${DIM}${header.sessionStatus}${RESET}`;
	const plan = header.planStatus ? `${CYAN}${header.planStatus}${RESET}` : "";

	const content = [title, model, status, plan].filter(Boolean).join(" │ ");
	return truncateToWidth(content, width);
}

/** Render the status line bar at the bottom. */
export function renderStatusLine(status: StatusLineRegion, width: number): string {
	const icon = phaseToIcon(status.phase);
	const phaseText = phaseLabel(status.phase);
	const tool = status.activeTool ? ` │ ${CYAN}${status.activeTool}${RESET}` : "";
	const plan = status.planProgress ? ` │ ${YELLOW}${status.planProgress}${RESET}` : "";
	const scroll = status.scrollPosition ? ` │ ${DIM}${status.scrollPosition}${RESET}` : "";
	const hint =
		status.phase === "waiting_permission"
			? ` │ ${DIM}y once · Y session · n deny${RESET}`
			: ` │ ${DIM}/help · /exit · ↑↓ history · wheel/PgUp/PgDn scroll${RESET}`;

	const content = `${BG_DARK}${icon} ${phaseText}${tool}${plan}${scroll}${hint}${RESET}`;
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
			return renderTextLine(line, width);
		case "tool_call":
			return renderToolCallLine(line);
		case "permission_prompt":
			return renderPermissionLine(line, width);
		case "permission_result":
			return renderPermissionResultLine(line);
		case "plan_step":
			return renderPlanStepLine(line);
		case "divider":
			return `${DIM}${"─".repeat(Math.min(width, 40))}${RESET}`;
	}
}

function renderTextLine(
	line: {
		readonly role: "user" | "assistant";
		readonly content: string;
		readonly timestamp: number;
		readonly authorName?: string;
	},
	width: number,
): string {
	const timestamp = formatTimestamp(line.timestamp);
	const authorPlain = line.authorName?.trim() || (line.role === "user" ? "You" : "Assistant");
	const metaPlain = `${timestamp} ${authorPlain}`;
	const metaAnsi =
		line.role === "user"
			? `${DIM}${timestamp}${RESET} ${BOLD}${authorPlain}${RESET}`
			: `${DIM}${timestamp}${RESET} ${GREEN}${authorPlain}${RESET}`;

	const available = Math.max(10, width - (metaPlain.length + 1));
	const chunks = wrapPlainText(line.content, available);
	const indent = " ".repeat(metaPlain.length + 1);
	return chunks.map((chunk, i) => (i === 0 ? `${metaAnsi} ${chunk}` : `${indent}${chunk}`)).join("\n");
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

function renderPermissionLine(
	line: {
		readonly toolName: string;
		readonly riskLevel: string;
		readonly reason?: string;
		readonly targetPath?: string;
	},
	width: number,
): string {
	const path = line.targetPath ? ` ${DIM}${line.targetPath}${RESET}` : "";
	const first = `${YELLOW}⚠ Permission required${RESET} (${line.riskLevel}): ${line.toolName}${path}`;
	const details: string[] = [];
	if (line.reason && line.reason.trim().length > 0) {
		const wrapped = wrapPlainText(line.reason.trim(), Math.max(20, width - 10));
		details.push(`  ${DIM}Reason:${RESET} ${truncate(wrapped[0] ?? "", 200)}`);
		for (const extra of wrapped.slice(1)) {
			details.push(`         ${truncate(extra, 200)}`);
		}
	}
	details.push(`  ${DIM}Reply:${RESET} y once · Y session · n deny  ${DIM}(Ctrl+C to deny)${RESET}`);
	return [first, ...details].join("\n");
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

export function ansiCursorHome(): string {
	return `${ESC}H`;
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

export function ansiEnableMouseTracking(): string {
	return `${ESC}?1000h${ESC}?1002h${ESC}?1006h`;
}

export function ansiDisableMouseTracking(): string {
	return `${ESC}?1006l${ESC}?1002l${ESC}?1000l`;
}

export function ansiEnableFocusReporting(): string {
	return `${ESC}?1004h`;
}

export function ansiDisableFocusReporting(): string {
	return `${ESC}?1004l`;
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
	if (measureDisplayWidth(stripAnsi(text)) <= maxWidth) return text;
	const ellipsis = "…";
	const result: string[] = [];
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\x1b") {
			const seq = matchAnsiSequence(text, i);
			if (seq) {
				result.push(seq.value);
				i = seq.end - 1;
				continue;
			}
		}
		const charWidth = charDisplayWidth(ch);
		if (width + charWidth + 1 > maxWidth) {
			result.push(ellipsis);
			break;
		}
		result.push(ch);
		width += charWidth;
	}
	if (!result[result.length - 1]?.endsWith(RESET)) {
		result.push(RESET);
	}
	return result.join("");
}

function truncate(str: string, max: number): string {
	if (measureDisplayWidth(str) <= max) return str;
	let width = 0;
	let out = "";
	for (const ch of str) {
		const charWidth = charDisplayWidth(ch);
		if (width + charWidth + 1 > max) {
			return `${out}…`;
		}
		out += ch;
		width += charWidth;
	}
	return out;
}

function wrapPlainText(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	const normalized = text.replace(/\r\n/g, "\n");
	if (normalized.length === 0) return [""];
	for (const ch of normalized) {
		if (ch === "\n") {
			lines.push(current.trimEnd());
			current = "";
			currentWidth = 0;
			continue;
		}
		const charWidth = charDisplayWidth(ch);
		if (currentWidth + charWidth > width && current.length > 0) {
			lines.push(current.trimEnd());
			current = ch === " " ? "" : ch;
			currentWidth = ch === " " ? 0 : charWidth;
			continue;
		}
		current += ch;
		currentWidth += charWidth;
	}
	lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [""];
}

function renderRule(width: number): string {
	const n = Math.max(0, Math.min(width, 200));
	return `${DIM}${"─".repeat(n)}${RESET}`;
}

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const hours = `${date.getHours()}`.padStart(2, "0");
	const minutes = `${date.getMinutes()}`.padStart(2, "0");
	const seconds = `${date.getSeconds()}`.padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

function stripAnsi(text: string): string {
	return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

function matchAnsiSequence(text: string, start: number): { value: string; end: number } | null {
	const remainder = text.slice(start);
	const match = new RegExp(`^${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`).exec(remainder);
	if (!match) return null;
	return {
		value: match[0],
		end: start + match[0].length,
	};
}

function measureDisplayWidth(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += charDisplayWidth(ch);
	}
	return width;
}

function charDisplayWidth(ch: string): number {
	if (ch === "\t") return 4;
	if (ch <= "\u001f" || ch === "\u007f") return 0;
	const codePoint = ch.codePointAt(0) ?? 0;
	if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
	if (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2329 && codePoint <= 0x232a) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff)
	) {
		return 2;
	}
	return 1;
}
