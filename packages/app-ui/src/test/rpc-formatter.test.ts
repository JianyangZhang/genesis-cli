/**
 * Tests for the RPC formatter.
 */

import type { RuntimeEvent } from "@pickle-pee/runtime";
import { describe, expect, it } from "vitest";
import {
	createRpcError,
	createRpcResponse,
	eventToRpcNotification,
	parseRpcRequest,
	RPC_ERRORS,
	RPC_METHODS,
} from "../services/rpc-formatter.js";

const SID = { value: "test-session" };
const base = { id: "evt-1", timestamp: 1000, sessionId: SID };

describe("eventToRpcNotification", () => {
	it("creates a JSON-RPC 2.0 notification", () => {
		const event: RuntimeEvent = {
			...base,
			category: "tool",
			type: "tool_started",
			toolName: "read_file",
			toolCallId: "tc-1",
			parameters: {},
		};
		const rpc = eventToRpcNotification(event);
		expect(rpc.jsonrpc).toBe("2.0");
		expect(rpc.method).toBe("event/tool/tool_started");
		expect(rpc.params).toBeDefined();
	});

	it("includes session ID in params", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hi",
		};
		const rpc = eventToRpcNotification(event);
		expect((rpc.params as Record<string, unknown>)?.sessionId).toBe("test-session");
	});

	it("does not include id field (notification)", () => {
		const event: RuntimeEvent = {
			...base,
			category: "text",
			type: "text_delta",
			content: "hi",
		};
		const rpc = eventToRpcNotification(event);
		expect(rpc.id).toBeUndefined();
	});

	it("includes usage payloads in notifications", () => {
		const event: RuntimeEvent = {
			...base,
			category: "usage",
			type: "usage_updated",
			usage: {
				input: 120,
				output: 24,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 144,
			},
			isFinal: true,
		};
		const rpc = eventToRpcNotification(event);
		expect((rpc.params as Record<string, unknown>)?.usage).toEqual(event.usage);
		expect((rpc.params as Record<string, unknown>)?.isFinal).toBe(true);
	});

	it("includes session error details in notifications", () => {
		const event: RuntimeEvent = {
			...base,
			category: "session",
			type: "session_error",
			message: "401 Unauthorized",
			source: "auth",
			fatal: true,
		};
		const rpc = eventToRpcNotification(event);
		expect((rpc.params as Record<string, unknown>)?.message).toBe("401 Unauthorized");
		expect((rpc.params as Record<string, unknown>)?.source).toBe("auth");
		expect((rpc.params as Record<string, unknown>)?.fatal).toBe(true);
	});
});

describe("createRpcResponse", () => {
	it("creates a success response", () => {
		const rpc = createRpcResponse(1, { status: "ok" });
		expect(rpc.jsonrpc).toBe("2.0");
		expect(rpc.id).toBe(1);
		expect(rpc.result).toEqual({ status: "ok" });
		expect(rpc.error).toBeUndefined();
	});

	it("accepts string id", () => {
		const rpc = createRpcResponse("abc", { data: 42 });
		expect(rpc.id).toBe("abc");
	});
});

describe("createRpcError", () => {
	it("creates an error response", () => {
		const rpc = createRpcError(1, RPC_ERRORS.METHOD_NOT_FOUND, "Unknown method");
		expect(rpc.jsonrpc).toBe("2.0");
		expect(rpc.id).toBe(1);
		expect(rpc.error?.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND);
		expect(rpc.error?.message).toBe("Unknown method");
	});

	it("includes optional data", () => {
		const rpc = createRpcError(2, -32000, "err", { detail: "info" });
		expect(rpc.error?.data).toEqual({ detail: "info" });
	});

	it("accepts null id", () => {
		const rpc = createRpcError(null, RPC_ERRORS.PARSE_ERROR, "bad json");
		expect(rpc.id).toBeNull();
	});
});

describe("parseRpcRequest", () => {
	it("parses valid JSON-RPC request", () => {
		const line = JSON.stringify({ jsonrpc: "2.0", method: "session/create", id: 1, params: {} });
		const req = parseRpcRequest(line);
		expect(req).not.toBeNull();
		expect(req?.method).toBe("session/create");
		expect(req?.id).toBe(1);
	});

	it("returns null for empty line", () => {
		expect(parseRpcRequest("")).toBeNull();
		expect(parseRpcRequest("   ")).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		expect(parseRpcRequest("{invalid")).toBeNull();
	});

	it("returns null for valid JSON without jsonrpc field", () => {
		expect(parseRpcRequest('{"method":"test"}')).toBeNull();
	});

	it("returns null for wrong jsonrpc version", () => {
		expect(parseRpcRequest('{"jsonrpc":"1.0","method":"test","id":1}')).toBeNull();
	});
});

describe("RPC_METHODS constants", () => {
	it("has expected method names", () => {
		expect(RPC_METHODS.SESSION_CREATE).toBe("session/create");
		expect(RPC_METHODS.SESSION_PROMPT).toBe("session/prompt");
		expect(RPC_METHODS.SESSION_ABORT).toBe("session/abort");
		expect(RPC_METHODS.SESSION_CLOSE).toBe("session/close");
	});
});

describe("RPC_ERRORS constants", () => {
	it("has standard error codes", () => {
		expect(RPC_ERRORS.PARSE_ERROR).toBe(-32700);
		expect(RPC_ERRORS.METHOD_NOT_FOUND).toBe(-32601);
		expect(RPC_ERRORS.INTERNAL_ERROR).toBe(-32603);
	});
});
