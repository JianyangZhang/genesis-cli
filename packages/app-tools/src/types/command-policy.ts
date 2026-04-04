/**
 * Command execution classification and policy types.
 *
 * Shell commands are classified into four categories based on their
 * expected runtime behaviour. The classification drives timeout defaults,
 * approval policy, and resource management.
 */

// ---------------------------------------------------------------------------
// Command class
// ---------------------------------------------------------------------------

/**
 * The classified type of a shell command.
 *
 * - "short_command"      — runs quickly (< 30s), blocks, returns result
 * - "long_task"          — extended duration, blocks, may need timeout
 * - "web_server"         — starts a persistent HTTP/WebSocket server
 * - "background_process" — runs detached, non-blocking
 */
export type CommandClass =
	| "short_command"
	| "long_task"
	| "web_server"
	| "background_process";

// ---------------------------------------------------------------------------
// Command policy
// ---------------------------------------------------------------------------

export interface CommandPolicy {
	/** The classified command type. */
	readonly commandClass: CommandClass;

	/** Working directory for the command. */
	readonly cwd: string;

	/** Whether the command blocks the caller. */
	readonly blocking: boolean;

	/** Suggested timeout in milliseconds. 0 = no timeout. */
	readonly timeoutMs: number;

	/** Risk level for this command class. */
	readonly riskLevel: string;
}
