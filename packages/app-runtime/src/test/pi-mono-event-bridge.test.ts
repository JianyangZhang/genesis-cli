import { describe, expect, it } from "vitest";
import { bridgePiMonoEvent, createInitialBridgeState } from "../adapters/pi-mono-event-bridge.js";

describe("PiMonoEventBridge", () => {
	it("maps text deltas into raw message updates", () => {
		const state = createInitialBridgeState({
			model: { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" },
			toolSet: ["read", "bash"],
		});

		const result = bridgePiMonoEvent(
			{
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "hello",
					partial: {} as never,
				},
			} as never,
			state,
		);

		expect(result.rawEvents).toEqual([
			expect.objectContaining({
				type: "message_update",
				payload: {
					kind: "text",
					content: "hello",
				},
			}),
		]);
	});

	it("maps thinking deltas into thinking updates", () => {
		const state = createInitialBridgeState({
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: [],
		});

		const result = bridgePiMonoEvent(
			{
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "reasoning",
					partial: {} as never,
				},
			} as never,
			state,
		);

		expect(result.rawEvents).toEqual([
			expect.objectContaining({
				type: "message_update",
				payload: {
					kind: "thinking",
					content: "reasoning",
				},
			}),
		]);
	});

	it("tracks tool execution lifecycle", () => {
		const state = createInitialBridgeState({
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["read"],
		});

		const started = bridgePiMonoEvent(
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { file_path: "/tmp/file.txt" },
			} as never,
			state,
		);

		const completed = bridgePiMonoEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				result: {
					content: [{ type: "text", text: "done" }],
					details: {},
				},
				isError: false,
			} as never,
			started.nextState,
		);

		expect(started.rawEvents[0]).toEqual(
			expect.objectContaining({
				type: "tool_execution_start",
				payload: {
					toolName: "read",
					toolCallId: "call-1",
					parameters: { file_path: "/tmp/file.txt" },
				},
			}),
		);
		expect(completed.rawEvents[0]).toEqual(
			expect.objectContaining({
				type: "tool_execution_end",
				payload: expect.objectContaining({
					toolName: "read",
					toolCallId: "call-1",
					status: "success",
					result: "done",
				}),
			}),
		);
	});

	it("maps tool errors to failure status", () => {
		const state = createInitialBridgeState({
			model: { id: "glm-5.1", provider: "zai" },
			toolSet: ["bash"],
		});

		const started = bridgePiMonoEvent(
			{
				type: "tool_execution_start",
				toolCallId: "call-err",
				toolName: "bash",
				args: { command: "false" },
			} as never,
			state,
		);

		const completed = bridgePiMonoEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call-err",
				toolName: "bash",
				result: {
					content: [{ type: "text", text: "boom" }],
					details: {},
				},
				isError: true,
			} as never,
			started.nextState,
		);

		expect(completed.rawEvents[0]).toEqual(
			expect.objectContaining({
				type: "tool_execution_end",
				payload: expect.objectContaining({
					status: "failure",
					result: "boom",
				}),
			}),
		);
	});
});
