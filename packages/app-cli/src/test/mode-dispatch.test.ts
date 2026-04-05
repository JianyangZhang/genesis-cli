import { describe, expect, it } from "vitest";
import { computeConversationViewport } from "../mode-dispatch.js";

describe("computeConversationViewport", () => {
	it("reserves rows for header, divider, status line, and prompt", () => {
		const viewport = computeConversationViewport(20, 10, 0);
		expect(viewport.maxConversationLines).toBe(6);
		expect(viewport.start).toBe(14);
		expect(viewport.end).toBe(20);
	});

	it("clamps scroll offset when browsing older transcript lines", () => {
		const viewport = computeConversationViewport(30, 12, 100);
		expect(viewport.maxOffset).toBe(22);
		expect(viewport.offset).toBe(22);
		expect(viewport.start).toBe(0);
		expect(viewport.end).toBe(8);
	});
});
