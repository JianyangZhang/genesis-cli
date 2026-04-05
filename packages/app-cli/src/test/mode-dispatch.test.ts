import { describe, expect, it } from "vitest";
import { advanceWheelProbe, computeConversationViewport } from "../mode-dispatch.js";

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

describe("advanceWheelProbe", () => {
	it("flips after repeated dead-zone wheel probes", () => {
		const first = advanceWheelProbe(null, "wheeldown", 1000);
		expect(first.shouldFlip).toBe(false);
		const second = advanceWheelProbe(first.probe, "wheeldown", 1200);
		expect(second.shouldFlip).toBe(true);
	});

	it("resets the probe window after a long gap", () => {
		const first = advanceWheelProbe(null, "wheeldown", 1000);
		const second = advanceWheelProbe(first.probe, "wheeldown", 2000);
		expect(second.shouldFlip).toBe(false);
		expect(second.probe.count).toBe(1);
	});
});
