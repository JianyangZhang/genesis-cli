import { describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
	it("assigns a stable session file when created with a storage directory", () => {
		const manager = SessionManager.create("/tmp/workspace", "/tmp/history/session-files");

		expect(manager.getSessionId().length).toBeGreaterThan(0);
		expect(manager.getSessionFile()).toBe(`/tmp/history/session-files/${manager.getSessionId()}.jsonl`);
	});
});
