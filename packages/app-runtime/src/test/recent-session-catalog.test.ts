import { describe, expect, it } from "vitest";
import { shouldReloadRecentSessionMetadataFromSessionFile } from "../services/recent-session-catalog.js";
import type { ModelDescriptor, SessionRecoveryData } from "../types/index.js";

const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

function createRecoveryData(overrides?: Partial<SessionRecoveryData>): SessionRecoveryData {
	return {
		sessionId: { value: "session-1" },
		model: stubModel,
		toolSet: ["read"],
		planSummary: null,
		compactionSummary: null,
		metadata: null,
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
		...overrides,
	};
}

describe("shouldReloadRecentSessionMetadataFromSessionFile", () => {
	it("returns true when runtime metadata is absent and a sessionFile is present", () => {
		expect(
			shouldReloadRecentSessionMetadataFromSessionFile(
				createRecoveryData({
					sessionFile: "/tmp/session.jsonl",
				}),
			),
		).toBe(true);
	});

	it("returns false when runtime-owned metadata is already present", () => {
		expect(
			shouldReloadRecentSessionMetadataFromSessionFile(
				createRecoveryData({
					sessionFile: "/tmp/session.jsonl",
					metadata: {
						summary: "runtime summary",
						firstPrompt: "hello",
						messageCount: 1,
						fileSizeBytes: 64,
						recentMessages: [{ role: "user", text: "hello" }],
					},
				}),
			),
		).toBe(false);
	});

	it("returns false when no sessionFile is available", () => {
		expect(shouldReloadRecentSessionMetadataFromSessionFile(createRecoveryData())).toBe(false);
	});
});
