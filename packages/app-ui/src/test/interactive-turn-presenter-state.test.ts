import { describe, expect, it } from "vitest";
import {
	beginInteractiveTurn,
	beginInteractiveTurnFeedback,
	clearInteractiveToolCall,
	clearInteractiveTurnNotice,
	completeInteractiveTurn,
	currentInteractiveTurnElapsedMs,
	currentInteractiveTurnUsage,
	drainQueuedInteractiveInputs,
	findInteractiveToolParameters,
	initialInteractiveTurnPresenterState,
	preserveThinkingNoticeForQueuedBacklog,
	queueInteractiveInput,
	registerInteractiveToolCall,
	setInteractiveTurnNotice,
	summarizeActiveInteractiveToolLabel,
	tickInteractiveTurnNoticeAnimation,
	updateInteractiveTurnUsage,
} from "../services/interactive-turn-presenter-state.js";

describe("interactive turn presenter state", () => {
	it("tracks turn notice, usage, and completion totals", () => {
		let state = beginInteractiveTurn(initialInteractiveTurnPresenterState(), 1_000);
		expect(state.notice).toBe("thinking");
		expect(currentInteractiveTurnElapsedMs(state, 3_500)).toBe(2_500);

		state = updateInteractiveTurnUsage(
			state,
			{ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
			false,
		);
		state = updateInteractiveTurnUsage(
			state,
			{ input: 0, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			true,
		);
		expect(currentInteractiveTurnUsage(state)).toEqual({
			input: 0,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
		});

		state = setInteractiveTurnNotice(state, "responding");
		expect(state.notice).toBe("responding");

		state = tickInteractiveTurnNoticeAnimation(state);
		expect(state.noticeAnimationFrame).toBe(1);

		state = completeInteractiveTurn(state);
		expect(state.notice).toBeNull();
		expect(state.lastTurnUsage?.totalTokens).toBe(30);
		expect(state.sessionUsageTotals.totalTokens).toBe(30);

		state = clearInteractiveTurnNotice(state);
		expect(state.notice).toBeNull();
	});

	it("tracks queued inputs and preserves thinking state for backlog", () => {
		let state = initialInteractiveTurnPresenterState();
		state = queueInteractiveInput(state, "first");
		state = queueInteractiveInput(state, "second");
		expect(state.queuedInputs).toEqual(["first", "second"]);

		const drained = drainQueuedInteractiveInputs(state);
		expect(drained.batch).toBe("first\n\nsecond");
		expect(drained.state.queuedInputs).toEqual([]);

		let noticeState = setInteractiveTurnNotice(
			beginInteractiveTurnFeedback(initialInteractiveTurnPresenterState(), 10),
			"responding",
		);
		noticeState = preserveThinkingNoticeForQueuedBacklog(noticeState, 20);
		expect(noticeState.notice).toBe("thinking");

		const idlePreserved = preserveThinkingNoticeForQueuedBacklog(initialInteractiveTurnPresenterState(), 50);
		expect(idlePreserved.notice).toBe("thinking");
		expect(idlePreserved.startedAt).toBe(50);
	});

	it("tracks active tool status inside presenter state", () => {
		let state = initialInteractiveTurnPresenterState();
		state = registerInteractiveToolCall(state, {
			toolCallId: "call-1",
			toolName: "read",
			parameters: { file_path: "/tmp/readme.md" },
		});
		expect(summarizeActiveInteractiveToolLabel(state)).toBe("Running Read(readme.md)");
		expect(findInteractiveToolParameters(state, "call-1")).toEqual({ file_path: "/tmp/readme.md" });

		state = registerInteractiveToolCall(state, {
			toolCallId: "call-2",
			toolName: "bash",
			parameters: { command: "pwd" },
		});
		expect(summarizeActiveInteractiveToolLabel(state)).toBe("Running 2 tools");

		state = clearInteractiveToolCall(state, "call-1");
		expect(summarizeActiveInteractiveToolLabel(state)).toBe("Running Bash(pwd)");
	});
});
