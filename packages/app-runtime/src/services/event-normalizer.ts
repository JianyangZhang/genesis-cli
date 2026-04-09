/**
 * Translates raw upstream events into standardized product-layer RuntimeEvents.
 *
 * This is the single point of translation. Unrecognized raw events return `null`
 * and are silently dropped — they are never leaked to consumers.
 *
 * The mapping table is a P2 skeleton. It will be refined when pi-mono is
 * integrated and the actual upstream event types are known.
 */

import type { RawUpstreamEvent } from "../adapters/kernel-session-adapter.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import { generateEventId } from "../session/session-events.js";
import type { SessionId } from "../types/index.js";

interface EventNormalizerOptions {
	readonly onUnknownEvent?: (event: {
		readonly sessionId: SessionId;
		readonly type: string;
		readonly timestamp: number;
		readonly payload?: Readonly<Record<string, unknown>>;
	}) => void;
}

export class EventNormalizer {
	private readonly unknownEventTypes = new Set<string>();

	constructor(
		private readonly sessionId: SessionId,
		private readonly options: EventNormalizerOptions = {},
	) {}

	/**
	 * Map a raw upstream event to a product-layer RuntimeEvent.
	 *
	 * Returns `null` for unrecognized events (they are silently dropped).
	 */
	normalize(raw: RawUpstreamEvent): RuntimeEvent | null {
		const base = {
			id: generateEventId(),
			timestamp: raw.timestamp,
			sessionId: this.sessionId,
		};

		switch (raw.type) {
			// -- Session lifecycle --
			case "agent_start":
				return {
					...base,
					category: "session",
					type: "session_created",
					model: (raw.payload?.model as { id: string; provider: string }) ?? {
						id: "unknown",
						provider: "unknown",
					},
					toolSet: (raw.payload?.toolSet as string[]) ?? [],
				};

			case "agent_end":
				return {
					...base,
					category: "session",
					type: "session_closed",
					recoveryData: {
						sessionId: this.sessionId,
						model: { id: "unknown", provider: "unknown" },
						toolSet: [],
						planSummary: null,
						compactionSummary: null,
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
				};

			case "agent_error":
				return {
					...base,
					category: "session",
					type: "session_error",
					message: (raw.payload?.message as string) ?? "Upstream model request failed",
					source: (raw.payload?.source as "auth" | "provider" | "runtime") ?? "runtime",
					fatal: raw.payload?.fatal !== false,
				};

			// -- Tool execution --
			case "tool_execution_start":
				return {
					...base,
					category: "tool",
					type: "tool_started",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					parameters: (raw.payload?.parameters as Record<string, unknown>) ?? {},
				};

			case "tool_execution_update":
				return {
					...base,
					category: "tool",
					type: "tool_update",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					update: (raw.payload?.update as string) ?? "",
				};

			case "tool_execution_end": {
				const status = (raw.payload?.status as "success" | "failure") ?? "success";
				return {
					...base,
					category: "tool",
					type: "tool_completed",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					status,
					result: raw.payload?.result as string | undefined,
					durationMs: (raw.payload?.durationMs as number) ?? 0,
				};
			}

			case "tool_execution_denied":
				return {
					...base,
					category: "tool",
					type: "tool_denied",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					reason: (raw.payload?.reason as string) ?? "Tool execution denied",
				};

			// -- Compaction --
			case "compaction_start":
				return {
					...base,
					category: "compaction",
					type: "compaction_started",
				};

			case "compaction_end":
				return {
					...base,
					category: "compaction",
					type: "compaction_completed",
					summary: {
						compressedAt: raw.timestamp,
						originalMessageCount: (raw.payload?.originalMessageCount as number) ?? 0,
						retainedMessageCount: (raw.payload?.retainedMessageCount as number) ?? 0,
						estimatedTokensSaved: (raw.payload?.estimatedTokensSaved as number) ?? 0,
						compactedSummary: (raw.payload?.compactedSummary as string | undefined) ?? undefined,
					},
				};

			// -- Text stream --
			case "message_update": {
				const kind = raw.payload?.kind as string | undefined;
				if (kind === "thinking") {
					return {
						...base,
						category: "text",
						type: "thinking_delta",
						content: (raw.payload?.content as string) ?? "",
					};
				}
				return {
					...base,
					category: "text",
					type: "text_delta",
					content: (raw.payload?.content as string) ?? "",
				};
			}

			case "usage_update":
				return {
					...base,
					category: "usage",
					type: "usage_updated",
					usage: {
						input: (raw.payload?.input as number) ?? 0,
						output: (raw.payload?.output as number) ?? 0,
						cacheRead: (raw.payload?.cacheRead as number) ?? 0,
						cacheWrite: (raw.payload?.cacheWrite as number) ?? 0,
						totalTokens: (raw.payload?.totalTokens as number) ?? 0,
					},
					isFinal: raw.payload?.isFinal === true,
				};

			// -- Permission --
			case "permission_request":
				return {
					...base,
					category: "permission",
					type: "permission_requested",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					riskLevel: (raw.payload?.riskLevel as string) ?? "L0",
					reason: raw.payload?.reason as string | undefined,
					targetPath: raw.payload?.targetPath as string | undefined,
				};

			case "permission_resolve":
				return {
					...base,
					category: "permission",
					type: "permission_resolved",
					toolName: (raw.payload?.toolName as string) ?? "unknown",
					toolCallId: (raw.payload?.toolCallId as string) ?? "",
					decision: (raw.payload?.decision as "allow" | "allow_for_session" | "allow_once" | "deny") ?? "deny",
				};

			default:
				this.reportUnknownEvent(raw);
				return null;
		}
	}

	private reportUnknownEvent(raw: RawUpstreamEvent): void {
		if (this.unknownEventTypes.has(raw.type)) {
			return;
		}
		this.unknownEventTypes.add(raw.type);
		this.options.onUnknownEvent?.({
			sessionId: this.sessionId,
			type: raw.type,
			timestamp: raw.timestamp,
			payload: raw.payload,
		});
		if (isDebugEnabled()) {
			console.warn(
				`[runtime:event-normalizer] Unknown upstream event type="${raw.type}" session="${this.sessionId.value}"`,
			);
		}
	}
}

function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.GENESIS_DEBUG;
	if (!raw) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
