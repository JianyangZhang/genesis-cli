/**
 * The four-part tool definition model.
 *
 * Every tool in the catalog is described by:
 *   1. identity   — unique name, category, version
 *   2. contract   — parameter schema, output structure, error types
 *   3. policy     — risk level, confirmation mode, concurrency rules
 *   4. executor   — an opaque tag resolved by the runtime layer
 *
 * The executor is represented by a string tag, not a callable function.
 * This keeps `app-tools` free of execution logic and preserves the
 * dependency direction (app-tools → app-runtime types only).
 */

import type { ToolIdentity } from "./index.js";
import type { ToolContract } from "./tool-contract.js";
import type { ToolPolicy } from "./tool-policy.js";

export interface ToolDefinition {
	/** Unique identity: name and category. */
	readonly identity: ToolIdentity;

	/** Parameter/output/error contract. */
	readonly contract: ToolContract;

	/** Risk, confirmation, and concurrency policy. */
	readonly policy: ToolPolicy;

	/**
	 * Executor reference tag.
	 *
	 * The runtime layer maps this tag to an actual executor function.
	 * Built-in tools use the tool name (e.g. "read", "edit").
	 * MCP tools follow the "mcp__<server>__<tool>" convention.
	 */
	readonly executorTag: string;
}
