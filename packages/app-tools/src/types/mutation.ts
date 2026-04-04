/**
 * File mutation queue types.
 *
 * All file-mutating tools must pass through the mutation queue.
 * The queue ensures:
 *   - Same file: serialized (one mutation at a time)
 *   - Same task: maintain ordering
 *   - Conflict: explicit error, never silently overwrite
 */

// ---------------------------------------------------------------------------
// Mutation target
// ---------------------------------------------------------------------------

export interface MutationTarget {
	/** The file path being mutated. Must be an absolute path. */
	readonly filePath: string;
	/** The tool call ID requesting the mutation. */
	readonly toolCallId: string;
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export interface QueueConflict {
	readonly type: "conflict";
	readonly filePath: string;
	readonly conflictingCallId: string;
	readonly message: string;
}

// ---------------------------------------------------------------------------
// Enqueue result
// ---------------------------------------------------------------------------

export type EnqueueResult =
	| { readonly type: "accepted"; readonly position: number }
	| QueueConflict;
