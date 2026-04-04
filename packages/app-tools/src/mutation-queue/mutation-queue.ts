/**
 * MutationQueue — serializes file mutation operations.
 *
 * All file-mutating tools must enqueue here before execution.
 * Rules:
 *   - Same file: serialized (one mutation at a time)
 *   - Different files: concurrent allowed
 *   - Conflict: returns explicit error, never silently overwrites
 *   - After completion, the next waiting mutation can proceed
 */

import type { EnqueueResult, MutationTarget } from "../types/mutation.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MutationQueue {
	/**
	 * Enqueue a file mutation.
	 *
	 * Returns "accepted" if the mutation can proceed (no other mutation
	 * is active for the same file), or "conflict" if there is a collision.
	 */
	enqueue(target: MutationTarget): EnqueueResult;

	/**
	 * Mark a mutation as completed, removing it from the queue.
	 * Enables the next waiting mutation for that file to proceed.
	 */
	complete(toolCallId: string): void;

	/** Check if a file currently has a pending mutation. */
	isPending(filePath: string): boolean;

	/** Get the active mutation for a file, if any. */
	getActive(filePath: string): MutationTarget | undefined;

	/** Current queue length (all pending mutations). */
	readonly length: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMutationQueue(): MutationQueue {
	/**
	 * Active mutations keyed by normalized file path.
	 * Only one mutation per file at a time.
	 */
	const activeByPath = new Map<string, MutationTarget>();

	/** Reverse lookup: toolCallId → filePath for fast completion. */
	const pathByCallId = new Map<string, string>();

	return {
		enqueue(target: MutationTarget): EnqueueResult {
			const filePath = normalizePath(target.filePath);

			// Check for conflict
			const existing = activeByPath.get(filePath);
			if (existing) {
				return {
					type: "conflict",
					filePath,
					conflictingCallId: existing.toolCallId,
					message: `File "${filePath}" is already being mutated by call ${existing.toolCallId}`,
				};
			}

			// Accept
			activeByPath.set(filePath, target);
			pathByCallId.set(target.toolCallId, filePath);

			return { type: "accepted", position: activeByPath.size - 1 };
		},

		complete(toolCallId: string): void {
			const filePath = pathByCallId.get(toolCallId);
			if (filePath === undefined) return;

			activeByPath.delete(filePath);
			pathByCallId.delete(toolCallId);
		},

		isPending(filePath: string): boolean {
			return activeByPath.has(normalizePath(filePath));
		},

		getActive(filePath: string): MutationTarget | undefined {
			return activeByPath.get(normalizePath(filePath));
		},

		get length(): number {
			return activeByPath.size;
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePath(filePath: string): string {
	// Simple normalization: collapse repeated slashes and trailing slash.
	// A full path.normalize would require Node's path module.
	return filePath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
