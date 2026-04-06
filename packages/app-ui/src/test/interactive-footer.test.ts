import { describe, expect, it } from "vitest";
import { buildInteractiveFooterLeadingLines, formatTurnNotice } from "../services/interactive-footer.js";

describe("interactive footer services", () => {
	it("formats turn notices with timing, usage, and queued metadata", () => {
		expect(formatTurnNotice("thinking", { animationFrame: 0 })).toContain("Thinking.");
		expect(formatTurnNotice("thinking", { elapsedMs: 2500 })).toContain("2s");
		expect(formatTurnNotice("responding", { showPendingOutputIndicator: true })).toContain("↓");
		expect(formatTurnNotice("tool", { toolLabel: "Running Bash(pwd)", queuedCount: 2 })).toContain("2 queued");
	});

	it("builds footer leading lines from usage, details, and queued prompts", () => {
		const lines = buildInteractiveFooterLeadingLines({
			terminalWidth: 80,
			turnNotice: null,
			lastTurnUsage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
			sessionUsage: { input: 2400, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: 3000 },
			detailPanelSummary: "2 files changed",
			detailPanelExpanded: true,
			detailPanelLines: ["- file-a.ts", "- file-b.ts"],
			queuedInputs: ["follow-up question"],
			truncateText: (text) => text,
		});

		expect(lines.some((line) => line.includes("Last turn"))).toBe(true);
		expect(lines.some((line) => line.includes("Session"))).toBe(true);
		expect(lines.some((line) => line.includes("2 files changed"))).toBe(true);
		expect(lines.some((line) => line.includes("Queued"))).toBe(true);
	});
});
