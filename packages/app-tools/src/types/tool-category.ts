/**
 * Tool categories for the unified catalog.
 *
 * Every tool belongs to exactly one category, which drives
 * risk classification, permission defaults, and audit grouping.
 */

export type ToolCategory =
	| "file-read"
	| "file-mutation"
	| "search"
	| "command-execution"
	| "diagnostics"
	| "network"
	| "mcp"
	| "sub-agent";
