/**
 * Standardized product-layer event types.
 *
 * All events emitted by the runtime are normalized here so that
 * UI, tools, and extensions consume a stable contract instead of
 * raw upstream events.
 */
export interface RuntimeEvent {
	readonly type: string;
	readonly timestamp: number;
}

/**
 * Session state tracked by the runtime.
 */
export interface SessionState {
	readonly id: string;
	readonly createdAt: number;
}

/**
 * Context object available to all runtime consumers.
 */
export interface RuntimeContext {
	readonly sessionId: string;
}
