/**
 * Integration tests for the permission resolution flow.
 *
 * Tests SessionFacadeImpl.resolvePermission() and the full
 * ask_user → permission_requested → resolvePermission → permission_resolved chain.
 */

import type {
	KernelSessionAdapter,
	ModelDescriptor,
	RawUpstreamEvent,
	RuntimeEvent,
	SessionId,
} from "@genesis-cli/runtime";
import {
	createEventBus,
	createInitialSessionState,
	createRuntimeContext,
	createToolGovernor,
	SessionFacadeImpl,
} from "@genesis-cli/runtime";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Stub adapter without governance hook — triggers fallback applyGovernance path
// ---------------------------------------------------------------------------

class NoHookAdapter implements KernelSessionAdapter {
	async *sendPrompt(_input: string): AsyncIterable<RawUpstreamEvent> {
		yield {
			type: "tool_execution_start",
			timestamp: Date.now(),
			payload: {
				toolName: "write_file",
				toolCallId: "tc-perm-1",
				parameters: { file_path: "/tmp/test.txt" },
			},
		};
		yield {
			type: "tool_execution_end",
			timestamp: Date.now(),
			payload: {
				toolName: "write_file",
				toolCallId: "tc-perm-1",
				status: "success",
				result: "wrote 100 bytes",
				durationMs: 50,
			},
		};
	}

	async *sendContinue(_input: string): AsyncIterable<RawUpstreamEvent> {
		yield* this.sendPrompt(_input);
	}

	abort(): void {}

	async close(): Promise<void> {}

	getRecoveryData() {
		return {
			sessionId: stubId,
			model: stubModel,
			toolSet: ["write_file"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
		};
	}

	resume(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubId: SessionId = { value: "perm-test-session" };
const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

function createFacadeWithGovernor() {
	const adapter = new NoHookAdapter();
	const globalBus = createEventBus();
	const state = createInitialSessionState(stubId, stubModel, new Set(["write_file"]));
	const context = createRuntimeContext({
		sessionId: stubId,
		workingDirectory: "/tmp",
		mode: "interactive",
		model: stubModel,
		toolSet: new Set(["write_file"]),
	});

	// Create governor with ask_user confirmation for write_file
	const governor = createToolGovernor();
	governor.catalog.register({
		identity: {
			name: "write_file",
			category: "file-mutation",
		},
		contract: {
			parameterSchema: {
				type: "object",
				properties: {
					file_path: { type: "string" },
					content: { type: "string" },
				},
				required: ["file_path", "content"],
			},
			output: { type: "text" },
			errorTypes: ["execution_error"],
		},
		policy: {
			riskLevel: "L2",
			readOnly: false,
			confirmation: "always",
			concurrency: "per_target",
			subAgentAllowed: false,
			timeoutMs: 30000,
		},
		executorTag: "write_file",
	});

	const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor);

	const sessionEvents: RuntimeEvent[] = [];
	const globalEvents: RuntimeEvent[] = [];

	for (const cat of ["permission", "tool", "session", "plan", "compaction", "text"]) {
		facade.events.onCategory(cat, (event: RuntimeEvent) => {
			sessionEvents.push(event);
		});
		globalBus.onCategory(cat, (event: RuntimeEvent) => {
			globalEvents.push(event);
		});
	}

	return { facade, sessionEvents, globalEvents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Permission resolution flow", () => {
	it("emits permission_requested when governance returns ask_user", async () => {
		const { facade, sessionEvents } = createFacadeWithGovernor();

		await facade.prompt("write something");

		const permRequested = sessionEvents.find((e) => e.category === "permission" && e.type === "permission_requested");
		expect(permRequested).toBeDefined();
		if (permRequested && permRequested.type === "permission_requested") {
			expect(permRequested.toolName).toBe("write_file");
			expect(permRequested.toolCallId).toBe("tc-perm-1");
		}

		await facade.close();
	});

	it("resolves permission with allow_once", async () => {
		const { facade, sessionEvents } = createFacadeWithGovernor();

		await facade.prompt("write something");

		facade.resolvePermission("tc-perm-1", "allow_once");

		const permResolved = sessionEvents.find((e) => e.category === "permission" && e.type === "permission_resolved");
		expect(permResolved).toBeDefined();
		if (permResolved && permResolved.type === "permission_resolved") {
			expect(permResolved.decision).toBe("allow_once");
		}

		await facade.close();
	});

	it("resolves permission with deny", async () => {
		const { facade, sessionEvents } = createFacadeWithGovernor();

		await facade.prompt("write something");

		facade.resolvePermission("tc-perm-1", "deny");

		const permResolved = sessionEvents.find((e) => e.category === "permission" && e.type === "permission_resolved");
		expect(permResolved).toBeDefined();
		if (permResolved && permResolved.type === "permission_resolved") {
			expect(permResolved.decision).toBe("deny");
		}

		await facade.close();
	});

	it("emits permission_resolved to global bus", async () => {
		const { facade, globalEvents } = createFacadeWithGovernor();

		await facade.prompt("write something");

		facade.resolvePermission("tc-perm-1", "allow_once");

		const globalResolved = globalEvents.find((e) => e.category === "permission" && e.type === "permission_resolved");
		expect(globalResolved).toBeDefined();

		await facade.close();
	});

	it("throws for unknown callId", async () => {
		const { facade } = createFacadeWithGovernor();

		await facade.prompt("write something");

		expect(() => {
			facade.resolvePermission("nonexistent-call-id", "deny");
		}).toThrow("No pending permission request");

		await facade.close();
	});

	it("throws when resolving same callId twice", async () => {
		const { facade } = createFacadeWithGovernor();

		await facade.prompt("write something");

		facade.resolvePermission("tc-perm-1", "allow_once");

		expect(() => {
			facade.resolvePermission("tc-perm-1", "deny");
		}).toThrow("No pending permission request");

		await facade.close();
	});

	it("records session approval for allow_for_session", async () => {
		const { facade, sessionEvents } = createFacadeWithGovernor();

		await facade.prompt("write something");

		facade.resolvePermission("tc-perm-1", "allow_for_session");

		const permResolved = sessionEvents.find((e) => e.category === "permission" && e.type === "permission_resolved");
		expect(permResolved).toBeDefined();
		if (permResolved && permResolved.type === "permission_resolved") {
			expect(permResolved.decision).toBe("allow_for_session");
		}

		await facade.close();
	});
});
