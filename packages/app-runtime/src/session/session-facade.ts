/**
 * SessionFacade — the primary interface for interacting with a session.
 *
 * Wraps a KernelSessionAdapter, normalizes all upstream events through
 * EventNormalizer, and exposes only product-layer RuntimeEvents.
 * State transitions are tracked and broadcast to listeners.
 *
 * Core principle: raw upstream events are NEVER exposed.
 */

import type {
	KernelSessionAdapter,
	ToolExecutionGateDecision,
} from "../adapters/kernel-session-adapter.js";
import type { EventBus, Unsubscribe } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ToolGovernor } from "../governance/tool-governor.js";
import { updateTaskState as updateContextTaskState } from "../runtime-context.js";
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
	private _context: RuntimeContext;
	private readonly _events: EventBus;
	private readonly _adapter: KernelSessionAdapter;
	private readonly _globalBus: EventBus;
	private readonly _normalizer: EventNormalizer;
	private readonly _governor: ToolGovernor | null;
	private readonly _usesAdapterGovernanceHook: boolean;
	private readonly _stateListeners = new Set<(state: SessionState) => void>();
	private _closed = false;
	private _running = false;

	constructor(
		adapter: KernelSessionAdapter,
		initialState: SessionState,
		context: RuntimeContext,
		globalBus: EventBus,
		governor?: ToolGovernor,
	) {
		this._adapter = adapter;
		this._state = initialState;
		this._context = context;
		this._events = createEventBus();
		this._globalBus = globalBus;
		this._normalizer = new EventNormalizer(initialState.id);
		this._governor = governor ?? null;
		this._usesAdapterGovernanceHook = this.installAdapterGovernanceHook();

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
		this.assertNotRunning();
		this._running = true;
		this.transitionTask({ status: "running", currentTaskId: null, startedAt: Date.now() });

		try {
			const stream = this._adapter.sendPrompt(input);
			for await (const raw of stream) {
				this.processRawEvent(raw);
			}
		} finally {
			this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
			this._running = false;
		}
	}

	async continue(input: string): Promise<void> {
		this.assertOpen();
		this.assertNotRunning();
		this._running = true;
		this.transitionTask({ status: "running", currentTaskId: null, startedAt: Date.now() });

		try {
			const stream = this._adapter.sendContinue(input);
			for await (const raw of stream) {
				this.processRawEvent(raw);
			}
		} finally {
			this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
			this._running = false;
		}
	}

	abort(): void {
		this.assertOpen();
		if (!this._running) {
			return;
		}

		// Keep the running lock until the active stream actually settles.
		this._adapter.abort();
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

		// Fallback governance interception for adapters that cannot pre-gate tools.
		if (this._governor && !this._usesAdapterGovernanceHook && normalized.category === "tool") {
			const governed = this.applyGovernance(normalized);
			if (governed !== null) {
				this._events.emit(governed);
				this._globalBus.emit(governed);
			}
			this.handleStateUpdate(normalized);
			return;
		}

		this._events.emit(normalized);
		this._globalBus.emit(normalized);
		if (this._governor && normalized.type === "tool_completed") {
			this._governor.afterExecution({
				toolName: normalized.toolName,
				toolCallId: normalized.toolCallId,
				status: normalized.status,
				durationMs: normalized.durationMs,
			});
		}
		this.handleStateUpdate(normalized);
	}

	private installAdapterGovernanceHook(): boolean {
		if (!this._governor || typeof this._adapter.setToolExecutionGate !== "function") {
			return false;
		}

		this._adapter.setToolExecutionGate({
			beforeToolExecution: ({ toolName, toolCallId, parameters }): ToolExecutionGateDecision => {
				const decision = this._governor!.beforeExecution({
					sessionId: this._state.id.value,
					toolName,
					toolCallId,
					workingDirectory: this._context.workingDirectory,
					sessionMode: this._context.mode,
					isSubAgent: false,
					targetPath: extractTargetPath(parameters),
					parameters,
				});

				if (decision.type === "allow") {
					return decision;
				}

				return {
					type: decision.type,
					reason: decision.reason,
					riskLevel: decision.riskLevel,
				};
			},
		});

		return true;
	}

	/**
	 * Apply governance rules to tool events.
	 */
	private applyGovernance(normalized: RuntimeEvent): RuntimeEvent | null {
		if (!this._governor) return normalized;

		if (normalized.type === "tool_started") {
			const targetPath = typeof normalized.parameters?.file_path === "string"
				? normalized.parameters.file_path
				: typeof normalized.parameters?.path === "string"
					? normalized.parameters.path
					: undefined;

			const decision = this._governor.beforeExecution({
				sessionId: this._state.id.value,
				toolName: normalized.toolName,
				toolCallId: normalized.toolCallId,
				workingDirectory: this._context.workingDirectory,
				sessionMode: this._context.mode,
				isSubAgent: false,
				targetPath,
				parameters: normalized.parameters,
			});

			if (decision.type === "deny") {
				return {
					id: normalized.id,
					timestamp: normalized.timestamp,
					sessionId: normalized.sessionId,
					category: "tool",
					type: "tool_denied",
					toolName: normalized.toolName,
					toolCallId: normalized.toolCallId,
					reason: decision.reason,
				};
			}

			if (decision.type === "ask_user") {
				return {
					id: normalized.id,
					timestamp: normalized.timestamp,
					sessionId: normalized.sessionId,
					category: "permission",
					type: "permission_requested",
					toolName: normalized.toolName,
					toolCallId: normalized.toolCallId,
					riskLevel: decision.riskLevel,
				};
			}

			return normalized;
		}

		if (normalized.type === "tool_completed") {
			this._governor.afterExecution({
				toolName: normalized.toolName,
				toolCallId: normalized.toolCallId,
				status: normalized.status,
				durationMs: normalized.durationMs,
			});
			return normalized;
		}

		// tool_update, tool_denied, etc. — pass through
		return normalized;
	}

	private handleStateUpdate(normalized: RuntimeEvent): void {
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
		this._context = updateContextTaskState(this._context, taskState);
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

	private assertNotRunning(): void {
		if (this._running) {
			throw new Error("Session is already running a prompt or continue operation");
		}
	}
}

function extractTargetPath(
	parameters: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	if (!parameters) {
		return undefined;
	}

	if (typeof parameters.file_path === "string") {
		return parameters.file_path;
	}

	if (typeof parameters.path === "string") {
		return parameters.path;
	}

	return undefined;
}
