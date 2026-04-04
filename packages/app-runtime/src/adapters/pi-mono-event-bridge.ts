import type { RawUpstreamEvent } from "./kernel-session-adapter.js";

type PiMonoBridgeEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| {
			type: "message_update";
			assistantMessageEvent: { type: "text_delta" | "thinking_delta"; delta: string };
	  }
	| {
			type: "tool_execution_start";
			toolName: string;
			toolCallId: string;
			args?: unknown;
	  }
	| {
			type: "tool_execution_update";
			toolName: string;
			toolCallId: string;
			partialResult?: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolName: string;
			toolCallId: string;
			isError: boolean;
			result?: unknown;
	  }
	| { type: "compaction_start" }
	| { type: "compaction_end"; result?: { tokensBefore?: number } };

export interface PiMonoBridgeState {
	readonly model: {
		readonly id: string;
		readonly provider: string;
		readonly displayName?: string;
	} | null;
	readonly toolSet: readonly string[];
	readonly toolStartedAtById: ReadonlyMap<string, number>;
}

export interface PiMonoBridgeResult {
	readonly rawEvents: readonly RawUpstreamEvent[];
	readonly nextState: PiMonoBridgeState;
}

export function createInitialBridgeState(params: {
	model: PiMonoBridgeState["model"];
	toolSet: readonly string[];
}): PiMonoBridgeState {
	return {
		model: params.model,
		toolSet: [...params.toolSet],
		toolStartedAtById: new Map(),
	};
}

export function bridgePiMonoEvent(event: PiMonoBridgeEvent, state: PiMonoBridgeState): PiMonoBridgeResult {
	const timestamp = Date.now();
	const rawEvents: RawUpstreamEvent[] = [];
	const toolStartedAtById = new Map(state.toolStartedAtById);

	switch (event.type) {
		case "agent_start":
			rawEvents.push({
				type: "agent_start",
				timestamp,
				payload: {
					model: state.model ?? { id: "unknown", provider: "unknown" },
					toolSet: state.toolSet,
				},
			});
			break;

		case "agent_end":
			rawEvents.push({
				type: "agent_end",
				timestamp,
			});
			break;

		case "message_update": {
			const delta = extractMessageDelta(event);
			if (delta !== null) {
				rawEvents.push({
					type: "message_update",
					timestamp,
					payload: {
						kind: delta.kind,
						content: delta.content,
					},
				});
			}
			break;
		}

		case "tool_execution_start":
			toolStartedAtById.set(event.toolCallId, timestamp);
			rawEvents.push({
				type: "tool_execution_start",
				timestamp,
				payload: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					parameters: asRecord(event.args),
				},
			});
			break;

		case "tool_execution_update":
			rawEvents.push({
				type: "tool_execution_update",
				timestamp,
				payload: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					update: extractToolText(event.partialResult),
				},
			});
			break;

		case "tool_execution_end": {
			const startedAt = toolStartedAtById.get(event.toolCallId) ?? timestamp;
			toolStartedAtById.delete(event.toolCallId);
			rawEvents.push({
				type: "tool_execution_end",
				timestamp,
				payload: {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					status: event.isError ? "failure" : "success",
					result: extractToolText(event.result),
					durationMs: Math.max(0, timestamp - startedAt),
				},
			});
			break;
		}

		case "compaction_start":
			rawEvents.push({
				type: "compaction_start",
				timestamp,
			});
			break;

		case "compaction_end":
			rawEvents.push({
				type: "compaction_end",
				timestamp,
				payload: {
					originalMessageCount: 0,
					retainedMessageCount: 0,
					estimatedTokensSaved: event.result?.tokensBefore ?? 0,
				},
			});
			break;

		default:
			break;
	}

	return {
		rawEvents,
		nextState: {
			model: state.model,
			toolSet: state.toolSet,
			toolStartedAtById,
		},
	};
}

function extractMessageDelta(
	event: Extract<PiMonoBridgeEvent, { type: "message_update" }>,
): { kind: "text" | "thinking"; content: string } | null {
	if (event.assistantMessageEvent.type === "text_delta") {
		return {
			kind: "text",
			content: event.assistantMessageEvent.delta,
		};
	}

	if (event.assistantMessageEvent.type === "thinking_delta") {
		return {
			kind: "thinking",
			content: event.assistantMessageEvent.delta,
		};
	}

	return null;
}

function extractToolText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const content = (value as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const text = content
			.filter((entry): entry is { type: string; text?: string } => typeof entry === "object" && entry !== null)
			.filter((entry) => entry.type === "text" && typeof entry.text === "string")
			.map((entry) => entry.text!.trim())
			.filter((entry) => entry.length > 0)
			.join("\n");
		if (text.length > 0) {
			return text;
		}
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}
