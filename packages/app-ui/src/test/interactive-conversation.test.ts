import { describe, expect, it } from "vitest";
import {
	createInteractiveConversationState,
	materializeAssistantTranscriptBlock,
	mergeStreamingText,
} from "../services/interactive-conversation.js";

describe("interactive-conversation", () => {
	it("merges streaming text deltas without duplication", () => {
		expect(mergeStreamingText("你好", "好吗")).toBe("你好吗");
		expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
	});

	it("materializes assistant transcript blocks", () => {
		expect(materializeAssistantTranscriptBlock("hello")).toContain("hello");
		expect(materializeAssistantTranscriptBlock("   ")).toBeNull();
	});

	it("stores transcript state outside app-cli orchestration", () => {
		const state = createInteractiveConversationState();
		state.rememberTranscriptBlock("User: hi", true);
		state.mergeAssistantDelta("Assistant");
		state.mergeAssistantDelta(" reply");
		expect(state.hasAssistantBuffer()).toBe(true);
		expect(state.renderedTranscriptBlocks(["Welcome"])).toHaveLength(4);
		expect(state.consumeAssistantBuffer()).toBe("Assistantreply");
		expect(state.hasAssistantBuffer()).toBe(false);
	});
});
