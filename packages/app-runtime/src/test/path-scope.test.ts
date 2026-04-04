import { describe, expect, it } from "vitest";
import { isPathAllowed, isPathForbidden, scopesOverlap, wouldViolateBoundary } from "../subagent/path-scope.js";
import type { PathScope } from "../subagent/task-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scope: PathScope = {
	allowedPaths: ["packages/app-runtime/**", "packages/app-tools/**"],
	forbiddenPaths: ["packages/app-runtime/src/test/**", "packages/app-ui/**"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PathScope", () => {
	describe("isPathAllowed", () => {
		it("returns true for path under allowed prefix", () => {
			expect(isPathAllowed(scope, "packages/app-runtime/src/session.ts")).toBe(true);
		});

		it("returns true for exact match with allowed path", () => {
			expect(isPathAllowed(scope, "packages/app-runtime/**")).toBe(true);
		});

		it("returns false for path outside all allowed paths", () => {
			expect(isPathAllowed(scope, "packages/app-cli/src/index.ts")).toBe(false);
		});

		it("handles dot segments via normalization", () => {
			expect(isPathAllowed(scope, "packages/./app-runtime/src/x.ts")).toBe(true);
		});
	});

	describe("isPathForbidden", () => {
		it("returns true for explicitly forbidden path", () => {
			expect(isPathForbidden(scope, "packages/app-runtime/src/test/foo.test.ts")).toBe(true);
		});

		it("returns true for child of forbidden path", () => {
			expect(isPathForbidden(scope, "packages/app-ui/src/index.ts")).toBe(true);
		});

		it("returns false for non-forbidden path", () => {
			expect(isPathForbidden(scope, "packages/app-runtime/src/session.ts")).toBe(false);
		});
	});

	describe("wouldViolateBoundary", () => {
		it("returns false for allowed non-forbidden path", () => {
			expect(wouldViolateBoundary(scope, "packages/app-runtime/src/engine.ts")).toBe(false);
		});

		it("returns true for path outside allowed scope", () => {
			expect(wouldViolateBoundary(scope, "packages/app-cli/src/index.ts")).toBe(true);
		});

		it("returns true for forbidden path within allowed scope", () => {
			// Path is under allowedPaths but also under forbiddenPaths
			expect(wouldViolateBoundary(scope, "packages/app-runtime/src/test/x.test.ts")).toBe(true);
		});
	});

	describe("scopesOverlap", () => {
		it("returns true when allowed paths overlap", () => {
			const a: PathScope = { allowedPaths: ["packages/a/**"], forbiddenPaths: [] };
			const b: PathScope = { allowedPaths: ["packages/a/**"], forbiddenPaths: [] };
			expect(scopesOverlap(a, b)).toBe(true);
		});

		it("returns true for nested paths", () => {
			const a: PathScope = { allowedPaths: ["packages/**"], forbiddenPaths: [] };
			const b: PathScope = { allowedPaths: ["packages/a/**"], forbiddenPaths: [] };
			expect(scopesOverlap(a, b)).toBe(true);
		});

		it("returns false for disjoint scopes", () => {
			const a: PathScope = { allowedPaths: ["packages/a/**"], forbiddenPaths: [] };
			const b: PathScope = { allowedPaths: ["packages/b/**"], forbiddenPaths: [] };
			expect(scopesOverlap(a, b)).toBe(false);
		});
	});
});
