import { type Context, type Model, type SimpleStreamOptions, streamSimple } from "@pickle-pee/pi-ai";
import { streamAnthropicMessages } from "./providers/anthropic.js";
import { streamOpenAiCompletions } from "./providers/openai.js";

export type KernelStreamOptions = SimpleStreamOptions & {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
};

type KernelProviderHandler<TApi extends string = string> = (
	model: Model<TApi>,
	context: Context,
	options?: KernelStreamOptions,
) => ReturnType<typeof streamSimple>;

const builtinProviderHandlers = new Map<string, KernelProviderHandler>([
	[
		"openai-completions",
		(model, context, options) =>
			streamOpenAiCompletions(model as Model<"openai-completions">, context, options) as unknown as ReturnType<
				typeof streamSimple
			>,
	],
	[
		"anthropic-messages",
		// TODO(genesis-product): Anthropic-compatible path is intentionally kept as
		// a parked compatibility branch for now. Product hardening should focus on
		// the OpenAI-compatible mainline against BigModel Coding PaaS v4 first.
		// Do not expand Anthropic-specific behavior unless the OpenAI mainline and
		// user-facing product layer milestones are already stable.
		(model, context, options) =>
			streamAnthropicMessages(model as Model<"anthropic-messages">, context, options) as unknown as ReturnType<
				typeof streamSimple
			>,
	],
]);

export function streamWithKernelProvider(
	model: Model<any>,
	context: Context,
	options?: KernelStreamOptions,
): ReturnType<typeof streamSimple> {
	const handler = builtinProviderHandlers.get(model.api);
	if (handler) {
		return handler(model, context, options);
	}

	return streamSimple(model, context, options);
}
