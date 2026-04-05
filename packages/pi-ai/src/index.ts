import { type TSchema, Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { parse as partialParse } from "partial-json";

export { Type };

export type Transport = "sse" | "json";

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

export type TextContent = { readonly type: "text"; text: string };

export type ThinkingContent = {
	readonly type: "thinking";
	thinking: string;
	readonly thinkingSignature?: string;
	readonly redacted?: boolean;
};

export type ToolCall = {
	readonly type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
};

export type ImageContent = {
	readonly type: "image";
	readonly mimeType: string;
	readonly data: string;
};

export type ToolParametersSchema = TSchema;

export type Tool<TParameters extends TSchema = TSchema> = {
	readonly name: string;
	readonly description?: string;
	readonly parameters: TParameters;
};

export type UserMessage = {
	readonly role: "user";
	readonly content: readonly (TextContent | ImageContent)[];
	readonly timestamp: number;
};

export type ToolResultMessage = {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName?: string;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly timestamp: number;
};

export type AssistantMessage = {
	readonly role: "assistant";
	stopReason: StopReason;
	content: Array<TextContent | ImageContent | ThinkingContent | ToolCall>;
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	usage: Usage;
	readonly timestamp: number;
	responseId?: string;
	errorMessage?: string;
};

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type Context = {
	readonly systemPrompt: string;
	readonly messages: readonly Message[];
	readonly tools?: readonly Tool[];
};

export type ThinkingBudgets = Record<string, number>;

export type SimpleStreamOptions = {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly reasoning?: boolean | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly transport?: Transport;
	readonly maxRetryDelayMs?: number;
	readonly signal?: AbortSignal;
	readonly onPayload?: (payload: unknown, model: Model<any>) => Promise<unknown> | unknown;
};

export type Model<TApi extends string = string> = {
	readonly id: string;
	readonly name?: string;
	readonly api: TApi;
	readonly provider: string;
	readonly baseUrl: string;
	readonly reasoning: boolean;
	readonly input?: readonly string[];
	readonly cost?: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
	readonly contextWindow?: number;
	readonly maxTokens: number;
	readonly headers?: Record<string, string>;
	readonly compat?: Record<string, unknown>;
};

export type AssistantMessageEvent =
	| { readonly type: "start"; readonly partial: AssistantMessage }
	| { readonly type: "text_start"; readonly contentIndex: number; readonly partial: AssistantMessage }
	| {
			readonly type: "text_delta";
			readonly contentIndex: number;
			readonly delta: string;
			readonly partial: AssistantMessage;
	  }
	| {
			readonly type: "text_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly partial: AssistantMessage;
	  }
	| { readonly type: "thinking_start"; readonly contentIndex: number; readonly partial: AssistantMessage }
	| {
			readonly type: "thinking_delta";
			readonly contentIndex: number;
			readonly delta: string;
			readonly partial: AssistantMessage;
	  }
	| {
			readonly type: "thinking_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly partial: AssistantMessage;
	  }
	| { readonly type: "toolcall_start"; readonly contentIndex: number; readonly partial: AssistantMessage }
	| {
			readonly type: "toolcall_delta";
			readonly contentIndex: number;
			readonly delta: string;
			readonly partial: AssistantMessage;
	  }
	| {
			readonly type: "toolcall_end";
			readonly contentIndex: number;
			readonly toolCall: ToolCall;
			readonly partial: AssistantMessage;
	  }
	| {
			readonly type: "done";
			readonly reason: Exclude<StopReason, "aborted" | "error">;
			readonly message: AssistantMessage;
	  }
	| {
			readonly type: "error";
			readonly reason: Extract<StopReason, "aborted" | "error">;
			readonly error: AssistantMessage;
	  };

export class EventStream<T, TResult = T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
	private done = false;
	private readonly finalResultPromise: Promise<TResult>;
	private resolveFinalResult!: (value: TResult) => void;

	constructor(
		private readonly isComplete: (event: T) => boolean,
		private readonly extractResult: (event: T) => TResult,
	) {
		this.finalResultPromise = new Promise<TResult>((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
			return;
		}
		this.queue.push(event);
	}

	end(result?: TResult): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		while (this.waiting.length > 0) {
			this.waiting.shift()?.({ value: undefined as never, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift() as T;
				continue;
			}
			if (this.done) {
				return;
			}
			const next = await new Promise<IteratorResult<T>>((resolve) => {
				this.waiting.push(resolve);
			});
			if (next.done) {
				return;
			}
			yield next.value;
		}
	}

	result(): Promise<TResult> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}

export function parseStreamingJson(partialJson: string): Record<string, unknown> {
	if (!partialJson || partialJson.trim() === "") {
		return {};
	}
	try {
		return JSON.parse(partialJson) as Record<string, unknown>;
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
}

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

function canUseRuntimeCodegen(): boolean {
	try {
		new Function("return true;");
		return true;
	} catch {
		return false;
	}
}

let ajv: any = null;
if (canUseRuntimeCodegen()) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch {
		ajv = null;
	}
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
	if (!ajv || !canUseRuntimeCodegen()) {
		return toolCall.arguments;
	}

	const validate = ajv.compile(tool.parameters);
	const args = structuredClone(toolCall.arguments);
	if (validate(args)) {
		return args;
	}

	const errors =
		validate.errors
			?.map((err: any) => {
				const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";
	throw new Error(
		`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(
			toolCall.arguments,
			null,
			2,
		)}`,
	);
}

export function streamSimple(
	model: Model<any>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const base: AssistantMessage = {
			role: "assistant",
			stopReason: options?.signal?.aborted ? "aborted" : "error",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			timestamp: Date.now(),
			errorMessage: options?.signal?.aborted ? "Request aborted" : `No provider registered for api: ${model.api}`,
		};
		stream.push({ type: "start", partial: base });
		stream.push({ type: "error", reason: base.stopReason as "aborted" | "error", error: base });
		stream.end();
	});
	return stream;
}
