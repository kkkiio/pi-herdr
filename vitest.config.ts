import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: ["test/bdd/**", "dist/**", "node_modules/**"],
		clearMocks: true,
		restoreMocks: true,
		fileParallelism: false,
		passWithNoTests: false,
		testTimeout: 10_000,
		hookTimeout: 10_000,
	},
});
