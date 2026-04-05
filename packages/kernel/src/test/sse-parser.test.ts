import { describe, expect, it } from "vitest";
import { iterateSseData } from "../providers/shared.js";

function streamFromStrings(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

describe("iterateSseData", () => {
	it("yields data payloads split by SSE boundaries", async () => {
		const stream = streamFromStrings([
			"data: first\n\n",
			"data: second\n\n",
			"\n",
		]);
		const collected: string[] = [];
		for await (const payload of iterateSseData(stream)) {
			collected.push(payload);
		}
		expect(collected).toEqual(["first", "second"]);
	});

	it("yields final payload even when the stream ends without a boundary", async () => {
		const stream = streamFromStrings(["data: tail"]);
		const collected: string[] = [];
		for await (const payload of iterateSseData(stream)) {
			collected.push(payload);
		}
		expect(collected).toEqual(["tail"]);
	});
});

