/**
 * Subagent task contract types.
 *
 * Defines the structured schema for dispatching work to subagents.
 * Every subagent task must specify scope, verification, and stop conditions —
 * tasks missing these are considered unsafe and cannot be dispatched.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Path scope boundaries for a subagent task. */
export interface PathScope {
	/** Paths the subagent is allowed to read and modify. Must be non-empty. */
	readonly allowedPaths: readonly string[];
	/** Paths explicitly forbidden even if within allowedPaths. */
	readonly forbiddenPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Input materials provided to a subagent. */
export interface TaskInputs {
	readonly docs: readonly string[];
	readonly files: readonly string[];
	readonly assumptions: readonly string[];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Verification type discriminator. */
export type VerificationType = "command" | "file_exists" | "no_errors" | "custom";

/** A single verification check for a subagent task. */
export interface Verification {
	readonly name: string;
	readonly type: VerificationType;
	readonly command?: string;
	readonly expected?: string;
	readonly description: string;
}

// ---------------------------------------------------------------------------
// Stop conditions
// ---------------------------------------------------------------------------

/** Stop condition type discriminator. */
export type StopConditionType =
	| "boundary_violation"
	| "max_duration_ms"
	| "max_file_count"
	| "max_mutations"
	| "error_threshold"
	| "custom";

/** A condition under which the subagent must stop immediately. */
export interface StopCondition {
	readonly type: StopConditionType;
	readonly value?: number;
	readonly description: string;
}

// ---------------------------------------------------------------------------
// Full task contract
// ---------------------------------------------------------------------------

/** The complete subagent task contract — the input schema for dispatching work. */
export interface SubagentTask {
	readonly taskId: string;
	readonly goal: string;
	readonly scope: PathScope;
	readonly inputs: TaskInputs;
	readonly deliverables: readonly string[];
	readonly verification: readonly Verification[];
	readonly stopConditions: readonly StopCondition[];
}
