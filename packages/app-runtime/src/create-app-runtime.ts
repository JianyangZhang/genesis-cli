/**
 * The single entry point for creating the product-layer runtime.
 *
 * `createAppRuntime()` initializes the runtime with configuration, model,
 * tool set, and an optional adapter override. All four CLI modes (interactive,
 * print, json, rpc) use the same factory and the same AppRuntime interface.
 */

import type { PiSessionAdapter } from "./adapters/pi-session-adapter.js";
import type { EventBus } from "./events/event-bus.js";
import { createEventBus } from "./events/event-bus.js";
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

	/** CLI mode — determines how input/output is handled by consumers. */
	readonly mode: CliMode;

	/** Model to use for this session. */
	readonly model: ModelDescriptor;

	/** Tool names to enable. Defaults to an empty set if omitted. */
	readonly toolSet?: readonly string[];

	/**
	 * Adapter override for testing or custom backends.
	 * If omitted, a stub adapter must be provided when creating sessions.
	 */
	readonly adapter?: PiSessionAdapter;

	/** Recovery data to resume a previous session. */
	readonly recoveryData?: SessionRecoveryData;
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

	/** Shut down the runtime and release resources. */
	shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppRuntime(config: AppRuntimeConfig): AppRuntime {
	const globalBus = createEventBus();
	const toolSet = new Set(config.toolSet ?? []);
	const sessions = new Set<SessionFacade>();
	let shutdown = false;

	function assertNotShutdown(): void {
		if (shutdown) {
			throw new Error("Runtime has been shut down");
		}
	}

	return {
		get events(): EventBus {
			return globalBus;
		},

		createSession(): SessionFacade {
			assertNotShutdown();

			const sessionId = { value: crypto.randomUUID() };
			const state = createInitialSessionState(sessionId, config.model, toolSet);
			const context = createRuntimeContext({
				sessionId,
				workingDirectory: config.workingDirectory,
				mode: config.mode,
				model: config.model,
				toolSet,
			});

			if (!config.adapter) {
				throw new Error(
					"No PiSessionAdapter provided. Pass an adapter in the config or provide one at session creation.",
				);
			}

			const facade = new SessionFacadeImpl(config.adapter, state, context, globalBus);

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
				mode: config.mode,
				model: data.model,
				toolSet: new Set(data.toolSet),
			});

			if (!config.adapter) {
				throw new Error(
					"No PiSessionAdapter provided. Pass an adapter in the config or provide one at session creation.",
				);
			}

			const facade = new SessionFacadeImpl(config.adapter, state, context, globalBus);

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
