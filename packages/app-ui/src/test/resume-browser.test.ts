import { describe, expect, it } from "vitest";
import {
	beginResumeBrowserSearch,
	buildRestoredContextLines,
	buildResumeBrowserResumedLines,
	completeResumeBrowserSearch,
	createResumeBrowserState,
	formatResumeBrowserTranscriptBlocks,
	measureResumeBrowserSelectedLineOffset,
	moveResumeBrowserSelection,
	resolveRecentSessionDirectSelection,
	resolveResumeBrowserSelectedIndex,
	resolveResumeBrowserSubmitHit,
	summarizeResumeBrowserHit,
	toggleResumeBrowserPreviewState,
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
		expect(blocks[0]).toContain("recent sessions");
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

	it("prefers structured resumeSummary fields over legacy metadata", () => {
		const blocks = formatResumeBrowserTranscriptBlocks(
			{
				query: "",
				selectedIndex: 0,
				previewExpanded: true,
				loading: false,
				hits: [
					{
						entry: {
							title: "legacy title",
							updatedAt: 1,
							recoveryData: {
								sessionId: { value: "session-structured" },
								model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
								toolSet: ["read"],
								planSummary: null,
								compactionSummary: null,
								metadata: {
									summary: "legacy goal",
									firstPrompt: "legacy user prompt",
									messageCount: 3,
									fileSizeBytes: 128,
									recentMessages: [
										{ role: "user", text: "legacy user prompt" },
										{ role: "assistant", text: "legacy assistant response" },
									],
									resumeSummary: {
										title: "structured title",
										goal: "structured goal",
										userIntent: "structured user intent",
										assistantState: "structured assistant state",
										lastUserTurn: "structured latest user",
										lastAssistantTurn: "structured latest assistant",
										generatedAt: 1,
										source: "rule",
										version: 1,
									},
								},
								taskState: { status: "idle", currentTaskId: null, startedAt: null },
							},
						},
						headline: "structured title",
						snippet: "structured goal",
						matchSource: "recent",
					},
				],
			},
			61_000,
		);

		expect(blocks[0]).toContain("❯ structured title");
		expect(blocks[0]).toContain("Goal: structured goal");
		expect(blocks[0]).toContain("User: structured user intent");
		expect(blocks[0]).toContain("Assistant state: structured assistant state");
		expect(blocks[0]).not.toContain("legacy goal");
	});

	it("formats legacy sessions without showing unknown via unknown", () => {
		const blocks = formatResumeBrowserTranscriptBlocks(
			{
				query: "",
				selectedIndex: 0,
				previewExpanded: false,
				loading: false,
				hits: [
					{
						entry: {
							updatedAt: 1,
							recoveryData: {
								sessionId: { value: "64a5a2b6-c7b8-4b85-aaa7-96bef1f14641" },
								model: { id: "" as string, provider: "" as string },
								toolSet: [],
								planSummary: null,
								compactionSummary: null,
								metadata: {
									messageCount: 0,
									fileSizeBytes: 0,
									recentMessages: [],
								},
								taskState: { status: "idle", currentTaskId: null, startedAt: null },
							},
						},
						headline: "64a5a2b6-c7b8-4b85-aaa7-96bef1f14641",
						snippet: "64a5a2b6-c7b8-4b85-aaa7-96bef1f14641",
						matchSource: "recent",
					},
				],
			},
			61_000,
		);

		expect(blocks[0]).toContain("❯ Unnamed session");
		expect(blocks[0]).toContain("session 64a5a2b6");
		expect(blocks[0]).not.toContain("unknown via unknown");
	});

	it("keeps preview-off list entries compact even for very long summaries", () => {
		const longText =
			"**VS Code（Visual Studio Code）** 是由微软开发的一款免费、开源的代码编辑器。它于 2015 年首次发布，现已成为全球最受欢迎的代码编辑器之一。".repeat(
				4,
			);
		const blocks = formatResumeBrowserTranscriptBlocks(
			{
				query: "",
				selectedIndex: 0,
				previewExpanded: false,
				loading: false,
				hits: [
					{
						entry: {
							title: longText,
							updatedAt: 1,
							recoveryData: {
								sessionId: { value: "session-long" },
								model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
								toolSet: ["read"],
								planSummary: null,
								compactionSummary: null,
								metadata: {
									summary: longText,
									firstPrompt: "什么是 VS Code",
									messageCount: 2,
									fileSizeBytes: 128,
									recentMessages: [
										{ role: "user", text: "什么是 VS Code" },
										{ role: "assistant", text: longText },
									],
								},
								taskState: { status: "idle", currentTaskId: null, startedAt: null },
							},
						},
						headline: longText,
						snippet: longText,
						matchSource: "recent",
					},
				],
			},
			61_000,
		);

		expect(blocks[0]).toContain("preview off");
		expect(blocks[0]).toContain("❯ ");
		expect(blocks[0]).toContain("Goal: ");
		expect(blocks[0]).toContain("User: 什么是 VS Code");
		expect(blocks[0]).toContain("…");
		expect(blocks[0]).not.toContain("Preview\n");
		expect(blocks[0]).not.toContain(longText.repeat(2));
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
								metadata: {
									summary: "first goal",
									firstPrompt: "first prompt",
									messageCount: 1,
									fileSizeBytes: 1,
									recentMessages: [],
								},
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
								metadata: {
									summary: "second goal",
									firstPrompt: "second prompt",
									messageCount: 1,
									fileSizeBytes: 1,
									recentMessages: [],
								},
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

	it("formats restored context lines from recent messages", () => {
		const lines = buildRestoredContextLines({
			entry: {
				title: "resume target",
				updatedAt: 1,
				recoveryData: {
					sessionId: { value: "session-a" },
					model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
					toolSet: ["read"],
					planSummary: null,
					compactionSummary: null,
					metadata: {
						summary: "goal",
						firstPrompt: "user prompt",
						messageCount: 2,
						fileSizeBytes: 64,
						recentMessages: [
							{ role: "user", text: "本地所有修改，commit & push" },
							{ role: "assistant", text: "我会先检查工作区并整理提交内容。" },
						],
					},
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
			},
			headline: "resume target",
			snippet: "goal",
			matchSource: "recent",
		});

		expect(lines).toEqual([
			"Restored context:",
			"  User: 本地所有修改，commit & push",
			"  Assistant: 我会先检查工作区并整理提交内容。",
		]);
	});

	it("resolves direct recent-session selections by index, exact id, and unique prefix", () => {
		const first = {
			title: "first",
			updatedAt: 1,
			recoveryData: {
				sessionId: { value: "session-search-first" },
				model: { id: "glm-5.1", provider: "zai" },
				toolSet: [],
				planSummary: null,
				compactionSummary: null,
				metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
			},
		};
		const second = {
			title: "second",
			updatedAt: 2,
			recoveryData: {
				sessionId: { value: "session-search-second" },
				model: { id: "glm-5.1", provider: "zai" },
				toolSet: [],
				planSummary: null,
				compactionSummary: null,
				metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
			},
		};
		const displayed = [first, second];

		expect(resolveRecentSessionDirectSelection("#1", displayed, displayed)).toBe(first);
		expect(resolveRecentSessionDirectSelection("session-search-second", displayed, displayed)).toBe(second);
		expect(resolveRecentSessionDirectSelection("session-search-sec", displayed, displayed)).toBe(second);
		expect(resolveRecentSessionDirectSelection("session-search", displayed, displayed)).toBeNull();
	});

	it("restores selected resume-browser index by session id and clamps fallback", () => {
		const hits = [
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
						metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
				},
				headline: "first",
				snippet: "first",
				matchSource: "recent" as const,
			},
			{
				entry: {
					title: "second",
					updatedAt: 2,
					recoveryData: {
						sessionId: { value: "session-b" },
						model: { id: "glm-5.1", provider: "zai" },
						toolSet: [],
						planSummary: null,
						compactionSummary: null,
						metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
				},
				headline: "second",
				snippet: "second",
				matchSource: "recent" as const,
			},
		];

		expect(resolveResumeBrowserSelectedIndex(hits, "session-b", 0)).toBe(1);
		expect(resolveResumeBrowserSelectedIndex(hits, "missing", 99)).toBe(1);
		expect(resolveResumeBrowserSelectedIndex([], null, 5)).toBe(0);
	});

	it("summarizes resume-browser hits for debug logging", () => {
		const summary = summarizeResumeBrowserHit({
			entry: {
				title: "resume target",
				updatedAt: 1,
				recoveryData: {
					sessionId: { value: "session-debug" },
					model: { id: "glm-5.1", provider: "zai" },
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					metadata: {
						messageCount: 0,
						fileSizeBytes: 0,
						recentMessages: [],
						resumeSummary: { source: "rule", version: 2 } as never,
					},
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
			},
			headline: "resume headline",
			snippet: "resume snippet",
			matchSource: "summary",
		});

		expect(summary).toEqual({
			sessionId: "session-debug",
			matchSource: "summary",
			headline: "resume headline",
			title: "resume target",
			summarySource: "rule",
			summaryVersion: 2,
		});
		expect(summarizeResumeBrowserHit(null)).toBeNull();
	});

	it("builds resume-browser state transitions for open, search, result apply, and preview toggle", () => {
		const opened = createResumeBrowserState("abc");
		expect(opened).toEqual({
			query: "abc",
			hits: [],
			selectedIndex: 0,
			previewExpanded: false,
			loading: true,
		});

		const searching = beginResumeBrowserSearch(
			{ ...opened, loading: false, selectedIndex: 1, previewExpanded: true },
			"abcd",
		);
		expect(searching).toEqual({
			query: "abcd",
			hits: [],
			selectedIndex: 1,
			previewExpanded: true,
			loading: true,
		});

		const hits = [
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
						metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
				},
				headline: "first",
				snippet: "first",
				matchSource: "recent" as const,
			},
			{
				entry: {
					title: "second",
					updatedAt: 2,
					recoveryData: {
						sessionId: { value: "session-b" },
						model: { id: "glm-5.1", provider: "zai" },
						toolSet: [],
						planSummary: null,
						compactionSummary: null,
						metadata: { messageCount: 0, fileSizeBytes: 0, recentMessages: [] },
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
				},
				headline: "second",
				snippet: "second",
				matchSource: "recent" as const,
			},
		];

		const completed = completeResumeBrowserSearch(searching, "abcd", hits, "session-b", 0);
		expect(completed.selectedIndex).toBe(1);
		expect(completed.loading).toBe(false);
		expect(completed.query).toBe("abcd");
		expect(completed.hits).toEqual(hits);

		expect(toggleResumeBrowserPreviewState(completed).previewExpanded).toBe(false);
	});

	it("resolves resume-browser submit hit and formats resumed output lines", () => {
		const hit = {
			entry: {
				title: "resume target",
				updatedAt: 1,
				recoveryData: {
					sessionId: { value: "session-resume" },
					model: { id: "glm-5.1", provider: "zai" },
					toolSet: [],
					planSummary: null,
					compactionSummary: null,
					metadata: {
						messageCount: 2,
						fileSizeBytes: 64,
						recentMessages: [
							{ role: "user", text: "继续推进 /resume" },
							{ role: "assistant", text: "我会先恢复上下文。" },
						],
					},
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
			},
			headline: "resume target",
			snippet: "resume target",
			matchSource: "recent" as const,
		};
		expect(
			resolveResumeBrowserSubmitHit({
				query: "",
				hits: [hit],
				selectedIndex: 0,
				previewExpanded: false,
				loading: true,
			}),
		).toBeNull();
		expect(
			resolveResumeBrowserSubmitHit({
				query: "",
				hits: [hit],
				selectedIndex: 0,
				previewExpanded: false,
				loading: false,
			}),
		).toEqual(hit);
		expect(buildResumeBrowserResumedLines(hit)).toEqual([
			"Restored context:",
			"  User: 继续推进 /resume",
			"  Assistant: 我会先恢复上下文。",
			"Resumed: session-resume",
			"Next: continue this session, or /resume to view history again.",
		]);
	});
});
