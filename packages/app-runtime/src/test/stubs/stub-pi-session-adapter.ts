/**
 * Stub implementation of PiSessionAdapter for testing.
 *
 * Provides synchronous control over event yielding so tests can
 * verify session lifecycle, event normalization, and state transitions
 * without depending on pi-mono.
 */

import type { PiSessionAdapter, RawUpstreamEvent } from "../../adapters/pi-session-adapter.js";
import type { SessionRecoveryData } from "../../types/index.js";

export class StubPiSessionAdapter implements PiSessionAdapter {
	private readonly eventsByPrompt = new Map<string, RawUpstreamEvent[]>();
	private defaultEvents: RawUpstreamEvent[] = [];
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

	// -----------------------------------------------------------------------
	// PiSessionAdapter implementation
	// -----------------------------------------------------------------------

	async *sendPrompt(input: string): AsyncIterable<RawUpstreamEvent> {
		this._lastInput = input;
		const events = this.eventsByPrompt.get(input) ?? this.defaultEvents;
		for (const event of events) {
			if (this._abortCalled) return;
			yield event;
		}
	}

	async *sendContinue(input: string): AsyncIterable<RawUpstreamEvent> {
		this._lastInput = input;
		const events = this.eventsByPrompt.get(input) ?? this.defaultEvents;
		for (const event of events) {
			if (this._abortCalled) return;
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
