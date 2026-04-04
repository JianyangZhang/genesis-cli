/**
 * Risk classifier — maps a tool definition (and optional execution context)
 * to a risk level (L0-L4).
 *
 * The base risk is determined by the tool's category. Some categories
 * are further refined by inspecting parameters (e.g., destructive commands).
 */

import type { RiskLevel, ToolCategory } from "../types/index.js";
import type { ToolDefinition } from "../types/tool-definition.js";

// ---------------------------------------------------------------------------
// Category → default risk mapping
// ---------------------------------------------------------------------------

const CATEGORY_DEFAULTS: Readonly<Record<ToolCategory, RiskLevel>> = {
	"file-read": "L0",
	search: "L0",
	diagnostics: "L1",
	"file-mutation": "L2",
	network: "L3",
	"command-execution": "L3",
	mcp: "L3",
	"sub-agent": "L3",
};

// ---------------------------------------------------------------------------
// Destructive command patterns (L4 escalation)
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--no-preserve-root)/,
	/\bgit\s+push\s+.*--force/,
	/\bgit\s+reset\s+--hard/,
	/\bdd\s+/,
	/\bmkfs\b/,
	/\bformat\b/,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the risk level for a tool invocation.
 *
 * Priority:
 *   1. Tool policy explicitly overrides → use that
 *   2. Category default → use mapping
 *   3. Parameter inspection → escalate if destructive
 */
export function classifyRisk(
	toolDef: ToolDefinition,
	parameters?: Readonly<Record<string, unknown>>,
): RiskLevel {
	// If the tool policy already specifies a non-default risk, honour it.
	const policyLevel = toolDef.policy.riskLevel;
	if (policyLevel !== "L0") {
		return policyLevel;
	}

	// Category-based default.
	const category = toolDef.identity.category as ToolCategory;
	let level = CATEGORY_DEFAULTS[category] ?? "L3";

	// Escalate command-execution tools with destructive patterns.
	if (category === "command-execution" && parameters) {
		const command = parameters["command"];
		if (typeof command === "string" && isDestructiveCommand(command)) {
			level = "L4";
		}
	}

	return level;
}

/**
 * Check if a command string matches destructive patterns.
 */
export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}
