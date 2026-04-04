/**
 * Configuration layer precedence (low to high).
 *
 * Each subsequent layer overrides the previous one.
 */
export type ConfigLayer = "default" | "global" | "project" | "session" | "cli";

/**
 * Resource directory identifiers.
 *
 * These directories are independent of runtime code and can be
 * referenced by both the CLI and subagents.
 */
export type ResourceDir = "system" | "skills" | "templates";

/**
 * Merged configuration snapshot.
 */
export interface ResolvedConfig {
	readonly layers: readonly ConfigLayer[];
}
