import { describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
	it("creates a new session without assigning a session file", () => {
		const manager = SessionManager.create("/tmp/workspace");

		expect(manager.getSessionId().length).toBeGreaterThan(0);
		expect(manager.getSessionFile()).toBeUndefined();
	});
});
