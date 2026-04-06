import { describe, expect, it } from "vitest";
import { computePromptCursorColumn } from "../index.js";

describe("composer metrics", () => {
	it("positions the cursor after full-width input correctly", () => {
		expect(computePromptCursorColumn("genesis> ", "你好", 2)).toBe(13);
		expect(computePromptCursorColumn("genesis> ", "hello", 5)).toBe(14);
	});

	it("positions the cursor correctly for mixed-width input", () => {
		expect(computePromptCursorColumn("genesis> ", "a你😊", 4)).toBe(14);
	});
});
