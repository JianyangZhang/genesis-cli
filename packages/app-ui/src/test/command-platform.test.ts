import type { SessionFacade, SessionId, SessionState } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import { createBuiltinCommandRegistry, createInteractiveCommandRegistry } from "../domain/command-platform.js";

function createMockSession(overrides?: Partial<SessionState>): SessionFacade {
	const state: SessionState = {
		id: { value: "command-platform-session" } as SessionId,
		status: "active",
		createdAt: Date.now() - 1000,
		updatedAt: Date.now(),
		model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
		toolSet: new Set(["read"]),
		planSummary: null,
		compactionSummary: null,
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
		...overrides,
	};
	return {
		id: state.id,
		get state() {
			return state;
		},
		context: {
			sessionId: state.id,
			workingDirectory: "/tmp/repo",
			mode: "interactive",
			model: state.model,
			toolSet: state.toolSet,
			taskState: state.taskState,
		},
		events: {} as SessionFacade["events"],
		plan: null,
		prompt: async () => {},
		continue: async () => {},
		abort: () => {},
		close: async () => {},
		switchModel: async () => {},
		onStateChange: () => () => {},
		compact: async () => {},
	} as unknown as SessionFacade;
}

describe("command-platform registry factories", () => {
	it("creates a builtin registry with public core commands", () => {
		const registry = createBuiltinCommandRegistry();
		expect(registry.get("model")).toBeDefined();
		expect(registry.get("compact")).toBeDefined();
		expect(registry.get("session")).toBeDefined();
	});

	it("creates an interactive registry that merges builtin and local command sets", () => {
		const session = createMockSession();
		const registry = createInteractiveCommandRegistry({
			getCurrentSession: () => session,
			getSessionTitle: () => undefined,
			setSessionTitle: () => {},
			requestExit: () => {},
			isInteractionBusy: () => false,
			hasPendingPermissionRequest: () => false,
			replaceSession: () => {},
			getAgentDir: () => "/tmp/agent",
			getInteractionPhase: () => "idle",
			getLastError: () => null,
			getChangedFileCount: () => 0,
			getPendingPermissionCallId: () => null,
			getToolUsageSummary: () => ({ total: 0, success: 0, failure: 0, denied: 0, recent: [] }),
			getConfigSnapshot: async () => ({
				sources: [],
				agentDir: "/tmp/agent",
				modelsPath: "/tmp/agent/models.json",
				error: "models.json not found.",
			}),
			getWorkingTreeSummary: async () => ({
				changedPaths: [],
				snapshot: { available: true, statusLines: [], diffStatLines: [] },
			}),
			getGitDiff: async () => ({ type: "ok", stdout: "" }),
			getDoctorSnapshot: async () => null,
		});
		expect(registry.get("help")).toBeDefined();
		expect(registry.get("usage")).toBeDefined();
		expect(registry.get("config")).toBeDefined();
		expect(registry.resolve("/usage")?.type).toBe("command");
	});
});
