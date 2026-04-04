/**
 * Stub implementation of KernelSessionAdapter for testing.
 *
 * Provides synchronous control over event yielding so tests can
 * verify session lifecycle, event normalization, and state transitions
 * without depending on pi-mono.
 */

import type {
	KernelSessionAdapter,
	RawUpstreamEvent,
	ToolExecutionGate,
} from "../../adapters/kernel-session-adapter.js";
import type { SessionRecoveryData } from "../../types/index.js";

export class StubKernelSessionAdapter implements KernelSessionAdapter {
	private readonly eventsByPrompt = new Map<string, RawUpstreamEvent[]>();
	private defaultEvents: RawUpstreamEvent[] = [];
	private toolExecutionGate: ToolExecutionGate | null = null;
	private _abortCalled = false;
	private _closed = false;
	private _lastInput: string | null = null;
	private _resumeData: SessionRecoveryData | null = null;

	// -----------------------------------------------------------------------
	// Test helpers
	// -----------------------------------------------------------------------

	/** Queue events that will be yielded for a specific prompt input. */
	enqueueEventsForPrompt(input: string, events: RawUpstreamEvent[]): void {
		this.eventsByPrompt.set(input, events);
	}

	/** Queue events that will be yielded for any prompt without a specific mapping. */
	enqueueDefaultEvents(events: RawUpstreamEvent[]): void {
		this.defaultEvents = events;
	}

	/** Whether abort() was called. */
	get abortCalled(): boolean {
		return this._abortCalled;
	}

	/** Whether close() was called. */
	get closed(): boolean {
		return this._closed;
	}

	/** The last input received by sendPrompt or sendContinue. */
	get lastInput(): string | null {
		return this._lastInput;
	}

	/** Whether resume() was called. */
	get resumeCalled(): boolean {
		return this._resumeData !== null;
	}

	/** The data passed to the last resume() call. */
	get lastResumeData(): SessionRecoveryData | null {
		return this._resumeData;
	}

	setToolExecutionGate(gate: ToolExecutionGate): void {
		this.toolExecutionGate = gate;
	}

	// -----------------------------------------------------------------------
	// KernelSessionAdapter implementation
	// -----------------------------------------------------------------------

	async *sendPrompt(input: string): AsyncIterable<RawUpstreamEvent> {
		this._lastInput = input;
		const events = this.eventsByPrompt.get(input) ?? this.defaultEvents;
		yield* this.processEvents(events);
	}

	async *sendContinue(input: string): AsyncIterable<RawUpstreamEvent> {
		this._lastInput = input;
		const events = this.eventsByPrompt.get(input) ?? this.defaultEvents;
		yield* this.processEvents(events);
	}

	private async *processEvents(events: RawUpstreamEvent[]): AsyncIterable<RawUpstreamEvent> {
		const suppressedToolCalls = new Set<string>();

		for (const event of events) {
			if (this._abortCalled) return;

			if (event.type === "tool_execution_start" && this.toolExecutionGate) {
				const toolName = typeof event.payload?.toolName === "string" ? event.payload.toolName : "unknown";
				const toolCallId = typeof event.payload?.toolCallId === "string" ? event.payload.toolCallId : "";
				const parameters = (event.payload?.parameters as Readonly<Record<string, unknown>> | undefined) ?? {};
				const decision = this.toolExecutionGate.beforeToolExecution({
					toolName,
					toolCallId,
					parameters,
				});

				if (decision.type === "allow") {
					yield event;
					continue;
				}

				suppressedToolCalls.add(toolCallId);
				yield {
					type: decision.type === "deny" ? "tool_execution_denied" : "permission_request",
					timestamp: event.timestamp,
					payload:
						decision.type === "deny"
							? { toolName, toolCallId, reason: decision.reason }
							: { toolName, toolCallId, riskLevel: decision.riskLevel },
				};
				continue;
			}

			const toolCallId = typeof event.payload?.toolCallId === "string" ? event.payload.toolCallId : undefined;
			if (
				toolCallId &&
				suppressedToolCalls.has(toolCallId) &&
				(event.type === "tool_execution_update" || event.type === "tool_execution_end")
			) {
				continue;
			}

			yield event;
		}
	}

	abort(): void {
		this._abortCalled = true;
	}

	async close(): Promise<void> {
		this._closed = true;
	}

	getRecoveryData(): SessionRecoveryData {
		return {
			sessionId: { value: "stub-session-id" },
			model: { id: "stub-model", provider: "stub" },
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		};
	}

	resume(data: SessionRecoveryData): void {
		this._resumeData = data;
	}
}
