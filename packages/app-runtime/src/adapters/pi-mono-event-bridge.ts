import type { RawUpstreamEvent } from "./kernel-session-adapter.js";

type PiMonoBridgeEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| {
			type: "message_update";
			assistantMessageEvent: {
				type: string;
				delta?: string;
				partial?: unknown;
			};
	  }
	| {
			type: "message_end";
			message?: unknown;
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
	| { type: "compaction_end"; result?: { tokensBefore?: number; summary?: string } };

export interface PiMonoBridgeState {
	readonly model: {
		readonly id: string;
		readonly provider: string;
		readonly displayName?: string;
	} | null;
	readonly toolSet: readonly string[];
	readonly toolStartedAtById: ReadonlyMap<string, number>;
	readonly lastUsageSignature: string | null;
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
		lastUsageSignature: null,
	};
}

export function bridgePiMonoEvent(event: PiMonoBridgeEvent, state: PiMonoBridgeState): PiMonoBridgeResult {
	const timestamp = Date.now();
	const rawEvents: RawUpstreamEvent[] = [];
	const toolStartedAtById = new Map(state.toolStartedAtById);
	let lastUsageSignature = state.lastUsageSignature;

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
			lastUsageSignature = null;
			break;

		case "message_update": {
			pushUsageUpdate(rawEvents, timestamp, extractUsage(event.assistantMessageEvent.partial), false, {
				get signature() {
					return lastUsageSignature;
				},
				set signature(value: string | null) {
					lastUsageSignature = value;
				},
			});
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

		case "message_end":
			pushUsageUpdate(rawEvents, timestamp, extractMessageUsage(event.message), true, {
				get signature() {
					return lastUsageSignature;
				},
				set signature(value: string | null) {
					lastUsageSignature = value;
				},
			});
			break;

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
					compactedSummary: event.result?.summary,
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
			lastUsageSignature,
		},
	};
}

function extractMessageDelta(
	event: Extract<PiMonoBridgeEvent, { type: "message_update" }>,
): { kind: "text" | "thinking"; content: string } | null {
	if (event.assistantMessageEvent.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
		return {
			kind: "text",
			content: event.assistantMessageEvent.delta,
		};
	}

	if (event.assistantMessageEvent.type === "thinking_delta" && typeof event.assistantMessageEvent.delta === "string") {
		return {
			kind: "thinking",
			content: event.assistantMessageEvent.delta,
		};
	}

	return null;
}

function extractUsage(partial: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
} | null {
	if (!partial || typeof partial !== "object") {
		return null;
	}
	const usage = (partial as { usage?: unknown }).usage;
	return normalizeUsage(usage);
}

function extractMessageUsage(message: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
} | null {
	if (!message || typeof message !== "object") {
		return null;
	}
	if ((message as { role?: unknown }).role !== "assistant") {
		return null;
	}
	return normalizeUsage((message as { usage?: unknown }).usage);
}

function normalizeUsage(usage: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
} | null {
	if (!usage || typeof usage !== "object") {
		return null;
	}
	const record = usage as Record<string, unknown>;
	const input = asNumber(record.input) ?? 0;
	const output = asNumber(record.output) ?? 0;
	const cacheRead = asNumber(record.cacheRead) ?? 0;
	const cacheWrite = asNumber(record.cacheWrite) ?? 0;
	const totalTokens = asNumber(record.totalTokens) ?? input + output + cacheRead + cacheWrite;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0) {
		return null;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
	};
}

function pushUsageUpdate(
	rawEvents: RawUpstreamEvent[],
	timestamp: number,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null,
	isFinal: boolean,
	state: { signature: string | null },
): void {
	if (!usage) {
		return;
	}
	const signature = `${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}:${usage.totalTokens}:${isFinal ? 1 : 0}`;
	if (state.signature === signature) {
		return;
	}
	state.signature = signature;
	rawEvents.push({
		type: "usage_update",
		timestamp,
		payload: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			isFinal,
		},
	});
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

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
