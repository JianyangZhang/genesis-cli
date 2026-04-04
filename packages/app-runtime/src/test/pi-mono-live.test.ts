import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PiMonoSessionAdapter } from "../adapters/pi-mono-session-adapter.js";
import type { RawUpstreamEvent } from "../adapters/kernel-session-adapter.js";

const hasLiveOpenAiConfig =
	Boolean(process.env.GENESIS_API_KEY) &&
	Boolean(process.env.GENESIS_LIVE_OPENAI_BASE_URL) &&
	Boolean(process.env.GENESIS_MODEL_PROVIDER) &&
	Boolean(process.env.GENESIS_MODEL_ID);

const liveDescribe = hasLiveOpenAiConfig ? describe : describe.skip;
let resolvedModelIdPromise: Promise<string> | null = null;
let piMonoSessionAvailabilityPromise: Promise<{ available: boolean; reason?: string }> | null = null;

liveDescribe("PiMono live adapter", () => {
	it(
		"sends a non-streaming OpenAI-compatible request",
		async () => {
			const modelId = await resolveLiveModelId();
			const response = await requestOpenAiCompletion(modelId, "Reply exactly LIVE_OPENAI_OK");

			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			expect(payload.choices?.[0]?.message?.content).toContain("LIVE_OPENAI_OK");
		},
		30_000,
	);

	it(
		"streams a real conversation with thinking off and remembers context across turns",
		async () => {
			if (!(await ensurePiMonoSessionAvailable())) {
				return;
			}
			const adapter = await createLiveAdapter("off");
			try {
				const firstTurn = await collectEvents(adapter.sendPrompt("Remember the codeword BANANA and reply exactly ACK."));
				const secondTurn = await collectEvents(
					adapter.sendPrompt("What is the codeword I asked you to remember? Reply exactly BANANA."),
				);

				expect(extractAssistantText(firstTurn)).toContain("ACK");
				expect(extractAssistantText(secondTurn)).toContain("BANANA");
				expect(firstTurn.some((event) => event.type === "message_update")).toBe(true);
				expect(secondTurn.some((event) => event.type === "message_update")).toBe(true);
			} finally {
				await adapter.close();
			}
		},
		90_000,
	);

	it(
		"streams a real conversation with thinking enabled",
		async () => {
			if (!(await ensurePiMonoSessionAvailable())) {
				return;
			}
			const adapter = await createLiveAdapter("minimal");
			try {
				const events = await collectEvents(adapter.sendPrompt("Reply exactly THINKING_ON_OK."));
				expect(extractAssistantText(events)).toContain("THINKING_ON_OK");
			} finally {
				await adapter.close();
			}
		},
		90_000,
	);
});

async function createLiveAdapter(thinkingLevel: "off" | "minimal"): Promise<PiMonoSessionAdapter> {
	const modelId = await resolveLiveModelId();
	const agentDir = await mkdtemp(join(tmpdir(), "genesis-pi-live-"));
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "models.json"), `${JSON.stringify(createModelsJson(modelId), null, 2)}\n`, "utf8");

	return new PiMonoSessionAdapter({
		workingDirectory: process.cwd(),
		agentDir,
		model: {
			provider: process.env.GENESIS_MODEL_PROVIDER!,
			id: modelId,
			displayName: process.env.GENESIS_MODEL_DISPLAY_NAME ?? modelId,
		},
		toolSet: ["read", "bash", "edit", "write"],
		thinkingLevel,
	});
}

function createModelsJson(modelId: string): Record<string, unknown> {
	return {
		providers: {
			[process.env.GENESIS_MODEL_PROVIDER!]: {
				baseUrl: process.env.GENESIS_LIVE_OPENAI_BASE_URL,
				api: "openai-completions",
				apiKey: "GENESIS_API_KEY",
				authHeader: true,
				models: [
					{
						id: modelId,
						name: process.env.GENESIS_MODEL_DISPLAY_NAME ?? modelId,
						reasoning: true,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 16384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
}

async function resolveLiveModelId(): Promise<string> {
	if (!resolvedModelIdPromise) {
		resolvedModelIdPromise = (async () => {
			let lastError = "No model candidates tried";
			for (const modelId of getModelCandidates()) {
				const response = await requestOpenAiCompletion(modelId, "Reply exactly MODEL_READY");
				if (response.status === 200) {
					return modelId;
				}

				const text = await response.text();
				lastError = `${response.status}: ${text}`;
				if (response.status === 403 && text.includes("No permission")) {
					continue;
				}

				throw new Error(`Live model probe failed for ${modelId}: ${lastError}`);
			}
			throw new Error(`No live model is accessible. Last error: ${lastError}`);
		})();
	}

	return await resolvedModelIdPromise;
}

async function ensurePiMonoSessionAvailable(): Promise<boolean> {
	if (!piMonoSessionAvailabilityPromise) {
		piMonoSessionAvailabilityPromise = (async () => {
			const modelId = await resolveLiveModelId();
			const agentDir = await mkdtemp(join(tmpdir(), "genesis-pi-probe-"));
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "models.json"), `${JSON.stringify(createModelsJson(modelId), null, 2)}\n`, "utf8");

			const kernelModulePath = pathToFileURL(resolve(process.cwd(), "packages/kernel/src/index.ts")).href;
			const sdk = (await import(kernelModulePath)) as {
				AuthStorage: { create(filePath?: string): unknown };
				ModelRegistry: {
					create(authStorage: unknown, modelsPath?: string): { find(provider: string, modelId: string): unknown };
				};
				createAgentSession(options: Record<string, unknown>): Promise<{
					session: {
						subscribe(listener: (event: unknown) => void): () => void;
						prompt(input: string): Promise<void>;
					};
				}>;
			};

			const authStorage = sdk.AuthStorage.create(join(agentDir, "auth.json"));
			const modelRegistry = sdk.ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const model = modelRegistry.find(process.env.GENESIS_MODEL_PROVIDER!, modelId);
			const { session } = await sdk.createAgentSession({
				cwd: process.cwd(),
				agentDir,
				authStorage,
				modelRegistry,
				model,
				thinkingLevel: "off",
				tools: [],
			});

			const events: unknown[] = [];
			const unsubscribe = session.subscribe((event) => {
				events.push(event);
			});
			await session.prompt("Reply exactly SESSION_READY.");
			unsubscribe();

			const assistantError = events.find((event) => {
				return (
					typeof event === "object" &&
					event !== null &&
					(event as { type?: string }).type === "message_end" &&
					(event as { message?: { role?: string; errorMessage?: string } }).message?.role === "assistant" &&
					typeof (event as { message?: { errorMessage?: string } }).message?.errorMessage === "string"
				);
			}) as { message?: { errorMessage?: string } } | undefined;

			if (assistantError?.message?.errorMessage?.includes("GLM Coding Plan")) {
				return {
					available: false,
					reason: assistantError.message.errorMessage,
				};
			}

			return { available: true };
		})();
	}

	const availability = await piMonoSessionAvailabilityPromise;
	if (!availability.available) {
		console.warn(`Skipping Genesis kernel live session checks: ${availability.reason}`);
	}
	return availability.available;
}

function getModelCandidates(): readonly string[] {
	const candidates = [process.env.GENESIS_MODEL_ID, "glm-5", "glm-4.7"].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return [...new Set(candidates)];
}

async function requestOpenAiCompletion(modelId: string, prompt: string): Promise<Response> {
	return await fetch(new URL("chat/completions", process.env.GENESIS_LIVE_OPENAI_BASE_URL!).toString(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.GENESIS_API_KEY}`,
		},
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: prompt }],
			stream: false,
		}),
	});
}

async function collectEvents(stream: AsyncIterable<RawUpstreamEvent>): Promise<RawUpstreamEvent[]> {
	const events: RawUpstreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function extractAssistantText(events: readonly RawUpstreamEvent[]): string {
	return events
		.filter((event) => event.type === "message_update" && event.payload?.kind === "text")
		.map((event) => event.payload?.content)
		.filter((content): content is string => typeof content === "string")
		.join("");
}
