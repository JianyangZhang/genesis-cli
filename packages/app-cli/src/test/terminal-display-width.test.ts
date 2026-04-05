import { describe, expect, it } from "vitest";
import { computePromptCursorColumn } from "../mode-dispatch.js";
import { measureTerminalDisplayWidth } from "../terminal-display-width.js";

describe("measureTerminalDisplayWidth", () => {
	it("counts CJK as double-width", () => {
		expect(measureTerminalDisplayWidth("hello")).toBe(5);
		expect(measureTerminalDisplayWidth("你好")).toBe(4);
	});
});

describe("computePromptCursorColumn", () => {
	it("positions the cursor after full-width input correctly", () => {
		expect(computePromptCursorColumn("genesis> ", "你好", 2)).toBe(13);
		expect(computePromptCursorColumn("genesis> ", "hello", 5)).toBe(14);
	});
});
