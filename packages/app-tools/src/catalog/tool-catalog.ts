/**
 * ToolCatalog — the unified registry for all tool definitions.
 *
 * Built-in tools, MCP tools, and future extension tools all register
 * here. The catalog provides lookup by name and category, and is the
 * single source of truth for what tools are available.
 */

import type { ToolDefinition } from "../types/tool-definition.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ToolCatalog {
	/** Register a tool definition. Throws if a tool with the same name already exists. */
	register(definition: ToolDefinition): void;

	/** Look up a tool by its unique name. Returns undefined if not found. */
	get(name: string): ToolDefinition | undefined;

	/** List all tools in a given category. */
	getByCategory(category: string): readonly ToolDefinition[];

	/** List all registered tools. */
	listAll(): readonly ToolDefinition[];

	/** Check whether a tool with the given name is registered. */
	has(name: string): boolean;

	/** Total number of registered tools. */
	readonly size: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createToolCatalog(): ToolCatalog {
	const byName = new Map<string, ToolDefinition>();

	return {
		register(definition: ToolDefinition): void {
			const name = definition.identity.name;
			if (byName.has(name)) {
				throw new Error(`Tool already registered: ${name}`);
			}
			byName.set(name, definition);
		},

		get(name: string): ToolDefinition | undefined {
			return byName.get(name);
		},

		getByCategory(category: string): readonly ToolDefinition[] {
			const result: ToolDefinition[] = [];
			for (const def of byName.values()) {
				if (def.identity.category === category) {
					result.push(def);
				}
			}
			return result;
		},

		listAll(): readonly ToolDefinition[] {
			return [...byName.values()];
		},

		has(name: string): boolean {
			return byName.has(name);
		},

		get size(): number {
			return byName.size;
		},
	};
}
