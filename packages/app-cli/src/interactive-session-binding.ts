import { join } from "node:path";
import type { RuntimeEvent, SessionFacade } from "@pickle-pee/runtime";

export interface InteractiveSessionBindingHooks {
	readonly onSessionAttached: (session: SessionFacade) => void;
	readonly onSessionEvent: (event: RuntimeEvent, session: SessionFacade) => void;
	readonly onSessionStateChange: (state: SessionFacade["state"], session: SessionFacade) => void;
}

export interface InteractiveSessionBinding {
	readonly sessionRef: { current: SessionFacade };
	switchSession(next: SessionFacade): void;
	resolveAgentDir(): string;
	dispose(): void;
}

export function createInteractiveSessionBinding(
	initialSession: SessionFacade,
	hooks: InteractiveSessionBindingHooks,
	sessionRef: { current: SessionFacade } = { current: initialSession },
): InteractiveSessionBinding {
	let detachEventListener: (() => void) | null = null;
	let detachStateListener: (() => void) | null = null;

	const bindSession = (next: SessionFacade): void => {
		detachEventListener?.();
		detachStateListener?.();
		detachEventListener = null;
		detachStateListener = null;
		sessionRef.current = next;
		hooks.onSessionAttached(next);
		detachEventListener = next.events.onAny((event: RuntimeEvent) => {
			hooks.onSessionEvent(event, next);
		});
		detachStateListener = next.onStateChange((state) => {
			hooks.onSessionStateChange(state, next);
		});
	};

	bindSession(initialSession);

	return {
		sessionRef,
		switchSession(next: SessionFacade): void {
			bindSession(next);
		},
		resolveAgentDir(): string {
			return (
				sessionRef.current.context.agentDir ??
				join(sessionRef.current.context.workingDirectory, ".genesis-local", "agent")
			);
		},
		dispose(): void {
			detachEventListener?.();
			detachStateListener?.();
			detachEventListener = null;
			detachStateListener = null;
		},
	};
}
