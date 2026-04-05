import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTtySession } from "../tty-session.js";

function createTtyInput(): PassThrough & {
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

function createTtyOutput(): PassThrough & { isTTY: boolean } {
	const stream = new PassThrough() as PassThrough & { isTTY: boolean };
	stream.isTTY = true;
	return stream;
}

describe("createTtySession", () => {
	it("enters alt screen with mouse tracking and restores terminal state", () => {
		const input = createTtyInput();
		const output = createTtyOutput();
		const restoreTermios = vi.fn();
		let written = "";
		output.on("data", (chunk) => {
			written += chunk.toString("utf8");
		});

		const session = createTtySession({ input, output, restoreTermios });
		session.enter();
		session.restore();

		expect(written).toContain("\x1b[?1049h");
		expect(written).toContain("\x1b[?1004h");
		expect(written).toContain("\x1b[?1000h");
		expect(written).toContain("\x1b[?1002h");
		expect(written).toContain("\x1b[?1006h");
		expect(written).toContain("\x1b[?1004l");
		expect(written).toContain("\x1b[?1006l");
		expect(written).toContain("\x1b[?1002l");
		expect(written).toContain("\x1b[?1000l");
		expect(written).toContain("\x1b[?1049l");
		expect(input.setRawMode).toHaveBeenCalledWith(false);
		expect(input.pause).toHaveBeenCalled();
		expect(restoreTermios).toHaveBeenCalledTimes(1);
	});

	it("restores only once", () => {
		const input = createTtyInput();
		const output = createTtyOutput();
		const restoreTermios = vi.fn();
		const session = createTtySession({ input, output, restoreTermios });

		session.enter();
		session.restore();
		session.restore();

		expect(restoreTermios).toHaveBeenCalledTimes(1);
	});

	it("refresh re-enables raw mode and focus reporting", () => {
		const input = createTtyInput();
		const output = createTtyOutput();
		let written = "";
		output.on("data", (chunk) => {
			written += chunk.toString("utf8");
		});
		const session = createTtySession({ input, output, restoreTermios: vi.fn() });

		session.enter();
		session.refresh();

		expect(input.setRawMode).toHaveBeenCalledWith(true);
		expect(written.match(new RegExp(`${String.fromCharCode(27)}\\[\\?1004h`, "g"))?.length).toBeGreaterThanOrEqual(2);
	});

	it("can stay on the primary buffer without mouse tracking", () => {
		const input = createTtyInput();
		const output = createTtyOutput();
		let written = "";
		output.on("data", (chunk) => {
			written += chunk.toString("utf8");
		});
		const session = createTtySession({
			input,
			output,
			restoreTermios: vi.fn(),
			useAlternateScreen: false,
			enableMouseTracking: false,
		});

		session.enter();
		session.restore();

		expect(written).not.toContain("\x1b[?1049h");
		expect(written).not.toContain("\x1b[?1000h");
		expect(written).not.toContain("\x1b[?1002h");
		expect(written).not.toContain("\x1b[?1006h");
		expect(written).toContain("\x1b[?1004h");
		expect(written).toContain("\x1b[?1004l");
	});

	it("refresh on the primary buffer does not re-enter alt screen or mouse tracking", () => {
		const input = createTtyInput();
		const output = createTtyOutput();
		let written = "";
		output.on("data", (chunk) => {
			written += chunk.toString("utf8");
		});
		const session = createTtySession({
			input,
			output,
			restoreTermios: vi.fn(),
			useAlternateScreen: false,
			enableMouseTracking: false,
		});

		session.enter();
		session.refresh({ reenterAlternateScreen: true });

		expect(input.setRawMode).toHaveBeenCalledWith(true);
		expect(written).not.toContain("\x1b[?1049h");
		expect(written).not.toContain("\x1b[?1000h");
		expect(written).not.toContain("\x1b[?1002h");
		expect(written).not.toContain("\x1b[?1006h");
		expect(written.match(new RegExp(`${String.fromCharCode(27)}\\[\\?1004h`, "g"))?.length).toBeGreaterThanOrEqual(2);
	});
});
