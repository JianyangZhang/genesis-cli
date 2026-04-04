/**
 * Path scope boundary checking.
 *
 * Uses normalize + prefix matching to determine whether a path falls within
 * a subagent's allowed scope. Supports glob-style `/**` suffix to mean
 * "this directory and everything below it".
 */

import { normalize } from "node:path";
import type { PathScope } from "./task-types.js";

// ---------------------------------------------------------------------------
// Internal: strip trailing /** for prefix matching
// ---------------------------------------------------------------------------

/**
 * Convert a scope pattern to a directory prefix for matching.
 * `packages/app-runtime/**` → `packages/app-runtime`
 * `packages/app-runtime`    → `packages/app-runtime`
 */
function toPrefix(pattern: string): string {
	const norm = normalize(pattern);
	if (norm.endsWith("/**") || norm.endsWith("/**")) {
		return norm.slice(0, -3);
	}
	return norm;
}

/** Check if `filePath` is under or equal to `dirPrefix`. */
function isUnderPrefix(filePath: string, dirPrefix: string): boolean {
	return filePath === dirPrefix || filePath.startsWith(`${dirPrefix}/`);
}

// ---------------------------------------------------------------------------
// Single-path checks
// ---------------------------------------------------------------------------

/** Check if a path is within the allowed scope of a task. */
export function isPathAllowed(scope: PathScope, filePath: string): boolean {
	const normalized = normalize(filePath);
	return scope.allowedPaths.some((allowed) => {
		const prefix = toPrefix(allowed);
		return isUnderPrefix(normalized, prefix);
	});
}

/** Check if a path is explicitly forbidden. */
export function isPathForbidden(scope: PathScope, filePath: string): boolean {
	const normalized = normalize(filePath);
	return scope.forbiddenPaths.some((forbidden) => {
		const prefix = toPrefix(forbidden);
		return isUnderPrefix(normalized, prefix);
	});
}

/** Check if a modification to a path would violate the task boundary. */
export function wouldViolateBoundary(scope: PathScope, filePath: string): boolean {
	return !isPathAllowed(scope, filePath) || isPathForbidden(scope, filePath);
}

// ---------------------------------------------------------------------------
// Scope-pair checks
// ---------------------------------------------------------------------------

/**
 * Check whether two path scopes share any allowed paths.
 * Used to determine if two subagent tasks can safely run concurrently.
 */
export function scopesOverlap(a: PathScope, b: PathScope): boolean {
	return a.allowedPaths.some((pathA) =>
		b.allowedPaths.some((pathB) => {
			const pA = toPrefix(pathA);
			const pB = toPrefix(pathB);
			return pA.startsWith(pB) || pB.startsWith(pA);
		}),
	);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Check that allowedPaths and forbiddenPaths do not overlap.
 * Returns true if the scope is consistent (no overlap).
 */
export function isScopeConsistent(scope: PathScope): boolean {
	return !scope.allowedPaths.some((allowed) =>
		scope.forbiddenPaths.some((forbidden) => {
			const pA = toPrefix(allowed);
			const pF = toPrefix(forbidden);
			return pA === pF || pA.startsWith(`${pF}/`) || pF.startsWith(`${pA}/`);
		}),
	);
}
