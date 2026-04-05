import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createInputLoop } from "../input-loop.js";

function createTtyPassThrough(): PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void } {
	const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (enabled: boolean) => void };
	stream.isTTY = true;
	stream.setRawMode = vi.fn();
	return stream;
}

describe("createInputLoop (rawMode)", () => {
	it("supports basic editing (insert, cursor left, backspace) and enter", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true });
		try {
			const next = loop.nextLine();
			input.write("abc");
			input.write("\u001b[D");
			input.write(Buffer.from([0x7f]));
			input.write("\r");
			await expect(next).resolves.toBe("ac");
		} finally {
			loop.close();
		}
	});

	it("emits special key events for arrow keys", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[A");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenCalledWith("up");
		} finally {
			loop.close();
		}
	});
});
