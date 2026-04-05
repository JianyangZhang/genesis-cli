import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createInputLoop } from "../input-loop.js";

function createTtyPassThrough(): PassThrough & {
	isTTY: boolean;
	setRawMode: (enabled: boolean) => void;
	pause: () => void;
} {
	const stream = new PassThrough() as PassThrough & {
		isTTY: boolean;
		setRawMode: (enabled: boolean) => void;
		pause: () => void;
	};
	stream.isTTY = true;
	stream.setRawMode = vi.fn();
	stream.pause = vi.fn();
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

	it("emits wheel events for SGR mouse sequences", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[<64;10;10M");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenCalledWith("wheelup");
		} finally {
			loop.close();
		}
	});

	it("accepts lowercase sgr mouse terminators used by some terminals", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[<65;10;10m");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenCalledWith("wheeldown");
		} finally {
			loop.close();
		}
	});

	it("emits terminal focus events", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onTerminalEvent = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onTerminalEvent });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[O");
			input.write("\u001b[I");
			input.write("\r");
			await pending;
			expect(onTerminalEvent).toHaveBeenNthCalledWith(1, "focusout");
			expect(onTerminalEvent).toHaveBeenNthCalledWith(2, "focusin");
		} finally {
			loop.close();
		}
	});

	it("handles fragmented escape sequences across input chunks", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[");
			input.write("<64;");
			input.write("10;10M");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenCalledWith("wheelup");
		} finally {
			loop.close();
		}
	});

	it("emits page navigation keys in raw mode", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\u001b[5~");
			input.write("\u001b[6~");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenNthCalledWith(1, "pageup");
			expect(onKey).toHaveBeenNthCalledWith(2, "pagedown");
		} finally {
			loop.close();
		}
	});

	it("emits tab and shift-tab special keys in raw mode", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write("\t");
			input.write("\u001b[Z");
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenNthCalledWith(1, "tab");
			expect(onKey).toHaveBeenNthCalledWith(2, "shifttab");
		} finally {
			loop.close();
		}
	});

	it("emits ctrl+o in raw mode", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const onKey = vi.fn();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, onKey });
		try {
			const pending = loop.nextLine();
			input.write(Buffer.from([0x0f]));
			input.write("\r");
			await pending;
			expect(onKey).toHaveBeenCalledWith("ctrlo");
		} finally {
			loop.close();
		}
	});

	it("applies tab completion through the raw-mode callback", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const states: Array<{ buffer: string; cursor: number }> = [];
		const loop = createInputLoop({
			input,
			output,
			prompt: "",
			rawMode: true,
			onInputStateChange: (state) => {
				states.push(state);
			},
			onTabComplete: () => ({ buffer: "/status ", cursor: 8 }),
		});
		try {
			const pending = loop.nextLine();
			input.write("/st");
			input.write("\t");
			input.write("\r");
			await expect(pending).resolves.toBe("/status ");
			expect(states).toContainEqual({ buffer: "/status ", cursor: 8 });
		} finally {
			loop.close();
		}
	});

	it("can suppress the automatic newline on submit for custom prompt renderers", async () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		let rendered = "";
		output.on("data", (chunk) => {
			rendered += chunk.toString("utf8");
		});
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true, submitNewline: false });
		try {
			const pending = loop.nextLine();
			input.write("hello");
			input.write("\r");
			await expect(pending).resolves.toBe("hello");
			expect(rendered).not.toContain("\n");
		} finally {
			loop.close();
		}
	});

	it("restores raw mode and pauses stdin on close", () => {
		const input = createTtyPassThrough();
		const output = createTtyPassThrough();
		const loop = createInputLoop({ input, output, prompt: "", rawMode: true });
		loop.close();
		expect(input.setRawMode).toHaveBeenCalledWith(false);
		expect(input.pause).toHaveBeenCalled();
	});
});
