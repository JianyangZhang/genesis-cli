import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@pickle-pee/config": fileURLToPath(new URL("../app-config/src/index.ts", import.meta.url)),
			"@pickle-pee/runtime": fileURLToPath(new URL("../app-runtime/src/index.ts", import.meta.url)),
			"@pickle-pee/tui-core": fileURLToPath(new URL("../app-tui-core/src/index.ts", import.meta.url)),
			"@pickle-pee/ui": fileURLToPath(new URL("../app-ui/src/index.ts", import.meta.url)),
		},
	},
	test: {
		include: ["src/test/**/*.test.ts"],
		// Several TTY tests patch process.stdin/stdout, so app-cli test files must not run in parallel.
		fileParallelism: false,
	},
});
