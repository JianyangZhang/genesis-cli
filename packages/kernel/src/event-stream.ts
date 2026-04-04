import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";

class EventStream<T, TResult = T> implements AsyncIterable<T> {
	private readonly queue: T[] = [];
	private readonly waiting: Array<(value: IteratorResult<T>) => void> = [];
	private done = false;
	private readonly resultPromise: Promise<TResult>;
	private resolveResult!: (value: TResult) => void;

	constructor(
		private readonly isFinalEvent: (event: T) => boolean,
		private readonly extractResult: (event: T) => TResult,
	) {
		this.resultPromise = new Promise<TResult>((resolve) => {
			this.resolveResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) {
			return;
		}

		if (this.isFinalEvent(event)) {
			this.done = true;
			this.resolveResult(this.extractResult(event));
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
			this.resolveResult(result);
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
		return this.resultPromise;
	}
}

export class KernelAssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				}
				if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected non-final assistant message event");
			},
		);
	}
}
