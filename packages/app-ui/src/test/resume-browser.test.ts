import { describe, expect, it } from "vitest";
import {
	formatResumeBrowserTranscriptBlocks,
	measureResumeBrowserSelectedLineOffset,
	moveResumeBrowserSelection,
} from "../services/resume-browser.js";

describe("resume browser formatter", () => {
	it("formats recent-session browsing and preview hints", () => {
		const blocks = formatResumeBrowserTranscriptBlocks(
			{
			query: "",
			selectedIndex: 0,
			previewExpanded: false,
			loading: false,
			hits: [
				{
					entry: {
						title: "README 发布说明补充",
						updatedAt: 1,
						recoveryData: {
							sessionId: { value: "session-a" },
							model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "README 发布说明",
								firstPrompt: "README 发布说明补充",
								messageCount: 2,
								fileSizeBytes: 128,
								recentMessages: [
									{ role: "user", text: "README 发布说明补充" },
									{ role: "assistant", text: "我先补充安装段落。" },
								],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
						},
					},
					headline: "README 发布说明补充",
					snippet: "README 发布说明",
					matchSource: "recent",
				},
			],
			},
			61_000,
		);

		expect(blocks[0]).toContain("Resume Session");
		expect(blocks[0]).toContain("Search: Type to search recent sessions...");
		expect(blocks[0]).toContain("1m ago");
		expect(blocks[0]).toContain("Goal: README 发布说明");
		expect(blocks[0]).toContain("User: README 发布说明补充");
		expect(blocks[0]).toContain("Ctrl+V preview");
	});

	it("formats a preview section for the selected hit", () => {
		const blocks = formatResumeBrowserTranscriptBlocks(
			{
			query: "README",
			selectedIndex: 0,
			previewExpanded: true,
			loading: false,
			hits: [
				{
					entry: {
						title: "README 发布说明补充",
						updatedAt: 1,
						recoveryData: {
							sessionId: { value: "session-a" },
							model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
							toolSet: ["read"],
							planSummary: null,
							compactionSummary: null,
							metadata: {
								summary: "README 发布说明",
								firstPrompt: "README 发布说明补充",
								messageCount: 2,
								fileSizeBytes: 128,
								recentMessages: [
									{ role: "user", text: "README 发布说明补充" },
									{ role: "assistant", text: "我先补充安装段落。" },
								],
							},
							taskState: { status: "idle", currentTaskId: null, startedAt: null },
						},
					},
					headline: "README 发布说明补充",
					snippet: "README 发布说明补充",
					matchSource: "title",
				},
			],
			},
			61_000,
		);

		expect(blocks[0]).toContain("Preview");
		expect(blocks[0]).toContain("Updated: 1m ago");
		expect(blocks[0]).toContain("Goal: README 发布说明");
		expect(blocks[0]).toContain("Match source: title");
		expect(blocks[0]).toContain("Assistant: 我先补充安装段落。");
	});

	it("measures the selected line offset for viewport follow scrolling", () => {
		const offset = measureResumeBrowserSelectedLineOffset(
			{
				query: "",
				selectedIndex: 1,
				previewExpanded: false,
				loading: false,
				hits: [
					{
						entry: {
							title: "first",
							updatedAt: 1,
							recoveryData: {
								sessionId: { value: "session-a" },
								model: { id: "glm-5.1", provider: "zai" },
								toolSet: [],
								planSummary: null,
								compactionSummary: null,
								metadata: { summary: "first goal", firstPrompt: "first prompt", messageCount: 1, fileSizeBytes: 1, recentMessages: [] },
								taskState: { status: "idle", currentTaskId: null, startedAt: null },
							},
						},
						headline: "first",
						snippet: "first goal",
						matchSource: "recent",
					},
					{
						entry: {
							title: "second",
							updatedAt: 1,
							recoveryData: {
								sessionId: { value: "session-b" },
								model: { id: "glm-5.1", provider: "zai" },
								toolSet: [],
								planSummary: null,
								compactionSummary: null,
								metadata: { summary: "second goal", firstPrompt: "second prompt", messageCount: 1, fileSizeBytes: 1, recentMessages: [] },
								taskState: { status: "idle", currentTaskId: null, startedAt: null },
							},
						},
						headline: "second",
						snippet: "second goal",
						matchSource: "recent",
					},
				],
			},
			61_000,
		);

		expect(offset).toBeGreaterThan(4);
	});

	it("clamps selection moves inside the result range", () => {
		expect(moveResumeBrowserSelection(0, -1, 3)).toBe(0);
		expect(moveResumeBrowserSelection(0, 1, 3)).toBe(1);
		expect(moveResumeBrowserSelection(2, 1, 3)).toBe(2);
	});
});
