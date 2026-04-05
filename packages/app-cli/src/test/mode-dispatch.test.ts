import { describe, expect, it } from "vitest";
import { formatTranscriptSpeakerLine } from "../mode-dispatch.js";

describe("formatTranscriptSpeakerLine", () => {
	it("formats a transcript entry with timestamp and author", () => {
		const line = formatTranscriptSpeakerLine("Assistant", "Hello", 1000);
		expect(line).toContain("Assistant");
		expect(line).toContain("Hello");
		expect(line).toMatch(/^\d{2}:\d{2}:\d{2} Assistant Hello$/);
	});
});
