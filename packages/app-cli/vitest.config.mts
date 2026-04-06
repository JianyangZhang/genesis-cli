import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/test/**/*.test.ts"],
		// Several TTY tests patch process.stdin/stdout, so app-cli test files must not run in parallel.
		fileParallelism: false,
	},
});
