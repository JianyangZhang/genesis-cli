/**
 * SessionFacade — the primary interface for interacting with a session.
 *
 * Wraps a PiSessionAdapter, normalizes all upstream events through
 * EventNormalizer, and exposes only product-layer RuntimeEvents.
 * State transitions are tracked and broadcast to listeners.
 *
 * Core principle: raw upstream events are NEVER exposed.
 */

import type { PiSessionAdapter } from "../adapters/pi-session-adapter.js";
import type { EventBus, Unsubscribe } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import { EventNormalizer } from "../services/event-normalizer.js";
import type { RuntimeContext, SessionId, SessionState, TaskState } from "../types/index.js";
import { sessionClosed } from "./session-events.js";
import { updateSessionStatus, updateTaskState } from "./session-state.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SessionFacade {
	/** Session identifier. */
	readonly id: SessionId;

	/** Current session state snapshot. */
	readonly state: SessionState;

	/** Execution context for this session. */
	readonly context: RuntimeContext;

	/** Session-scoped event bus (standardized events only). */
	readonly events: EventBus;

	/** Send a user prompt through the session. */
	prompt(input: string): Promise<void>;

	/** Continue an existing conversation turn. */
	continue(input: string): Promise<void>;

	/** Abort the current streaming response. */
	abort(): void;

	/** Gracefully close the session, persisting state. */
	close(): Promise<void>;

	/** Subscribe to state changes. */
	onStateChange(listener: (state: SessionState) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SessionFacadeImpl implements SessionFacade {
	private _state: SessionState;
	private readonly _context: RuntimeContext;
	private readonly _events: EventBus;
	private readonly _adapter: PiSessionAdapter;
	private readonly _globalBus: EventBus;
	private readonly _normalizer: EventNormalizer;
	private readonly _stateListeners = new Set<(state: SessionState) => void>();
	private _closed = false;

	constructor(adapter: PiSessionAdapter, initialState: SessionState, context: RuntimeContext, globalBus: EventBus) {
		this._adapter = adapter;
		this._state = initialState;
		this._context = context;
		this._events = createEventBus();
		this._globalBus = globalBus;
		this._normalizer = new EventNormalizer(initialState.id);

		// Transition from creating/recovering → active
		this._state = updateSessionStatus(this._state, "active");
	}

	get id(): SessionId {
		return this._state.id;
	}

	get state(): SessionState {
		return this._state;
	}

	get context(): RuntimeContext {
		return this._context;
	}

	get events(): EventBus {
		return this._events;
	}

	async prompt(input: string): Promise<void> {
		this.assertOpen();
		this.transitionTask({ status: "running", currentTaskId: null, startedAt: Date.now() });

		try {
			const stream = this._adapter.sendPrompt(input);
			for await (const raw of stream) {
				this.processRawEvent(raw);
			}
		} finally {
			this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
		}
	}

	async continue(input: string): Promise<void> {
		this.assertOpen();
		this.transitionTask({ status: "running", currentTaskId: null, startedAt: Date.now() });

		try {
			const stream = this._adapter.sendContinue(input);
			for await (const raw of stream) {
				this.processRawEvent(raw);
			}
		} finally {
			this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
		}
	}

	abort(): void {
		this.assertOpen();
		this._adapter.abort();
		this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
	}

	async close(): Promise<void> {
		if (this._closed) return;
		this._closed = true;

		this._state = updateSessionStatus(this._state, "closing");
		this.notifyStateChange();

		await this._adapter.close();

		const closedEvent = sessionClosed(this._state.id);
		this._events.emit(closedEvent);
		this._globalBus.emit(closedEvent);

		this._state = updateSessionStatus(this._state, "closed");
		this.notifyStateChange();

		this._events.removeAllListeners();
		this._stateListeners.clear();
	}

	onStateChange(listener: (state: SessionState) => void): Unsubscribe {
		this._stateListeners.add(listener);
		return () => {
			this._stateListeners.delete(listener);
		};
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private processRawEvent(raw: {
		type: string;
		timestamp: number;
		payload?: Readonly<Record<string, unknown>>;
	}): void {
		const normalized = this._normalizer.normalize(raw);
		if (normalized === null) return; // Drop unrecognized events

		this._events.emit(normalized);
		this._globalBus.emit(normalized);

		// Derive state updates from events
		if (normalized.category === "compaction" && normalized.type === "compaction_completed") {
			this._state = updateSessionStatus(
				{ ...this._state, compactionSummary: normalized.summary },
				this._state.status,
			);
			this.notifyStateChange();
		}
	}

	private transitionTask(taskState: TaskState): void {
		this._state = updateTaskState(this._state, taskState);
		this.notifyStateChange();
	}

	private notifyStateChange(): void {
		const snapshot = this._state;
		for (const listener of this._stateListeners) {
			listener(snapshot);
		}
	}

	private assertOpen(): void {
		if (this._closed) {
			throw new Error("Session is closed");
		}
	}
}
