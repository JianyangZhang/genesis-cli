/**
 * Integration tests for the RPC server.
 *
 * Tests the dispatch logic by creating an RPC server with PassThrough streams,
 * writing JSON-RPC requests, and reading responses.
 */

import { PassThrough } from "node:stream";
import type { AppRuntime, SessionFacade, SessionId, SessionState } from "@genesis-cli/runtime";
import type { RpcEnvelope } from "@genesis-cli/ui";
import { RPC_ERRORS, RPC_METHODS } from "@genesis-cli/ui";
import { describe, expect, it } from "vitest";
import { createRpcServer } from "../rpc-server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSession(overrides?: Partial<SessionState>): SessionFacade {
	const state: SessionState = {
		id: { value: "test-session-1" } as SessionId,
		status: "active",
		createdAt: Date.now() - 60000,
		updatedAt: Date.now(),
		model: { id: "test-model", provider: "test" },
		toolSet: new Set(["read_file", "write_file"]),
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
		context: {} as SessionFacade["context"],
		events: {
			onCategory: () => () => {},
			emit: () => {},
			on: () => () => {},
			off: () => {},
			removeAllListeners: () => {},
		} as unknown as SessionFacade["events"],
		plan: null,
		prompt: async () => {},
		continue: async () => {},
		abort: () => {},
		close: async () => {},
		onStateChange: () => () => {},
		resolvePermission: async () => {},
	} as unknown as SessionFacade;
}

function createMockRuntime(session: SessionFacade): AppRuntime {
	return {
		createSession: () => session,
		recoverSession: () => session,
		events: {
			onCategory: () => () => {},
			emit: () => {},
			on: () => () => {},
			off: () => {},
			removeAllListeners: () => {},
		} as unknown as AppRuntime["events"],
		governor: {
			catalog: {
				listAll: () => [
					{
						identity: { name: "read_file", category: "file_read" },
						policy: { riskLevel: "L0", readOnly: true, confirmation: "never" },
					},
					{
						identity: { name: "bash", category: "shell" },
						policy: { riskLevel: "L3", readOnly: false, confirmation: "always" },
					},
				],
				get: () => undefined,
				register: () => {},
				getByCategory: () => [],
				has: () => false,
				size: 2,
			},
		} as unknown as AppRuntime["governor"],
		planEngine: {} as AppRuntime["planEngine"],
		shutdown: async () => {},
	} as AppRuntime;
}

/**
 * Run an RPC server with a set of requests, collect all responses.
 * Returns parsed JSON-RPC envelopes.
 */
async function runRpcTest(
	runtime: AppRuntime,
	requests: Array<{ method: string; params?: Record<string, unknown>; id: number }>,
): Promise<RpcEnvelope[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	const server = createRpcServer({ input, output });

	// Collect output chunks
	const chunks: Buffer[] = [];
	output.on("data", (chunk: Buffer) => chunks.push(chunk));

	// Start the server (blocks until input closes)
	const startPromise = server.start(runtime);

	// Write all requests as JSON-RPC lines
	for (const req of requests) {
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, method: req.method, params: req.params })}\n`);
	}

	// Close input to end the readline loop
	input.end();

	// Wait for start to finish (readline loop completes when input ends)
	await startPromise;
	await server.stop();

	// Parse collected output
	const fullOutput = Buffer.concat(chunks).toString();
	return fullOutput
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as RpcEnvelope);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RPC server", () => {
	const session = createMockSession();
	const runtime = createMockRuntime(session);

	it("creates a session and returns session ID", async () => {
		const responses = await runRpcTest(runtime, [{ method: RPC_METHODS.SESSION_CREATE, id: 1 }]);

		const resp = responses.find((r) => r.id === 1);
		expect(resp).toBeDefined();
		expect(resp!.result).toBeDefined();
		const result = resp!.result as Record<string, unknown>;
		expect(result.status).toBe("created");
		expect(result.sessionId).toBe("test-session-1");
	});

	it("returns tools/list with registered tools", async () => {
		const responses = await runRpcTest(runtime, [{ method: RPC_METHODS.TOOLS_LIST, id: 2 }]);

		const resp = responses.find((r) => r.id === 2);
		expect(resp).toBeDefined();
		const result = resp!.result as Record<string, unknown>;
		expect(result.count).toBe(2);
		const tools = result.tools as Array<Record<string, unknown>>;
		expect(tools[0].name).toBe("read_file");
		expect(tools[1].name).toBe("bash");
	});

	it("returns plan/status with no active plan", async () => {
		const responses = await runRpcTest(runtime, [{ method: RPC_METHODS.PLAN_STATUS, id: 3 }]);

		const resp = responses.find((r) => r.id === 3);
		expect(resp).toBeDefined();
		const result = resp!.result as Record<string, unknown>;
		expect(result.active).toBe(false);
		expect(result.plan).toBeNull();
	});

	it("returns METHOD_NOT_FOUND for unknown methods", async () => {
		const responses = await runRpcTest(runtime, [{ method: "nonexistent/method", id: 4 }]);

		const resp = responses.find((r) => r.id === 4);
		expect(resp).toBeDefined();
		expect(resp!.error).toBeDefined();
		expect(resp!.error!.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND);
	});

	it("returns SESSION_NOT_FOUND for permission/resolve without session", async () => {
		const responses = await runRpcTest(runtime, [
			{ method: RPC_METHODS.PERMISSION_RESOLVE, id: 5, params: { callId: "tc-1", decision: "allow_once" } },
		]);

		const resp = responses.find((r) => r.id === 5);
		expect(resp).toBeDefined();
		expect(resp!.error).toBeDefined();
		expect(resp!.error!.code).toBe(RPC_ERRORS.SESSION_NOT_FOUND);
	});

	it("resolves permission with valid session", async () => {
		const mockSession = createMockSession();
		const resolvedCalls: Array<{ callId: string; decision: string }> = [];
		mockSession.resolvePermission = async (callId: string, decision: string) => {
			resolvedCalls.push({ callId, decision });
		};
		const mockRuntime = createMockRuntime(mockSession);

		const responses = await runRpcTest(mockRuntime, [
			{ method: RPC_METHODS.SESSION_CREATE, id: 1 },
			{ method: RPC_METHODS.PERMISSION_RESOLVE, id: 2, params: { callId: "tc-1", decision: "allow_once" } },
		]);

		const resp = responses.find((r) => r.id === 2);
		expect(resp).toBeDefined();
		const result = resp!.result as Record<string, unknown>;
		expect(result.status).toBe("resolved");
		expect(resolvedCalls).toHaveLength(1);
		expect(resolvedCalls[0].callId).toBe("tc-1");
		expect(resolvedCalls[0].decision).toBe("allow_once");
	});

	it("keeps processing permission/resolve while a prompt is still running", async () => {
		let releasePrompt!: () => void;
		const promptBlocked = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const resolvedCalls: Array<{ callId: string; decision: string }> = [];
		const mockSession = createMockSession();
		mockSession.prompt = async () => {
			await promptBlocked;
		};
		mockSession.resolvePermission = async (callId: string, decision: string) => {
			resolvedCalls.push({ callId, decision });
			releasePrompt();
		};
		const mockRuntime = createMockRuntime(mockSession);

		const responses = await runRpcTest(mockRuntime, [
			{ method: RPC_METHODS.SESSION_CREATE, id: 1 },
			{ method: RPC_METHODS.SESSION_PROMPT, id: 2, params: { text: "do it" } },
			{ method: RPC_METHODS.PERMISSION_RESOLVE, id: 3, params: { callId: "tc-1", decision: "allow_once" } },
		]);

		expect(responses.find((r) => r.id === 2)?.result).toEqual({ status: "prompt_sent" });
		expect(responses.find((r) => r.id === 3)?.result).toEqual({ status: "resolved" });
		expect(resolvedCalls).toEqual([{ callId: "tc-1", decision: "allow_once" }]);
	});

	it("returns INVALID_PARAMS for permission/resolve missing params", async () => {
		const mockSession = createMockSession();
		const mockRuntime = createMockRuntime(mockSession);

		const responses = await runRpcTest(mockRuntime, [
			{ method: RPC_METHODS.SESSION_CREATE, id: 1 },
			{ method: RPC_METHODS.PERMISSION_RESOLVE, id: 2, params: {} },
		]);

		const resp = responses.find((r) => r.id === 2);
		expect(resp).toBeDefined();
		expect(resp!.error).toBeDefined();
		expect(resp!.error!.code).toBe(RPC_ERRORS.INVALID_PARAMS);
	});

	it("handles session/list", async () => {
		const responses = await runRpcTest(runtime, [{ method: RPC_METHODS.SESSION_LIST, id: 10 }]);

		const resp = responses.find((r) => r.id === 10);
		expect(resp).toBeDefined();
		const result = resp!.result as unknown[];
		expect(Array.isArray(result)).toBe(true);
	});

	it("returns PARSE_ERROR for invalid JSON", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const server = createRpcServer({ input, output });

		const chunks: Buffer[] = [];
		output.on("data", (chunk: Buffer) => chunks.push(chunk));

		const startPromise = server.start(runtime);
		input.write("this is not valid json\n");
		input.end();

		await startPromise;
		await server.stop();

		const fullOutput = Buffer.concat(chunks).toString();
		const responses = fullOutput
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as RpcEnvelope);

		expect(responses.length).toBeGreaterThanOrEqual(1);
		expect(responses[0].error).toBeDefined();
		expect(responses[0].error!.code).toBe(RPC_ERRORS.PARSE_ERROR);
	});
});
