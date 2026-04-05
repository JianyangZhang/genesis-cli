import { PassThrough } from "node:stream";
import type { AppRuntime, RuntimeEvent, SessionFacade } from "@genesis-cli/runtime";
import { createEventBus, createPlanEngine, createToolGovernor } from "@genesis-cli/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createModeHandler } from "../mode-dispatch.js";

class FakeTtyInput extends PassThrough {
	isTTY = true;
	setRawMode(_enabled: boolean): void {}
	override resume(): this {
		return super.resume();
	}
	override pause(): this {
		return super.pause();
	}
}

class FakeTtyOutput extends PassThrough {
	isTTY = true;
	columns = 80;
	rows = 24;
}

class VirtualScreen {
	private readonly lines: string[][];
	private row = 1;
	private column = 1;

	constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		this.lines = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
	}

	consume(chunk: string): void {
		for (let index = 0; index < chunk.length; ) {
			const char = chunk[index];
			if (char === "\x1b") {
				const consumed = this.consumeEscape(chunk, index);
				index += consumed;
				continue;
			}
			if (char === "\r") {
				this.column = 1;
				index += 1;
				continue;
			}
			if (char === "\n") {
				this.row = Math.min(this.height, this.row + 1);
				index += 1;
				continue;
			}
			this.writeChar(char);
			index += 1;
		}
	}

	snapshot(): string {
		return this.lines.map((line) => line.join("").replace(/\s+$/g, "")).join("\n");
	}

	private consumeEscape(text: string, start: number): number {
		if (text[start + 1] !== "[") {
			return 1;
		}
		let end = start + 2;
		while (end < text.length && !/[A-Za-z]/.test(text[end] ?? "")) {
			end += 1;
		}
		if (end >= text.length) {
			return text.length - start;
		}
		const final = text[end] ?? "";
		const body = text.slice(start + 2, end);
		this.applyCsi(body, final);
		return end - start + 1;
	}

	private applyCsi(body: string, final: string): void {
		if (final === "m" || final === "h" || final === "l" || final === "r") {
			return;
		}
		if (final === "H") {
			if (body.length === 0) {
				this.row = 1;
				this.column = 1;
				return;
			}
			const [row, column] = body.split(";");
			this.row = Math.max(1, Number.parseInt(row ?? "1", 10) || 1);
			this.column = Math.max(1, Number.parseInt(column ?? "1", 10) || 1);
			return;
		}
		if (final === "J") {
			for (let row = 0; row < this.height; row += 1) {
				this.lines[row]?.fill(" ");
			}
			this.row = 1;
			this.column = 1;
			return;
		}
		if (final === "K") {
			this.lines[this.row - 1]?.fill(" ");
			this.column = 1;
			return;
		}
		if (final === "A") {
			const amount = Math.max(1, Number.parseInt(body || "1", 10) || 1);
			this.row = Math.max(1, this.row - amount);
			return;
		}
		if (final === "C") {
			const amount = Math.max(1, Number.parseInt(body || "1", 10) || 1);
			this.column = Math.min(this.width, this.column + amount);
			return;
		}
	}

	private writeChar(char: string): void {
		if (this.row < 1 || this.row > this.height || this.column < 1 || this.column > this.width) {
			return;
		}
		this.lines[this.row - 1]![this.column - 1] = char;
		this.column = Math.min(this.width, this.column + 1);
	}
}

function findLineIndexContaining(snapshot: string, needle: string): number {
	return snapshot.split("\n").findIndex((line) => line.includes(needle));
}

function countOccurrences(snapshot: string, needle: string): number {
	return snapshot.split(needle).length - 1;
}

class FakeInteractiveSession implements SessionFacade {
	readonly id = { value: "tty-test-session" };
	readonly state = {
		id: this.id,
		model: { id: "glm-5.1", displayName: "GLM 5.1", provider: "zai" },
		toolSet: [],
	} as unknown as SessionFacade["state"];
	readonly context = {
		sessionId: this.id,
		workingDirectory: "/tmp",
		mode: "interactive",
		model: this.state.model,
		toolSet: new Set(["bash"]),
		taskState: { status: "idle", currentTaskId: null, startedAt: null },
	} as unknown as SessionFacade["context"];
	readonly events = createEventBus();
	readonly plan = null;
	private bashApprovedForSession = false;
	private pendingPermission: {
		callId: string;
		resolve: () => void;
	} | null = null;

	isWaitingForPermission(): boolean {
		return this.pendingPermission !== null;
	}

	async prompt(input: string): Promise<void> {
		if (input === "hello") {
			this.emit({
				id: "thinking-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: "...",
			} as RuntimeEvent);
			this.emit({
				id: "text-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Hi from Genesis",
			} as RuntimeEvent);
			return;
		}

		if (input === "bash pwd") {
			if (this.bashApprovedForSession) {
				this.emitBashExecution("bash-pwd-2");
				return;
			}
			this.emit({
				id: "perm-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "permission",
				type: "permission_requested",
				toolName: "bash",
				toolCallId: "bash-pwd-1",
				riskLevel: "L3",
			} as RuntimeEvent);
			await new Promise<void>((resolve) => {
				this.pendingPermission = { callId: "bash-pwd-1", resolve };
			});
			this.emitBashExecution("bash-pwd-1");
			return;
		}
	}

	async continue(input: string): Promise<void> {
		return this.prompt(input);
	}

	abort(): void {}

	async close(): Promise<void> {}

	async resolvePermission(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
	): Promise<void> {
		if (!this.pendingPermission || this.pendingPermission.callId !== callId) {
			throw new Error(`Unexpected permission resolution: ${callId}`);
		}
		if (decision === "allow_for_session") {
			this.bashApprovedForSession = true;
		}
		this.emit({
			id: `resolved-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "permission",
			type: "permission_resolved",
			toolName: "bash",
			toolCallId: callId,
			decision,
		} as RuntimeEvent);
		const pending = this.pendingPermission;
		this.pendingPermission = null;
		pending.resolve();
	}

	onStateChange(): () => void {
		return () => {};
	}

	async compact(): Promise<void> {}

	private emit(event: RuntimeEvent): void {
		this.events.emit(event);
	}

	private emitBashExecution(callId: string): void {
		this.emit({
			id: `tool-start-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "tool",
			type: "tool_started",
			toolName: "bash",
			toolCallId: callId,
			parameters: { command: "pwd" },
		} as RuntimeEvent);
		this.emit({
			id: `tool-end-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "tool",
			type: "tool_completed",
			toolName: "bash",
			toolCallId: callId,
			status: "success",
			durationMs: 10,
			result: "/tmp",
		} as RuntimeEvent);
		this.emit({
			id: `tool-text-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "text",
			type: "text_delta",
			content: "Current directory: /tmp",
		} as RuntimeEvent);
	}

	queueMultiChunkHello(): void {
		this.prompt = async (input: string): Promise<void> => {
			if (input === "hello") {
				this.emit({
					id: "thinking-1",
					timestamp: Date.now(),
					sessionId: this.id,
					category: "text",
					type: "thinking_delta",
					content: "...",
				} as RuntimeEvent);
				for (const [index, chunk] of ["Hi", "Hi from", "Hi from Genesis"].entries()) {
					this.emit({
						id: `text-chunk-${index}`,
						timestamp: Date.now(),
						sessionId: this.id,
						category: "text",
						type: "text_delta",
						content: chunk,
					} as RuntimeEvent);
				}
				return;
			}
			return FakeInteractiveSession.prototype.prompt.call(this, input);
		};
	}
}

function createFakeRuntime(session: FakeInteractiveSession): AppRuntime {
	const events = createEventBus();
	return {
		createSession: () => session,
		recoverSession: () => session,
		events,
		governor: createToolGovernor(),
		planEngine: createPlanEngine(),
		shutdown: async () => {},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withPatchedProcessTty<T>(
	input: FakeTtyInput,
	output: FakeTtyOutput,
	run: (screen: VirtualScreen) => Promise<T>,
): Promise<T> {
	const screen = new VirtualScreen(output.columns, output.rows);
	output.on("data", (chunk) => {
		screen.consume(chunk.toString("utf8"));
	});
	const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
	const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
	Object.defineProperty(process, "stdin", { value: input, configurable: true });
	Object.defineProperty(process, "stdout", { value: output, configurable: true });
	try {
		return await run(screen);
	} finally {
		if (stdinDescriptor) {
			Object.defineProperty(process, "stdin", stdinDescriptor);
		}
		if (stdoutDescriptor) {
			Object.defineProperty(process, "stdout", stdoutDescriptor);
		}
	}
}

afterEach(() => {
	// defensive no-op; process descriptors are restored per-test
});

describe("interactive workbench TTY", () => {
	it("renders a completed assistant reply and keeps the composer visible", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("hello\r");

			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));
			const snapshot = screen.snapshot();
			expect(snapshot).toContain("hello");
			expect(snapshot).toContain("Hi from Genesis");
			expect(snapshot).toContain("❯");
			const assistantLine = findLineIndexContaining(snapshot, "Hi from Genesis");
			const footerSeparatorLine = findLineIndexContaining(snapshot, "────────────────");
			expect(footerSeparatorLine - assistantLine).toBeLessThanOrEqual(2);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not leave duplicate assistant lines behind across streaming updates", async () => {
		const session = new FakeInteractiveSession();
		session.queueMultiChunkHello();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("hello\r");

			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));
			const snapshot = screen.snapshot();
			expect(countOccurrences(snapshot, "⏺ Hi from Genesis")).toBe(1);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows permission UI and clears it after allow-for-session approval", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash pwd\r");
			await waitFor(() => session.isWaitingForPermission());
			await waitFor(() => screen.snapshot().includes("choice [Enter/1/2/3]>"));

			input.write("2\r");
			await waitFor(() => screen.snapshot().includes("Current directory: /tmp"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("bash pwd\r");
			await waitFor(() => screen.snapshot().includes("Bash(pwd)"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);
});
