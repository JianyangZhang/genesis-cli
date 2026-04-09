import { describe, expect, it, vi } from "vitest";
import { runInteractiveStartupDiagnostics, validateInteractiveModelConfiguration } from "../startup-diagnostics.js";

describe("startup-diagnostics", () => {
	const baseOptions = {
		agentDir: "/tmp/agent",
		bootstrapOverrides: {
			apiKeyEnv: "GENESIS_API_KEY",
			baseUrl: "https://example.com",
			api: "openai-compatible",
		},
		model: {
			provider: "openai",
			id: "gpt-4.1-mini",
			displayName: "GPT-4.1 mini",
		},
	} as const;

	it("validates required interactive model configuration", () => {
		expect(() =>
			validateInteractiveModelConfiguration(baseOptions, {
				GENESIS_API_KEY: "sk-test",
			} as NodeJS.ProcessEnv),
		).not.toThrow();
	});

	it("fails fast when required API key is missing", () => {
		expect(() => validateInteractiveModelConfiguration(baseOptions, {} as NodeJS.ProcessEnv)).toThrow(
			"GENESIS_API_KEY is required for interactive mode.",
		);
	});

	it("runs auth diagnostics via dedicated resolver", async () => {
		const resolver = vi.fn(async () => ({
			provider: "openai",
			modelId: "gpt-4.1-mini",
			sourceKind: "env" as const,
			placeholder: false,
			authorized: true,
		}));
		const result = await runInteractiveStartupDiagnostics({
			options: baseOptions,
			env: { GENESIS_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
			resolveAuthReport: resolver,
		});
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(result.authReport.authorized).toBe(true);
	});
});
