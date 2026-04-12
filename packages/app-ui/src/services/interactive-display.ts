import { measureTerminalDisplayWidth, truncatePlainText } from "@pickle-pee/tui-core";
import { INTERACTIVE_THEME } from "./interactive-theme.js";

export function formatTranscriptUserLine(content: string): string {
	return `${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg} ${content} ${INTERACTIVE_THEME.reset}`;
}

export function formatTranscriptUserBlocks(content: string): readonly string[] {
	return content
		.split(/\n{2,}/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => formatTranscriptUserLine(part));
}

export function formatFullWidthTranscriptUserLine(content: string, width: number): string {
	const plain = content.replace(/\r?\n/g, " ");
	const visibleWidth = measureTerminalDisplayWidth(plain);
	const safeWidth = Math.max(1, width);
	const padded =
		visibleWidth >= safeWidth
			? truncatePlainText(plain, safeWidth)
			: `${plain}${" ".repeat(safeWidth - visibleWidth)}`;
	return `${INTERACTIVE_THEME.promptBg}${INTERACTIVE_THEME.userTranscriptFg}${padded}${INTERACTIVE_THEME.reset}`;
}

export function formatTranscriptAssistantLine(content: string): string {
	return `${INTERACTIVE_THEME.assistantBullet}⏺${INTERACTIVE_THEME.reset} ${content}`;
}

export function formatInteractiveInfoLine(content: string): string {
	return `${INTERACTIVE_THEME.brand}${content}${INTERACTIVE_THEME.reset}`;
}

export function formatInteractiveWarningLine(content: string): string {
	return `${INTERACTIVE_THEME.warning}${content}${INTERACTIVE_THEME.reset}`;
}

export function formatInteractiveErrorLine(content: string): string {
	return `${INTERACTIVE_THEME.error}${INTERACTIVE_THEME.bold}Error:${INTERACTIVE_THEME.reset} ${INTERACTIVE_THEME.error}${content}${INTERACTIVE_THEME.reset}`;
}

export function formatInteractiveErrorDetailLine(content: string): string {
	return `${INTERACTIVE_THEME.error}${content}${INTERACTIVE_THEME.reset}`;
}

export function formatInteractivePromptBuffer(content: string, plain = false): string {
	if (plain) return content;
	return content;
}

export function formatInteractiveInputSeparator(width: number): string {
	return `${INTERACTIVE_THEME.muted}${"─".repeat(Math.max(1, width))}${INTERACTIVE_THEME.reset}`;
}

export function computeInteractiveFooterSeparatorWidth(terminalWidth: number): number {
	return Math.max(20, terminalWidth);
}
