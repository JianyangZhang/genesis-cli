import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import { KernelAssistantMessageEventStream } from "../event-stream.js";

type KernelOpenAiCompat = {
	readonly supportsDeveloperRole?: boolean;
	readonly supportsUsageInStreaming?: boolean;
	readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
	readonly requiresToolResultName?: boolean;
	readonly requiresAssistantAfterToolResult?: boolean;
	readonly requiresThinkingAsText?: boolean;
	readonly thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
	readonly zaiToolStream?: boolean;
	readonly supportsStrictMode?: boolean;
};

type KernelOpenAiStreamOptions = SimpleStreamOptions & {
	readonly toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
};

export function streamOpenAiCompletions(
	model: Model<"openai-completions">,
	context: Context,
	options?: KernelOpenAiStreamOptions,
) {
	const stream = new KernelAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const compat = getCompat(model);
			let body = buildRequestBody(model, context, compat, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as Record<string, unknown>;
			}

			const response = await fetch(resolveEndpoint(model.baseUrl, "chat/completions"), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(options?.headers ?? {}),
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok) {
				throw new Error(`${response.status} ${await response.text()}`);
			}
			if (!response.body) {
				throw new Error("Provider returned an empty response body.");
			}

			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | (ToolCall & { partialArgs?: string }) | null = null;
			const currentIndex = () => output.content.length - 1;
			const finishBlock = (): void => {
				if (!currentBlock) {
					return;
				}
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: currentIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else if (currentBlock.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: currentIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				} else if (currentBlock.type === "toolCall") {
					currentBlock.arguments = safeParseJson(currentBlock.partialArgs ?? "");
					delete currentBlock.partialArgs;
					stream.push({
						type: "toolcall_end",
						contentIndex: currentIndex(),
						toolCall: currentBlock,
						partial: output,
					});
				}
			};

			for await (const data of iterateSseData(response.body, options?.signal)) {
				if (data === "[DONE]") {
					break;
				}
				const chunk = safeParseJson(data) as Record<string, unknown>;
				if (!chunk) {
					continue;
				}

				output.responseId ||= asString(chunk.id);
				if (isRecord(chunk.usage)) {
					output.usage = parseUsage(chunk.usage);
				}

				const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
				if (!choice) {
					continue;
				}

				const finishReason = asString(choice.finish_reason);
				if (finishReason) {
					output.stopReason = mapStopReason(finishReason);
				}

				const delta = isRecord(choice.delta) ? choice.delta : undefined;
				if (!delta) {
					continue;
				}

				const contentDelta = asString(delta.content);
				if (contentDelta) {
					if (!currentBlock || currentBlock.type !== "text") {
						finishBlock();
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: currentIndex(), partial: output });
					}
					currentBlock.text += contentDelta;
					stream.push({
						type: "text_delta",
						contentIndex: currentIndex(),
						delta: contentDelta,
						partial: output,
					});
				}

				const thinkingDelta =
					asString((delta as Record<string, unknown>).reasoning_content) ??
					asString((delta as Record<string, unknown>).reasoning) ??
					asString((delta as Record<string, unknown>).reasoning_text);
				if (thinkingDelta) {
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishBlock();
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: currentIndex(), partial: output });
					}
					currentBlock.thinking += thinkingDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: currentIndex(),
						delta: thinkingDelta,
						partial: output,
					});
				}

				const toolCalls = Array.isArray((delta as Record<string, unknown>).tool_calls)
					? ((delta as Record<string, unknown>).tool_calls as unknown[])
					: [];
				for (const rawToolCall of toolCalls) {
					if (!isRecord(rawToolCall)) {
						continue;
					}
					const rawFunction = isRecord(rawToolCall.function) ? rawToolCall.function : {};
					const toolCallId = asString(rawToolCall.id);
					if (!currentBlock || currentBlock.type !== "toolCall" || (toolCallId && currentBlock.id !== toolCallId)) {
						finishBlock();
						currentBlock = {
							type: "toolCall",
							id: toolCallId ?? "",
							name: asString(rawFunction.name) ?? "",
							arguments: {},
							partialArgs: "",
						};
						output.content.push(currentBlock);
						stream.push({ type: "toolcall_start", contentIndex: currentIndex(), partial: output });
					}
					if (toolCallId) {
						currentBlock.id = toolCallId;
					}
					const toolName = asString(rawFunction.name);
					if (toolName) {
						currentBlock.name = toolName;
					}
					const argumentsDelta = asString(rawFunction.arguments) ?? "";
					currentBlock.partialArgs = `${currentBlock.partialArgs ?? ""}${argumentsDelta}`;
					currentBlock.arguments = safeParseJson(currentBlock.partialArgs);
					stream.push({
						type: "toolcall_delta",
						contentIndex: currentIndex(),
						delta: argumentsDelta,
						partial: output,
					});
				}
			}

			finishBlock();
			if (options?.signal?.aborted) {
				throw new Error("Request aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function buildRequestBody(
	model: Model<"openai-completions">,
	context: Context,
	compat: Required<KernelOpenAiCompat>,
	options?: KernelOpenAiStreamOptions,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model, context, compat),
		stream: true,
	};

	if (compat.supportsUsageInStreaming) {
		body.stream_options = { include_usage: true };
	}

	if (typeof options?.maxTokens === "number") {
		body[compat.maxTokensField] = options.maxTokens;
	}

	if (typeof options?.temperature === "number") {
		body.temperature = options.temperature;
	}

	if (Array.isArray(context.tools) && context.tools.length > 0) {
		body.tools = context.tools.map((tool) => convertTool(tool, compat));
		if (compat.zaiToolStream) {
			body.tool_stream = true;
		}
	}

	if (options?.toolChoice) {
		body.tool_choice = options.toolChoice;
	}

		if (model.reasoning) {
			if (compat.thinkingFormat === "zai") {
				if (options?.reasoning) {
					body.enable_thinking = true;
				}
			} else if (compat.thinkingFormat === "openai" && options?.reasoning) {
			body.reasoning_effort = options.reasoning;
		}
	}

	return body;
}

function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: Required<KernelOpenAiCompat>,
): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];

	if (context.systemPrompt) {
		messages.push({
			role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
			content: context.systemPrompt,
		});
	}

	let lastRole: string | null = null;
	for (const message of context.messages) {
		if (compat.requiresAssistantAfterToolResult && lastRole === "tool" && message.role === "user") {
			messages.push({ role: "assistant", content: "I have processed the tool results." });
		}

		if (message.role === "user") {
			messages.push({
				role: "user",
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((part) =>
								part.type === "text"
									? { type: "text", text: part.text }
									: {
											type: "image_url",
											image_url: {
												url: `data:${part.mimeType};base64,${part.data}`,
											},
										},
							),
			});
			lastRole = "user";
			continue;
		}

		if (message.role === "assistant") {
			const textParts = message.content.filter((part): part is TextContent => part.type === "text");
			const thinkingParts = message.content.filter((part): part is ThinkingContent => part.type === "thinking");
			const toolCalls = message.content
				.filter((part): part is ToolCall => part.type === "toolCall")
				.map((part) => ({
					id: normalizeToolCallId(part.id),
					type: "function",
					function: {
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
					},
				}));

			let content = textParts.map((part) => part.text).join("");
			if (compat.requiresThinkingAsText && thinkingParts.length > 0) {
				const thinkingText = thinkingParts.map((part) => part.thinking).join("\n");
				content = content.length > 0 ? `${content}\n\n<thinking>\n${thinkingText}\n</thinking>` : thinkingText;
			}

			messages.push({
				role: "assistant",
				content: content.length > 0 ? content : null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			lastRole = "assistant";
			continue;
		}

		if (message.role === "toolResult") {
			const toolResult = message as ToolResultMessage;
			const content = toolResult.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			messages.push({
				role: "tool",
				tool_call_id: normalizeToolCallId(toolResult.toolCallId),
				content: content.length > 0 ? content : "[Empty tool result]",
				...(compat.requiresToolResultName ? { name: toolResult.toolName } : {}),
			});
			lastRole = "tool";
		}
	}

	return messages;
}

function convertTool(tool: Tool, compat: Required<KernelOpenAiCompat>): Record<string, unknown> {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(compat.supportsStrictMode ? { strict: false } : {}),
		},
	};
}

function getCompat(model: Model<"openai-completions">): Required<KernelOpenAiCompat> {
	const providerCompat = (model.compat ?? {}) as KernelOpenAiCompat;
	const zaiDefaults: KernelOpenAiCompat =
		model.provider === "zai"
			? {
					supportsDeveloperRole: false,
					supportsUsageInStreaming: false,
					maxTokensField: "max_tokens",
					requiresToolResultName: false,
					requiresAssistantAfterToolResult: false,
					requiresThinkingAsText: false,
					thinkingFormat: "zai",
					zaiToolStream: false,
					supportsStrictMode: false,
				}
			: {};

	return {
		supportsDeveloperRole: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		thinkingFormat: "openai",
		zaiToolStream: false,
		supportsStrictMode: false,
		...zaiDefaults,
		...providerCompat,
	};
}

function resolveEndpoint(baseUrl: string, path: string): string {
	return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function parseUsage(usage: Record<string, unknown>): AssistantMessage["usage"] {
	const input = asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens) ?? 0;
	const output = asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens) ?? 0;
	const totalTokens = asNumber(usage.total_tokens) ?? input + output;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function mapStopReason(reason: string): AssistantMessage["stopReason"] {
	switch (reason) {
		case "length":
			return "length";
		case "tool_calls":
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

async function* iterateSseData(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request aborted");
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary === -1) {
					break;
				}
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const payload = rawEvent
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (payload.length > 0) {
					yield payload;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function normalizeToolCallId(id: string): string {
	return id.length > 40 ? id.slice(0, 40) : id;
}

function safeParseJson(value: string): any {
	if (!value || value.trim().length === 0) {
		return {};
	}
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
