/**
 * SessionFacade — the primary interface for interacting with a session.
 *
 * Wraps a KernelSessionAdapter, normalizes all upstream events through
 * EventNormalizer, and exposes only product-layer RuntimeEvents.
 * State transitions are tracked and broadcast to listeners.
 *
 * Core principle: raw upstream events are NEVER exposed.
 */

import { createHash } from "node:crypto";
import { dirname, normalize as nodeNormalize } from "node:path";
import type { KernelSessionAdapter, ToolExecutionGateDecision } from "../adapters/kernel-session-adapter.js";
import type { EventBus, Unsubscribe } from "../events/event-bus.js";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent, ToolStartedEvent } from "../events/runtime-event.js";
import type { ToolGovernor } from "../governance/tool-governor.js";
import type { PlanEngine } from "../planning/plan-engine.js";
import type { PlanOrchestrator } from "../planning/plan-orchestrator.js";
import { createPlanOrchestrator } from "../planning/plan-orchestrator.js";
import { updateModel as updateContextModel, updateTaskState as updateContextTaskState } from "../runtime-context.js";
import { EventNormalizer } from "../services/event-normalizer.js";
import type {
	ModelDescriptor,
	RuntimeContext,
	SessionId,
	SessionRecoveryData,
	SessionState,
	TaskState,
} from "../types/index.js";
import { generateEventId, sessionClosed } from "./session-events.js";
import { updatePlanSummary, updateSessionModel, updateSessionStatus, updateTaskState } from "./session-state.js";

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

	/** Capture a serializable recovery snapshot without closing the session. */
	snapshotRecoveryData(): Promise<SessionRecoveryData>;

	/** Resolve a pending permission request. */
	resolvePermission(callId: string, decision: "allow" | "allow_for_session" | "allow_once" | "deny"): Promise<void>;

	/** Switch the active model for subsequent requests in this session. */
	switchModel(model: ModelDescriptor): Promise<void>;

	/** Subscribe to state changes. */
	onStateChange(listener: (state: SessionState) => void): Unsubscribe;

	/** Plan orchestrator — manage plans, enforce safety checks. Null if no plan engine provided. */
	readonly plan: PlanOrchestrator | null;

	/** Manual context compaction. Requires adapter support. */
	compact(options?: { readonly customInstructions?: string }): Promise<void>;
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
	private readonly _plan: PlanOrchestrator | null;
	private readonly _usesAdapterGovernanceHook: boolean;
	private readonly _stateListeners = new Set<(state: SessionState) => void>();
	private readonly _pendingPermissions = new Map<
		string,
		{ toolName: string; riskLevel: string; targetPath?: string; commandDigest?: string }
	>();
	private readonly _bufferedToolExecutions = new Map<
		string,
		{ startedEvent: ToolStartedEvent; bufferedEvents: RuntimeEvent[] }
	>();
	private readonly _deniedToolCalls = new Set<string>();
	private _closed = false;
	private _running = false;

	constructor(
		adapter: KernelSessionAdapter,
		initialState: SessionState,
		context: RuntimeContext,
		globalBus: EventBus,
		governor?: ToolGovernor,
		planEngine?: PlanEngine,
	) {
		this._adapter = adapter;
		this._state = initialState;
		this._context = context;
		this._events = createEventBus();
		this._globalBus = globalBus;
		this._normalizer = new EventNormalizer(initialState.id);
		this._governor = governor ?? null;
		this._usesAdapterGovernanceHook = this.installAdapterGovernanceHook();

		// Plan orchestration
		if (planEngine) {
			this._plan = createPlanOrchestrator(planEngine, this._events, this._globalBus, initialState.id);
			this._events.onCategory("plan", () => {
				const summary = this._plan!.summarize();
				if (summary) {
					this._state = updatePlanSummary(this._state, summary);
					this.notifyStateChange();
				}
			});
		} else {
			this._plan = null;
		}

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

	get plan(): PlanOrchestrator | null {
		return this._plan;
	}

	async compact(options?: { readonly customInstructions?: string }): Promise<void> {
		this.assertOpen();
		this.assertNotRunning();
		this._running = true;
		this.transitionTask({ status: "running", currentTaskId: "compact", startedAt: Date.now() });
		try {
			if (!this._adapter.sendCompact) {
				throw new Error("Adapter does not support compaction");
			}
			const stream = this._adapter.sendCompact(options?.customInstructions);
			for await (const raw of stream) {
				this.processRawEvent(raw);
			}
		} finally {
			this.transitionTask({ status: "idle", currentTaskId: null, startedAt: null });
			this._running = false;
		}
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

	async snapshotRecoveryData(): Promise<SessionRecoveryData> {
		this.assertOpen();
		return this.buildSessionRecoveryData(await this._adapter.getRecoveryData());
	}

	async close(): Promise<void> {
		if (this._closed) return;
		this._closed = true;

		this._state = updateSessionStatus(this._state, "closing");
		this.notifyStateChange();

		const recoveryData = this.buildSessionRecoveryData(await this._adapter.getRecoveryData());
		await this._adapter.close();

		const closedEvent = sessionClosed(this._state.id, recoveryData);
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

	async resolvePermission(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
	): Promise<void> {
		this.assertOpen();
		const pending = this._pendingPermissions.get(callId);
		if (!pending) {
			throw new Error(`No pending permission request for tool call: ${callId}`);
		}

		const resolvedEvent: RuntimeEvent = {
			id: generateEventId(),
			timestamp: Date.now(),
			sessionId: this._state.id,
			category: "permission",
			type: "permission_resolved",
			toolName: pending.toolName,
			toolCallId: callId,
			decision,
		};

		this.emitRuntimeEvent(resolvedEvent);

		if (decision === "allow_for_session" && this._governor) {
			this._governor.recordSessionApproval({
				sessionId: this._state.id.value,
				toolName: pending.toolName,
				riskLevel: pending.riskLevel as "L0" | "L1" | "L2" | "L3" | "L4",
				targetPattern: computeSessionApprovalTargetPattern(
					pending.toolName,
					pending.targetPath,
					this._context.workingDirectory,
				),
				commandDigest: pending.commandDigest,
				verdict: "allow_for_session",
				grantedAt: Date.now(),
			});
		}

		this._pendingPermissions.delete(callId);
		if (typeof this._adapter.resolveToolPermission === "function") {
			await this._adapter.resolveToolPermission(callId, decision);
		}
		this.flushBufferedToolExecution(callId, decision);
	}

	async switchModel(model: ModelDescriptor): Promise<void> {
		this.assertOpen();
		this.assertNotRunning();
		await this._adapter.setModel?.(model);
		this._state = updateSessionModel(this._state, model);
		this._context = updateContextModel(this._context, model);
		this.notifyStateChange();
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
				this.emitRuntimeEvent(governed);
			}
			return;
		}

		this.emitRuntimeEvent(normalized);
	}

	private installAdapterGovernanceHook(): boolean {
		if (!this._governor || typeof this._adapter.setToolExecutionGate !== "function") {
			return false;
		}

		this._adapter.setToolExecutionGate({
			beforeToolExecution: ({ toolName, toolCallId, parameters }): ToolExecutionGateDecision => {
				const targetPath = extractTargetPath(parameters);
				const decision = this._governor!.beforeExecution({
					sessionId: this._state.id.value,
					toolName,
					toolCallId,
					workingDirectory: this._context.workingDirectory,
					sessionMode: this._context.mode,
					isSubAgent: false,
					targetPath,
					parameters,
				});

				if (decision.type === "allow") {
					return decision;
				}

				if (decision.type === "ask_user") {
					this._pendingPermissions.set(toolCallId, {
						toolName,
						riskLevel: decision.riskLevel,
						targetPath,
						commandDigest: extractCommandDigest(parameters),
					});
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

	private buildSessionRecoveryData(recoveryData: SessionRecoveryData): SessionRecoveryData {
		return {
			...recoveryData,
			sessionId: this._state.id,
			model: {
				...this._state.model,
				...recoveryData.model,
				id: recoveryData.model.id || this._state.model.id,
				provider: recoveryData.model.provider || this._state.model.provider,
				displayName: recoveryData.model.displayName || this._state.model.displayName,
			},
			toolSet: recoveryData.toolSet.length > 0 ? recoveryData.toolSet : [...this._state.toolSet],
			workingDirectory: recoveryData.workingDirectory ?? this._context.workingDirectory,
			agentDir: recoveryData.agentDir ?? this._context.agentDir,
		};
	}

	/**
	 * Apply governance rules to tool events.
	 */
	private applyGovernance(normalized: RuntimeEvent): RuntimeEvent | null {
		if (!this._governor) return normalized;

		if (
			(normalized.type === "tool_update" || normalized.type === "tool_completed") &&
			this._deniedToolCalls.has(normalized.toolCallId)
		) {
			return null;
		}

		if (
			(normalized.type === "tool_update" || normalized.type === "tool_completed") &&
			this._bufferedToolExecutions.has(normalized.toolCallId)
		) {
			this._bufferedToolExecutions.get(normalized.toolCallId)!.bufferedEvents.push(normalized);
			return null;
		}

		if (normalized.type === "tool_started") {
			const targetPath =
				typeof normalized.parameters?.file_path === "string"
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
				this._pendingPermissions.set(normalized.toolCallId, {
					toolName: normalized.toolName,
					riskLevel: decision.riskLevel,
					targetPath,
					commandDigest: extractCommandDigest(normalized.parameters),
				});
				this._bufferedToolExecutions.set(normalized.toolCallId, {
					startedEvent: normalized,
					bufferedEvents: [],
				});
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

	private emitRuntimeEvent(event: RuntimeEvent): void {
		this._events.emit(event);
		this._globalBus.emit(event);
		if (this._governor && event.type === "tool_completed") {
			this._governor.afterExecution({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				status: event.status,
				durationMs: event.durationMs,
			});
		}
		this.handleStateUpdate(event);
	}

	private flushBufferedToolExecution(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
	): void {
		const buffered = this._bufferedToolExecutions.get(callId);
		if (!buffered) {
			return;
		}

		this._bufferedToolExecutions.delete(callId);
		if (decision === "deny") {
			this._deniedToolCalls.add(callId);
			this.emitRuntimeEvent({
				id: generateEventId(),
				timestamp: Date.now(),
				sessionId: this._state.id,
				category: "tool",
				type: "tool_denied",
				toolName: buffered.startedEvent.toolName,
				toolCallId: callId,
				reason: "Permission denied by user",
			});
			return;
		}

		this.emitRuntimeEvent(buffered.startedEvent);
		for (const event of buffered.bufferedEvents) {
			this.emitRuntimeEvent(event);
		}
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

function extractTargetPath(parameters: Readonly<Record<string, unknown>> | undefined): string | undefined {
	if (!parameters) {
		return undefined;
	}

	if (typeof parameters.file_path === "string") {
		return parameters.file_path;
	}

	if (typeof parameters.path === "string") {
		return parameters.path;
	}

	if (Array.isArray(parameters.file_paths)) {
		const firstPath = parameters.file_paths.find((value) => typeof value === "string" && value.length > 0);
		if (typeof firstPath === "string") {
			return firstPath;
		}
	}

	return undefined;
}

function extractCommandDigest(parameters: Readonly<Record<string, unknown>> | undefined): string | undefined {
	const command = parameters?.command;
	if (typeof command !== "string" || command.length === 0) {
		return undefined;
	}
	return `sha256:${createHash("sha256").update(command).digest("hex")}`;
}

function computeSessionApprovalTargetPattern(
	toolName: string,
	targetPath: string | undefined,
	workingDirectory: string,
): string {
	if (toolName === "write" || toolName === "edit") {
		const normalizedWorkingDirectory = nodeNormalize(workingDirectory);
		if (!targetPath) {
			return `${normalizedWorkingDirectory}/**`;
		}
		const normalizedTarget = nodeNormalize(targetPath);
		if (
			normalizedTarget === normalizedWorkingDirectory ||
			normalizedTarget.startsWith(`${normalizedWorkingDirectory}/`)
		) {
			return `${normalizedWorkingDirectory}/**`;
		}
		return `${dirname(normalizedTarget)}/**`;
	}
	if (!targetPath) {
		return "*";
	}
	const normalizedTarget = nodeNormalize(targetPath);
	return normalizedTarget;
}
