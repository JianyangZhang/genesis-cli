import type { EventBus } from "../events/event-bus.js";
import type { RuntimeEvent, SessionClosedEvent } from "../events/runtime-event.js";
import type { SessionRecoveryData } from "../types/index.js";
import type { SessionFacade } from "./session-facade.js";

export type SessionTurnMode = "prompt" | "continue";

export interface SessionEngineOptions {
	readonly titleResolver?: (session: SessionFacade) => string | undefined;
}

export interface SessionEngine {
	readonly activeSession: SessionFacade | null;
	createSession(options?: { readonly makeActive?: boolean }): SessionFacade;
	adoptSession(session: SessionFacade, options?: { readonly makeActive?: boolean }): SessionFacade;
	recoverSession(
		data: SessionRecoveryData,
		options?: { readonly makeActive?: boolean; readonly closeActive?: boolean },
	): Promise<SessionFacade>;
	listSessions(): readonly SessionFacade[];
	getSession(sessionId: string): SessionFacade | null;
	getSessionTitle(sessionId?: string): string | undefined;
	setSessionTitle(title: string, options?: { readonly sessionId?: string }): void;
	selectSession(sessionId: string): SessionFacade | null;
	isBusy(sessionId?: string): boolean;
	submit(input: string, options?: { readonly mode?: SessionTurnMode; readonly sessionId?: string }): Promise<void>;
	recordAssistantText(text: string, options?: { readonly sessionId?: string }): void;
	resolvePermission(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
		options?: { readonly sessionId?: string },
	): Promise<void>;
	closeSession(sessionId?: string): Promise<SessionFacade | null>;
	closeAllSessions(): Promise<void>;
	dispose(): void;
}

interface SessionEngineDeps {
	readonly runtimeEvents: EventBus;
	readonly createSession: () => SessionFacade;
	readonly recoverSession: (data: SessionRecoveryData) => SessionFacade;
	readonly recordRecentSession: (
		recoveryData: SessionRecoveryData,
		options?: { readonly title?: string },
	) => Promise<void>;
	readonly recordClosedRecentSession: (
		session: SessionFacade,
		recoveryData: SessionRecoveryData,
		options?: { readonly title?: string },
	) => Promise<void>;
	readonly recordRecentSessionInput: (
		session: SessionFacade,
		input: string,
		options?: { readonly title?: string },
	) => Promise<void>;
	readonly recordRecentSessionAssistantText: (
		session: SessionFacade,
		text: string,
		options?: { readonly title?: string },
	) => Promise<void>;
	readonly scheduleRecentSessionEvent: (
		session: SessionFacade,
		event: RuntimeEvent,
		options?: { readonly title?: string },
	) => void;
}

export function createSessionEngine(deps: SessionEngineDeps, options: SessionEngineOptions = {}): SessionEngine {
	const sessions = new Map<string, SessionFacade>();
	const activeTurns = new Map<string, Promise<void>>();
	const sessionTitles = new Map<string, string>();
	const pendingCloseWrites = new Map<string, Promise<void>>();
	let activeSessionId: string | null = null;

	const unsubscribeClosed = deps.runtimeEvents.on("session_closed", (event) => {
		const closed = event as SessionClosedEvent;
		const session = sessions.get(closed.sessionId.value);
		if (!session) {
			return;
		}
		const closeWrite = deps
			.recordClosedRecentSession(session, closed.recoveryData, {
				title: sessionTitles.get(session.id.value) ?? options.titleResolver?.(session),
			})
			.finally(() => {
				pendingCloseWrites.delete(closed.sessionId.value);
			});
		pendingCloseWrites.set(closed.sessionId.value, closeWrite);
		sessions.delete(closed.sessionId.value);
		activeTurns.delete(closed.sessionId.value);
		sessionTitles.delete(closed.sessionId.value);
		if (activeSessionId === closed.sessionId.value) {
			activeSessionId = null;
		}
	});
	const unsubscribeProjectedEvents = deps.runtimeEvents.onAny((event) => {
		if (event.category === "session" && event.type === "session_error" && event.fatal) {
			activeTurns.delete(event.sessionId.value);
		}
		const session = sessions.get(event.sessionId.value);
		if (!session) {
			return;
		}
		try {
			deps.scheduleRecentSessionEvent(session, event, {
				title: resolveSessionTitle(session),
			});
		} catch {
			// event-derived recent-session projection must not break the live session path
		}
	});

	function registerSession(session: SessionFacade, makeActive = true): SessionFacade {
		sessions.set(session.id.value, session);
		if (makeActive) {
			activeSessionId = session.id.value;
		}
		return session;
	}

	function resolveSession(sessionId?: string): SessionFacade | null {
		const effectiveSessionId = sessionId ?? activeSessionId;
		if (!effectiveSessionId) {
			return null;
		}
		return sessions.get(effectiveSessionId) ?? null;
	}

	function resolveSessionTitle(session: SessionFacade): string | undefined {
		return sessionTitles.get(session.id.value) ?? options.titleResolver?.(session);
	}

	function swallowBackgroundWrite(promise: Promise<void>): void {
		void promise.catch(() => {
			// recent-session persistence must never surface as an unhandled rejection
			// on the host lifecycle path
		});
	}

	function hasSessionFile(recoveryData: SessionRecoveryData): boolean {
		return typeof recoveryData.sessionFile === "string" && recoveryData.sessionFile.length > 0;
	}

	async function persistRecentSessionCheckpoint(session: SessionFacade): Promise<void> {
		const title = resolveSessionTitle(session);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const recoveryData = await session.snapshotRecoveryData();
			if (hasSessionFile(recoveryData)) {
				await deps.recordRecentSession(recoveryData, { title });
				return;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 80 * (attempt + 1));
				timer.unref?.();
			});
		}
	}

	return {
		get activeSession(): SessionFacade | null {
			return resolveSession();
		},

		createSession(optionsInput = {}): SessionFacade {
			const session = deps.createSession();
			return registerSession(session, optionsInput.makeActive !== false);
		},

		adoptSession(session: SessionFacade, optionsInput = {}): SessionFacade {
			return registerSession(session, optionsInput.makeActive !== false);
		},

		async recoverSession(data: SessionRecoveryData, optionsInput = {}): Promise<SessionFacade> {
			if (optionsInput.closeActive !== false && activeSessionId !== null) {
				await this.closeSession(activeSessionId);
			}
			const session = deps.recoverSession(data);
			return registerSession(session, optionsInput.makeActive !== false);
		},

		listSessions(): readonly SessionFacade[] {
			return [...sessions.values()];
		},

		getSession(sessionId: string): SessionFacade | null {
			return sessions.get(sessionId) ?? null;
		},

		getSessionTitle(sessionId?: string): string | undefined {
			const session = resolveSession(sessionId);
			return session ? sessionTitles.get(session.id.value) : undefined;
		},

		setSessionTitle(title: string, optionsInput = {}): void {
			const session = resolveSession(optionsInput.sessionId);
			if (!session) {
				throw new Error("No active session");
			}
			sessionTitles.set(session.id.value, title);
		},

		selectSession(sessionId: string): SessionFacade | null {
			const session = sessions.get(sessionId) ?? null;
			if (session) {
				activeSessionId = sessionId;
			}
			return session;
		},

		isBusy(sessionId?: string): boolean {
			const session = resolveSession(sessionId);
			return session ? activeTurns.has(session.id.value) : false;
		},

		submit(input: string, optionsInput = {}): Promise<void> {
			const session = resolveSession(optionsInput.sessionId);
			if (!session) {
				return Promise.reject(new Error("No active session"));
			}
			if (activeTurns.has(session.id.value)) {
				return Promise.reject(new Error("Session is already processing a turn"));
			}
			swallowBackgroundWrite(
				deps.recordRecentSessionInput(session, input, {
					title: resolveSessionTitle(session),
				}),
			);
			const turn = optionsInput.mode === "continue" ? session.continue(input) : session.prompt(input);
			activeTurns.set(
				session.id.value,
				turn.finally(() => {
					activeTurns.delete(session.id.value);
				}),
			);
			swallowBackgroundWrite(persistRecentSessionCheckpoint(session));
			return activeTurns.get(session.id.value)!;
		},

		recordAssistantText(text: string, optionsInput = {}): void {
			const session = resolveSession(optionsInput.sessionId);
			if (!session) {
				// Late assistant flushes can race with a completed session teardown.
				// Ignore silently so host teardown and next-turn recovery can proceed.
				return;
			}
			swallowBackgroundWrite(
				deps.recordRecentSessionAssistantText(session, text, {
					title: resolveSessionTitle(session),
				}),
			);
		},

		resolvePermission(
			callId: string,
			decision: "allow" | "allow_for_session" | "allow_once" | "deny",
			optionsInput = {},
		): Promise<void> {
			const session = resolveSession(optionsInput.sessionId);
			if (!session) {
				return Promise.reject(new Error("No active session"));
			}
			return session.resolvePermission(callId, decision);
		},

		async closeSession(sessionId?: string): Promise<SessionFacade | null> {
			const session = resolveSession(sessionId);
			if (!session) {
				return null;
			}
			await session.close();
			const closeWrite = pendingCloseWrites.get(session.id.value);
			if (closeWrite) {
				await closeWrite;
			}
			return session;
		},

		async closeAllSessions(): Promise<void> {
			for (const session of [...sessions.values()]) {
				await this.closeSession(session.id.value);
			}
		},

		dispose(): void {
			unsubscribeClosed();
			unsubscribeProjectedEvents();
			sessions.clear();
			activeTurns.clear();
			sessionTitles.clear();
			pendingCloseWrites.clear();
			activeSessionId = null;
		},
	};
}
