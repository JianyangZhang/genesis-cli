import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@pickle-pee/pi-ai";
import { KernelAssistantMessageEventStream } from "../event-stream.js";
import {
	asNumber,
	asString,
	createAssistantMessage,
	isRecord,
	iterateSseData,
	resolveEndpoint,
	safeParseJson,
} from "./shared.js";

// TODO(genesis-product): keep this provider as a compatibility placeholder with
// clear comments and basic tests only. The current product milestone is to
// harden the OpenAI-compatible chain for BigModel Coding PaaS v4 first, so
// Anthropic-specific feature work is intentionally paused unless required to
// preserve build health or shared abstractions.

type KernelAnthropicToolChoice = "auto" | "any" | "none" | { type: "tool"; name: string };

type KernelAnthropicStreamOptions = SimpleStreamOptions & {
	readonly toolChoice?: KernelAnthropicToolChoice;
};

type KernelAnthropicContentBlock =
	| { type: "text"; text: string; index: number }
	| { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; index: number }
	| {
			type: "toolCall";
			id: string;
			name: string;
			arguments: Record<string, unknown>;
			partialJson?: string;
			index: number;
	  };

export function streamAnthropicMessages(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: KernelAnthropicStreamOptions,
) {
	const stream = new KernelAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = createAssistantMessage(model);

		try {
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as Record<string, unknown>;
			}

			const response = await fetch(resolveEndpoint(model.baseUrl, "v1/messages"), {
				method: "POST",
				headers: buildHeaders(options?.apiKey, options?.headers),
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

			const blocks = output.content as KernelAnthropicContentBlock[];
			const findBlock = (
				eventIndex: number,
			): { block: KernelAnthropicContentBlock; contentIndex: number } | null => {
				const contentIndex = blocks.findIndex((candidate) => candidate.index === eventIndex);
				if (contentIndex === -1) {
					return null;
				}
				return { block: blocks[contentIndex], contentIndex };
			};

			for await (const rawData of iterateSseData(response.body, options?.signal)) {
				if (rawData === "[DONE]") {
					break;
				}
				const event = safeParseJson(rawData) as Record<string, unknown> | undefined;
				if (!event?.type) {
					continue;
				}

				switch (event.type) {
					case "message_start": {
						const message = isRecord(event.message) ? event.message : undefined;
						output.responseId ||= asString(message?.id);
						if (isRecord(message?.usage)) {
							applyUsage(output, message.usage);
						}
						break;
					}
					case "content_block_start": {
						const contentBlock = isRecord(event.content_block) ? event.content_block : undefined;
						const eventIndex = asNumber(event.index);
						if (!contentBlock || eventIndex === undefined) {
							break;
						}

						if (contentBlock.type === "text") {
							const block: KernelAnthropicContentBlock = {
								type: "text",
								text: "",
								index: eventIndex,
							};
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						} else if (contentBlock.type === "thinking") {
							const block: KernelAnthropicContentBlock = {
								type: "thinking",
								thinking: "",
								thinkingSignature: "",
								index: eventIndex,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (contentBlock.type === "redacted_thinking") {
							const block: KernelAnthropicContentBlock = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: asString(contentBlock.data),
								redacted: true,
								index: eventIndex,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (contentBlock.type === "tool_use") {
							const block: KernelAnthropicContentBlock = {
								type: "toolCall",
								id: asString(contentBlock.id) ?? "",
								name: asString(contentBlock.name) ?? "",
								arguments: isRecord(contentBlock.input) ? contentBlock.input : {},
								partialJson: "",
								index: eventIndex,
							};
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
						break;
					}
					case "content_block_delta": {
						const delta = isRecord(event.delta) ? event.delta : undefined;
						const eventIndex = asNumber(event.index);
						if (!delta || eventIndex === undefined) {
							break;
						}
						const match = findBlock(eventIndex);
						if (!match) {
							break;
						}

						if (delta.type === "text_delta" && match.block.type === "text") {
							const textDelta = asString(delta.text) ?? "";
							match.block.text += textDelta;
							stream.push({
								type: "text_delta",
								contentIndex: match.contentIndex,
								delta: textDelta,
								partial: output,
							});
						} else if (delta.type === "thinking_delta" && match.block.type === "thinking") {
							const thinkingDelta = asString(delta.thinking) ?? "";
							match.block.thinking += thinkingDelta;
							stream.push({
								type: "thinking_delta",
								contentIndex: match.contentIndex,
								delta: thinkingDelta,
								partial: output,
							});
						} else if (delta.type === "signature_delta" && match.block.type === "thinking") {
							match.block.thinkingSignature = `${match.block.thinkingSignature ?? ""}${asString(delta.signature) ?? ""}`;
						} else if (delta.type === "input_json_delta" && match.block.type === "toolCall") {
							const jsonDelta = asString(delta.partial_json) ?? "";
							match.block.partialJson = `${match.block.partialJson ?? ""}${jsonDelta}`;
							match.block.arguments = safeParseJson(match.block.partialJson) ?? {};
							stream.push({
								type: "toolcall_delta",
								contentIndex: match.contentIndex,
								delta: jsonDelta,
								partial: output,
							});
						}
						break;
					}
					case "content_block_stop": {
						const eventIndex = asNumber(event.index);
						if (eventIndex === undefined) {
							break;
						}
						const match = findBlock(eventIndex);
						if (!match) {
							break;
						}
						delete (match.block as { index?: number }).index;
						if (match.block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: match.contentIndex,
								content: match.block.text,
								partial: output,
							});
						} else if (match.block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: match.contentIndex,
								content: match.block.thinking,
								partial: output,
							});
						} else if (match.block.type === "toolCall") {
							match.block.arguments = safeParseJson(match.block.partialJson ?? "") ?? {};
							delete (match.block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: match.contentIndex,
								toolCall: match.block,
								partial: output,
							});
						}
						break;
					}
					case "message_delta": {
						const delta = isRecord(event.delta) ? event.delta : undefined;
						if (delta?.stop_reason) {
							output.stopReason = mapStopReason(String(delta.stop_reason));
						}
						if (isRecord(event.usage)) {
							applyUsage(output, event.usage);
						}
						break;
					}
					default:
						break;
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content as KernelAnthropicContentBlock[]) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function buildRequestBody(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: KernelAnthropicStreamOptions,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens:
			typeof options?.maxTokens === "number" ? options.maxTokens : Math.max(1024, Math.floor(model.maxTokens / 3)),
		messages: convertMessages(context.messages),
		stream: true,
	};

	if (context.systemPrompt) {
		body.system = context.systemPrompt;
	}

	if (typeof options?.temperature === "number" && !options?.reasoning) {
		body.temperature = options.temperature;
	}

	if (Array.isArray(context.tools) && context.tools.length > 0) {
		body.tools = context.tools.map(convertTool);
	}

	if (options?.toolChoice) {
		body.tool_choice =
			typeof options.toolChoice === "string"
				? { type: options.toolChoice }
				: { type: "tool", name: options.toolChoice.name };
	}

	if (model.reasoning) {
		body.thinking = options?.reasoning
			? {
					type: "enabled",
					budget_tokens: resolveThinkingBudget(options.reasoning, body.max_tokens as number),
				}
			: { type: "disabled" };
	}

	return body;
}

function buildHeaders(apiKey: string | undefined, extraHeaders?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		...(extraHeaders ?? {}),
	};

	if (apiKey && !headers.authorization && !headers["x-api-key"]) {
		headers["x-api-key"] = apiKey;
	}

	return headers;
}

function convertMessages(messages: readonly import("@pickle-pee/pi-ai").Message[]): Record<string, unknown>[] {
	const converted: Record<string, unknown>[] = [];

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];

		if (message.role === "user") {
			converted.push(convertUserMessage(message));
			continue;
		}

		if (message.role === "assistant") {
			const content = convertAssistantContent(message);
			if (content.length > 0) {
				converted.push({ role: "assistant", content });
			}
			continue;
		}

		if (message.role === "toolResult") {
			const blocks: Record<string, unknown>[] = [];
			for (let cursor = index; cursor < messages.length; cursor += 1) {
				const candidate = messages[cursor];
				if (candidate.role !== "toolResult") {
					break;
				}
				const toolResult = candidate as ToolResultMessage;
				const contentText = toolResult.content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				blocks.push({
					type: "tool_result",
					tool_use_id: normalizeToolCallId(toolResult.toolCallId),
					content: contentText.length > 0 ? contentText : "[Empty tool result]",
				});
				index = cursor;
			}
			if (blocks.length > 0) {
				converted.push({ role: "user", content: blocks });
			}
		}
	}

	return converted;
}

function convertUserMessage(message: UserMessage): Record<string, unknown> {
	if (typeof message.content === "string") {
		return { role: "user", content: message.content };
	}

	return {
		role: "user",
		content: message.content.map((part) =>
			part.type === "text"
				? { type: "text", text: part.text }
				: {
						type: "image",
						source: {
							type: "base64",
							media_type: part.mimeType,
							data: part.data,
						},
					},
		),
	};
}

function convertAssistantContent(
	message: Extract<import("@pickle-pee/pi-ai").Message, { role: "assistant" }>,
): Record<string, unknown>[] {
	const blocks: Record<string, unknown>[] = [];

	for (const block of message.content) {
		if (block.type === "text" && block.text.trim().length > 0) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "thinking" && block.thinking.trim().length > 0) {
			if (block.thinkingSignature && block.thinkingSignature.trim().length > 0) {
				blocks.push({
					type: block.redacted ? "redacted_thinking" : "thinking",
					...(block.redacted
						? { data: block.thinkingSignature }
						: { thinking: block.thinking, signature: block.thinkingSignature }),
				});
			} else {
				blocks.push({ type: "text", text: block.thinking });
			}
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: normalizeToolCallId(block.id),
				name: block.name,
				input: block.arguments ?? {},
			});
		}
	}

	return blocks;
}

function convertTool(tool: Tool): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	};
}

function resolveThinkingBudget(reasoning: NonNullable<SimpleStreamOptions["reasoning"]>, maxTokens: number): number {
	switch (reasoning) {
		case "minimal":
			return Math.min(1024, maxTokens);
		case "low":
			return Math.min(2048, maxTokens);
		case "medium":
			return Math.min(4096, maxTokens);
		case "high":
			return Math.min(8192, maxTokens);
		case "xhigh":
			return Math.min(16384, maxTokens);
		default:
			return Math.min(1024, maxTokens);
	}
}

function applyUsage(output: AssistantMessage, usage: Record<string, unknown>): void {
	const input = asNumber(usage.input_tokens);
	const outputTokens = asNumber(usage.output_tokens);
	const cacheRead = asNumber(usage.cache_read_input_tokens);
	const cacheWrite = asNumber(usage.cache_creation_input_tokens);

	if (input !== undefined) {
		output.usage.input = input;
	}
	if (outputTokens !== undefined) {
		output.usage.output = outputTokens;
	}
	if (cacheRead !== undefined) {
		output.usage.cacheRead = cacheRead;
	}
	if (cacheWrite !== undefined) {
		output.usage.cacheWrite = cacheWrite;
	}

	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

function mapStopReason(reason: string): AssistantMessage["stopReason"] {
	switch (reason) {
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "stop";
	}
}

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
