/**
 * Typed event bus for the product-layer runtime.
 *
 * Enforces the RuntimeEvent contract: only standardized events can be emitted
 * and consumed. No raw upstream events leak through.
 */

import type { RuntimeEvent } from "./runtime-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void;

export type EventListener<T extends RuntimeEvent = RuntimeEvent> = (event: T) => void;

export interface EventBus {
	/** Emit a standardized event to all matching listeners. */
	emit(event: RuntimeEvent): void;

	/** Subscribe to events of a specific `type`. Returns an unsubscribe function. */
	on(type: string, listener: EventListener): Unsubscribe;

	/** Subscribe to all events of a given `category`. Returns an unsubscribe function. */
	onCategory(category: string, listener: EventListener): Unsubscribe;

	/** Remove a specific type-level listener. */
	off(type: string, listener: EventListener): void;

	/** Remove all listeners. */
	removeAllListeners(): void;
	onAny(listener: EventListener): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createEventBus(): EventBus {
	const typeListeners = new Map<string, Set<EventListener>>();
	const categoryListeners = new Map<string, Set<EventListener>>();
	const anyListeners = new Set<EventListener>();

	return {
		emit(event: RuntimeEvent): void {
			for (const listener of anyListeners) {
				listener(event);
			}
			const typed = typeListeners.get(event.type);
			if (typed) {
				for (const listener of typed) {
					listener(event);
				}
			}

			const categorized = categoryListeners.get(event.category);
			if (categorized) {
				for (const listener of categorized) {
					listener(event);
				}
			}
		},

		on(type: string, listener: EventListener): Unsubscribe {
			let set = typeListeners.get(type);
			if (!set) {
				set = new Set();
				typeListeners.set(type, set);
			}
			set.add(listener);

			return () => {
				set!.delete(listener);
				if (set!.size === 0) {
					typeListeners.delete(type);
				}
			};
		},

		onCategory(category: string, listener: EventListener): Unsubscribe {
			let set = categoryListeners.get(category);
			if (!set) {
				set = new Set();
				categoryListeners.set(category, set);
			}
			set.add(listener);

			return () => {
				set!.delete(listener);
				if (set!.size === 0) {
					categoryListeners.delete(category);
				}
			};
		},

		off(type: string, listener: EventListener): void {
			const set = typeListeners.get(type);
			if (set) {
				set.delete(listener);
				if (set.size === 0) {
					typeListeners.delete(type);
				}
			}
		},

		removeAllListeners(): void {
			typeListeners.clear();
			categoryListeners.clear();
			anyListeners.clear();
		},

		onAny(listener: EventListener): Unsubscribe {
			anyListeners.add(listener);
			return () => {
				anyListeners.delete(listener);
			};
		},
	};
}
