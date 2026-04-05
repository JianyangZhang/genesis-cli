/**
 * The single entry point for creating the product-layer runtime.
 *
 * `createAppRuntime()` initializes the runtime with configuration, model,
 * tool set, and adapter provisioning. All four CLI modes (interactive,
 * print, json, rpc) use the same factory and the same AppRuntime interface.
 */

import type { KernelSessionAdapter } from "./adapters/kernel-session-adapter.js";
import type { EventBus } from "./events/event-bus.js";
import { createEventBus } from "./events/event-bus.js";
import type { ToolGovernor } from "./governance/tool-governor.js";
import { createToolGovernor } from "./governance/tool-governor.js";
import type { PlanEngine } from "./planning/plan-engine.js";
import { createPlanEngine } from "./planning/plan-engine.js";
import { createRuntimeContext } from "./runtime-context.js";
import { sessionCreated, sessionResumed } from "./session/session-events.js";
import type { SessionFacade } from "./session/session-facade.js";
import { SessionFacadeImpl } from "./session/session-facade.js";
import { createInitialSessionState, recoverSessionState } from "./session/session-state.js";
import type { CliMode, ModelDescriptor, SessionRecoveryData } from "./types/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AppRuntimeConfig {
	/** Working directory for the session. */
	readonly workingDirectory: string;

	/** Agent directory (models/auth/session storage). */
	readonly agentDir?: string;

	/** Optional config source map for explainability. */
	readonly configSources?: Readonly<Record<string, { layer: string; detail: string }>>;

	/** CLI mode — determines how input/output is handled by consumers. */
	readonly mode: CliMode;

	/** Model to use for this session. */
	readonly model: ModelDescriptor;

	/** Tool names to enable. Defaults to an empty set if omitted. */
	readonly toolSet?: readonly string[];

	/**
	 * Legacy single-session adapter override.
	 * Prefer `createAdapter` for runtimes that may host multiple sessions.
	 */
	readonly adapter?: KernelSessionAdapter;

	/** Factory for creating one fresh adapter per session. */
	readonly createAdapter?: () => KernelSessionAdapter;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface AppRuntime {
	/** Create a new session. */
	createSession(): SessionFacade;

	/** Recover a previous session from serialized data. */
	recoverSession(data: SessionRecoveryData): SessionFacade;

	/** Global event bus — receives events from all sessions. */
	readonly events: EventBus;

	/** Tool governance — catalog, permissions, mutations, audit. */
	readonly governor: ToolGovernor;

	/** Plan engine — shared immutable state machine for plan management. */
	readonly planEngine: PlanEngine;

	/** Shut down the runtime and release resources. */
	shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppRuntime(config: AppRuntimeConfig): AppRuntime {
	const globalBus = createEventBus();
	const governor = createToolGovernor();
	const planEngine = createPlanEngine();
	const toolSet = new Set(config.toolSet ?? []);
	const sessions = new Set<SessionFacade>();
	let shutdown = false;
	let staticAdapterClaimed = false;

	function assertNotShutdown(): void {
		if (shutdown) {
			throw new Error("Runtime has been shut down");
		}
	}

	function getAdapter(): KernelSessionAdapter {
		if (config.createAdapter) {
			return config.createAdapter();
		}

		if (config.adapter) {
			if (staticAdapterClaimed) {
				throw new Error(
					"AppRuntimeConfig.adapter can only back a single session. Use createAdapter() to provision a fresh adapter per session.",
				);
			}
			staticAdapterClaimed = true;
			return config.adapter;
		}

		throw new Error(
			"No KernelSessionAdapter provided. Pass adapter for a single session or createAdapter for multi-session runtimes.",
		);
	}

	return {
		get events(): EventBus {
			return globalBus;
		},

		get governor(): ToolGovernor {
			return governor;
		},

		get planEngine(): PlanEngine {
			return planEngine;
		},

		createSession(): SessionFacade {
			assertNotShutdown();

			const sessionId = { value: crypto.randomUUID() };
			const state = createInitialSessionState(sessionId, config.model, toolSet);
			const context = createRuntimeContext({
				sessionId,
				workingDirectory: config.workingDirectory,
				agentDir: config.agentDir,
				configSources: config.configSources,
				mode: config.mode,
				model: config.model,
				toolSet,
			});

			const facade = new SessionFacadeImpl(getAdapter(), state, context, globalBus, governor, planEngine);

			// Emit session_created on the global bus
			const event = sessionCreated(sessionId, config.model, [...toolSet]);
			globalBus.emit(event);

			sessions.add(facade);
			return facade;
		},

		recoverSession(data: SessionRecoveryData): SessionFacade {
			assertNotShutdown();

			const state = recoverSessionState(data);
			const context = createRuntimeContext({
				sessionId: data.sessionId,
				workingDirectory: config.workingDirectory,
				agentDir: data.agentDir ?? config.agentDir,
				configSources: config.configSources,
				mode: config.mode,
				model: data.model,
				toolSet: new Set(data.toolSet),
			});

			const adapter = getAdapter();

			// Tell the adapter about the recovery so it can restore its own state.
			adapter.resume(data);

			const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor, planEngine);

			// Emit session_resumed on the global bus
			const event = sessionResumed(data.sessionId, data);
			globalBus.emit(event);

			sessions.add(facade);
			return facade;
		},

		async shutdown(): Promise<void> {
			if (shutdown) return;
			shutdown = true;

			// Close all active sessions
			for (const session of sessions) {
				try {
					await session.close();
				} catch {
					// Best-effort close during shutdown
				}
			}
			sessions.clear();
			globalBus.removeAllListeners();
		},
	};
}
