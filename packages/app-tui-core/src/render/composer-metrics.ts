import { measureTerminalDisplayWidth } from "./text-primitives.js";

export function computePromptCursorColumn(prompt: string, buffer: string, cursor: number): number {
	return measureTerminalDisplayWidth(prompt) + measureTerminalDisplayWidth(buffer.slice(0, cursor));
}
