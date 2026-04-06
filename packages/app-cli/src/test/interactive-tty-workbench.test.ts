import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import type {
	AppRuntime,
	RecentSessionEntry,
	RecentSessionSearchHit,
	RuntimeEvent,
	SessionFacade,
	SessionRecoveryData,
} from "@pickle-pee/runtime";
import { createEventBus, createPlanEngine, createToolGovernor } from "@pickle-pee/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDebugLogger } from "../debug-logger.js";
import { createModeHandler } from "../mode-dispatch.js";

const execFileAsync = promisify(execFile);

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
	private raw = "";

	override write(
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
		cb?: (error: Error | null | undefined) => void,
	): boolean {
		const normalized =
			typeof chunk === "string"
				? chunk
				: Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
		this.raw += normalized;
		return super.write(chunk as never, encoding as never, cb);
	}

	getRawOutput(): string {
		return this.raw;
	}
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

const QUEUED_ROW_HIGHLIGHT_PATTERN = "\\u001b\\[48;5;252m";
const QUEUED_ROW_HIGHLIGHT_REGEX = new RegExp(QUEUED_ROW_HIGHLIGHT_PATTERN, "g");

async function writeSessionTranscript(
	filePath: string,
	sessionId: string,
	messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<void> {
	const lines = [
		JSON.stringify({
			type: "session",
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
		}),
		...messages.map((message, index) =>
			JSON.stringify({
				type: "message",
				id: `${sessionId}-m-${index + 1}`,
				parentId: index === 0 ? null : `${sessionId}-m-${index}`,
				timestamp: new Date(Date.now() + index).toISOString(),
				message: { role: message.role, content: message.content },
			}),
		),
	];
	await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function createGitRepoFixture(options?: {
	readonly modifiedFile?: string;
	readonly initialContent?: string;
	readonly updatedContent?: string | null;
	readonly commitInitialFile?: boolean;
}): Promise<{ readonly repoDir: string; readonly filePath: string }> {
	const repoDir = await mkdtemp(join(tmpdir(), "genesis-git-fixture-"));
	const filePath = join(repoDir, options?.modifiedFile ?? "notes.txt");
	await execFileAsync("git", ["init"], { cwd: repoDir });
	await execFileAsync("git", ["config", "user.email", "genesis@example.com"], { cwd: repoDir });
	await execFileAsync("git", ["config", "user.name", "Genesis Test"], { cwd: repoDir });
	await writeFile(filePath, options?.initialContent ?? "hello\n", "utf8");
	if (options?.commitInitialFile !== false) {
		await execFileAsync("git", ["add", "."], { cwd: repoDir });
		await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
		if (options?.updatedContent !== null) {
			await writeFile(filePath, options?.updatedContent ?? "hello changed\n", "utf8");
		}
	}
	return { repoDir, filePath };
}

async function createModelFixture(): Promise<{ readonly agentDir: string; readonly settingsPath: string }> {
	const agentDir = await mkdtemp(join(tmpdir(), "genesis-model-agent-"));
	const settingsDir = await mkdtemp(join(tmpdir(), "genesis-model-settings-"));
	const settingsPath = join(settingsDir, "settings.json");
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					zai: {
						baseURL: "https://open.bigmodel.cn/api/coding/paas/v4/",
						api: "openai-completions",
						envKey: "GENESIS_API_KEY",
						authHeader: "Authorization",
						models: [
							{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
							{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
						],
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(settingsPath, "{}\n", "utf8");
	return { agentDir, settingsPath };
}

class FakeInteractiveSession implements SessionFacade {
	readonly id: SessionFacade["id"];
	readonly state: SessionFacade["state"];
	readonly context: SessionFacade["context"];
	readonly events = createEventBus();
	readonly plan = null;
	private readonly sessionApprovedCommands = new Set<string>();
	private readonly receivedPrompts: string[] = [];
	private readonly receivedContinues: string[] = [];
	private readonly stateListeners = new Set<(state: SessionFacade["state"]) => void>();
	private pendingPermission: {
		callId: string;
		toolName: string;
		command?: string;
		resolve: () => void;
	} | null = null;

	constructor(options?: {
		readonly sessionId?: string;
		readonly workingDirectory?: string;
		readonly agentDir?: string;
		readonly compactDelayMs?: number;
		readonly compactFailureMessage?: string;
	}) {
		this.id = { value: options?.sessionId ?? "tty-test-session" };
		const model = { id: "glm-5.1", displayName: "GLM 5.1", provider: "zai" };
		this.state = {
			id: this.id,
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			model,
			toolSet: new Set(["bash"]),
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		} as unknown as SessionFacade["state"];
		this.context = {
			sessionId: this.id,
			workingDirectory: options?.workingDirectory ?? "/tmp",
			agentDir: options?.agentDir,
			mode: "interactive",
			model,
			toolSet: new Set(["bash"]),
			taskState: { status: "idle", currentTaskId: null, startedAt: null },
		} as unknown as SessionFacade["context"];
		this._compactDelayMs = options?.compactDelayMs ?? 0;
		this._compactFailureMessage = options?.compactFailureMessage ?? null;
	}

	private readonly _compactDelayMs: number;
	private readonly _compactFailureMessage: string | null;

	isWaitingForPermission(): boolean {
		return this.pendingPermission !== null;
	}

	getReceivedPrompts(): readonly string[] {
		return this.receivedPrompts;
	}

	getReceivedContinues(): readonly string[] {
		return this.receivedContinues;
	}

	async prompt(input: string): Promise<void> {
		this.receivedPrompts.push(input);
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
			this.emitUsage("usage-hello-final", { input: 120, output: 24, totalTokens: 144 }, true);
			return;
		}

		if (input === "slow hello") {
			this.emit({
				id: "thinking-slow-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: "...",
			} as RuntimeEvent);
			this.emitUsage("usage-slow-partial", { input: 180, output: 32, totalTokens: 212 }, false);
			await sleep(2300);
			this.emit({
				id: "text-slow-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "First delayed reply",
			} as RuntimeEvent);
			this.emitUsage("usage-slow-final", { input: 180, output: 64, totalTokens: 244 }, true);
			return;
		}

		if (input === "queued followup") {
			this.emit({
				id: "text-queued-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Queued follow-up reply",
			} as RuntimeEvent);
			this.emitUsage("usage-queued-final", { input: 90, output: 33, totalTokens: 123 }, true);
			return;
		}

		if (input === "slow respond") {
			this.emit({
				id: "thinking-respond-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: "...",
			} as RuntimeEvent);
			await sleep(100);
			this.emit({
				id: "text-respond-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Draft reply",
			} as RuntimeEvent);
			this.emitUsage("usage-respond-partial", { input: 75, output: 12, totalTokens: 87 }, false);
			await sleep(2300);
			this.emit({
				id: "text-respond-2",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Draft reply finished",
			} as RuntimeEvent);
			this.emitUsage("usage-respond-final", { input: 75, output: 28, totalTokens: 103 }, true);
			return;
		}

		if (input === "respond without usage") {
			this.emit({
				id: "text-respond-no-usage-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Reply without usage yet",
			} as RuntimeEvent);
			await sleep(1800);
			this.emit({
				id: "text-respond-no-usage-2",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Reply without usage yet finished",
			} as RuntimeEvent);
			return;
		}

		if (input === "expand thinking") {
			this.emit({
				id: "thinking-expand-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: "Let me plan this carefully before writing files. ",
			} as RuntimeEvent);
			await sleep(200);
			this.emit({
				id: "thinking-expand-2",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: "I should first inspect the workspace, then create a single self-contained HTML demo.",
			} as RuntimeEvent);
			await sleep(1600);
			this.emit({
				id: "text-expand-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Planned the demo.",
			} as RuntimeEvent);
			return;
		}

		if (input === "long thinking") {
			const lines = Array.from({ length: 24 }, (_, index) => `Thinking line ${index + 1}`);
			this.emit({
				id: "thinking-long-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "thinking_delta",
				content: lines.join("\n"),
			} as RuntimeEvent);
			await sleep(1800);
			this.emit({
				id: "text-long-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Long thinking complete.",
			} as RuntimeEvent);
			return;
		}

		if (input === "scroll history") {
			const formatHistoryLine = (index: number): string => `History line ${String(index + 1).padStart(2, "0")}`;
			const firstBatch = Array.from({ length: 30 }, (_, index) => formatHistoryLine(index)).join("\n");
			this.emit({
				id: "text-scroll-history-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: firstBatch,
			} as RuntimeEvent);
			await sleep(700);
			const secondBatch = Array.from({ length: 30 }, (_, index) => `\n${formatHistoryLine(index + 30)}`).join("");
			this.emit({
				id: "text-scroll-history-2",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: secondBatch,
			} as RuntimeEvent);
			this.emitUsage("usage-scroll-history-final", { input: 240, output: 320, totalTokens: 560 }, true);
			return;
		}

		if (input === "queued part one\n\nqueued part two") {
			this.emit({
				id: "text-queued-batch-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "Queued batch reply",
			} as RuntimeEvent);
			this.emitUsage("usage-queued-batch-final", { input: 110, output: 41, totalTokens: 151 }, true);
			return;
		}

		if (input === "bash echo hello") {
			if (this.sessionApprovedCommands.has("echo hello")) {
				this.emitBashExecution("bash-echo-2", "echo hello", "Echo: hello");
				return;
			}
			this.emit({
				id: "perm-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "permission",
				type: "permission_requested",
				toolName: "bash",
				toolCallId: "bash-echo-1",
				riskLevel: "L3",
			} as RuntimeEvent);
			await new Promise<void>((resolve) => {
				this.pendingPermission = {
					callId: "bash-echo-1",
					toolName: "bash",
					command: "echo hello",
					resolve,
				};
			});
			this.emitBashExecution("bash-echo-1", "echo hello", "Echo: hello");
			return;
		}

		if (input === "bash pwd") {
			this.emitBashExecution("bash-pwd", "pwd", "/tmp");
			return;
		}

		if (input === "slow bash pwd") {
			this.emit({
				id: "tool-start-bash-pwd-slow",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "tool",
				type: "tool_started",
				toolName: "bash",
				toolCallId: "bash-pwd-slow",
				parameters: { command: "pwd" },
			} as RuntimeEvent);
			await sleep(2200);
			this.emit({
				id: "tool-end-bash-pwd-slow",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "tool",
				type: "tool_completed",
				toolName: "bash",
				toolCallId: "bash-pwd-slow",
				status: "success",
				durationMs: 2200,
				result: "/tmp",
			} as RuntimeEvent);
			this.emit({
				id: "tool-text-bash-pwd-slow",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "text",
				type: "text_delta",
				content: "/tmp",
			} as RuntimeEvent);
			return;
		}

		if (input === "bash ls") {
			this.emitBashExecution("bash-ls", "ls", "README.md\npackages");
			return;
		}

		if (input === "bash cat README.md") {
			this.emitBashExecution("bash-cat", "cat README.md", "# Genesis CLI");
			return;
		}

		if (input === "bash head -n 5 README.md") {
			this.emitBashExecution("bash-head", "head -n 5 README.md", "# Genesis CLI");
			return;
		}

		if (input === 'bash tail -f "logs/app.log"') {
			this.emitBashExecution("bash-tail", 'tail -f "logs/app.log"', "tailing logs/app.log");
			return;
		}

		if (input === "bash wc -l README.md") {
			this.emitBashExecution("bash-wc", "wc -l README.md", "42 README.md");
			return;
		}

		if (input === 'bash grep -n "Genesis CLI" README.md') {
			this.emitBashExecution("bash-grep", 'grep -n "Genesis CLI" README.md', "1:# Genesis CLI");
			return;
		}

		if (input === 'bash rg -n "createToolGovernor" packages') {
			this.emitBashExecution(
				"bash-rg",
				'rg -n "createToolGovernor" packages',
				"packages/app-runtime/src/governance/tool-governor.ts:1:createToolGovernor",
			);
			return;
		}

		if (input === 'bash find . -name "*.ts" -type f') {
			this.emitBashExecution("bash-find", 'find . -name "*.ts" -type f', "./packages/app-cli/src/mode-dispatch.ts");
			return;
		}

		if (input === 'bash fd -t f "governor" packages') {
			this.emitBashExecution(
				"bash-fd",
				'fd -t f "governor" packages',
				"packages/app-runtime/src/governance/tool-governor.ts",
			);
			return;
		}

		if (input === "write file") {
			this.emit({
				id: "perm-write-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "permission",
				type: "permission_requested",
				toolName: "write",
				toolCallId: "write-file-1",
				riskLevel: "L3",
			} as RuntimeEvent);
			await new Promise<void>((resolve) => {
				this.pendingPermission = { callId: "write-file-1", toolName: "write", resolve };
			});
			return;
		}

		if (input === "edit file") {
			this.emit({
				id: "perm-edit-1",
				timestamp: Date.now(),
				sessionId: this.id,
				category: "permission",
				type: "permission_requested",
				toolName: "edit",
				toolCallId: "edit-file-1",
				riskLevel: "L3",
			} as RuntimeEvent);
			await new Promise<void>((resolve) => {
				this.pendingPermission = { callId: "edit-file-1", toolName: "edit", resolve };
			});
			return;
		}
	}

	async continue(input: string): Promise<void> {
		this.receivedContinues.push(input);
		return this.prompt(input);
	}

	abort(): void {}

	async snapshotRecoveryData(): Promise<SessionRecoveryData> {
		return {
			sessionId: this.id,
			model: this.state.model,
			toolSet: [...this.state.toolSet],
			planSummary: this.state.planSummary,
			compactionSummary: this.state.compactionSummary,
			taskState: this.state.taskState,
			workingDirectory: this.context.workingDirectory,
			agentDir: this.context.agentDir,
		};
	}

	async close(): Promise<void> {}

	async switchModel(model: SessionFacade["state"]["model"]): Promise<void> {
		(this.state as { model: SessionFacade["state"]["model"]; updatedAt: number }).model = model;
		(this.state as { model: SessionFacade["state"]["model"]; updatedAt: number }).updatedAt = Date.now();
		(this.context as { model: SessionFacade["context"]["model"] }).model = model;
		for (const listener of this.stateListeners) {
			listener(this.state);
		}
	}

	async resolvePermission(
		callId: string,
		decision: "allow" | "allow_for_session" | "allow_once" | "deny",
	): Promise<void> {
		if (!this.pendingPermission || this.pendingPermission.callId !== callId) {
			throw new Error(`Unexpected permission resolution: ${callId}`);
		}
		if (
			decision === "allow_for_session" &&
			this.pendingPermission.toolName === "bash" &&
			this.pendingPermission.command
		) {
			this.sessionApprovedCommands.add(this.pendingPermission.command);
		}
		const toolName = this.pendingPermission.toolName;
		this.emit({
			id: `resolved-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "permission",
			type: "permission_resolved",
			toolName,
			toolCallId: callId,
			decision,
		} as RuntimeEvent);
		const pending = this.pendingPermission;
		this.pendingPermission = null;
		pending.resolve();
	}

	onStateChange(listener: (state: SessionFacade["state"]) => void): () => void {
		this.stateListeners.add(listener);
		return () => {
			this.stateListeners.delete(listener);
		};
	}

	async compact(): Promise<void> {
		this.emit({
			type: "compaction_started",
			timestamp: Date.now(),
			category: "compaction",
			summary: undefined,
		} as never);
		if (this._compactDelayMs > 0) {
			await sleep(this._compactDelayMs);
		}
		if (this._compactFailureMessage) {
			throw new Error(this._compactFailureMessage);
		}
		this.emit({
			type: "compaction_completed",
			timestamp: Date.now(),
			category: "compaction",
			summary: {
				compressedAt: Date.now(),
				originalMessageCount: 3,
				retainedMessageCount: 1,
				estimatedTokensSaved: 128,
				compactedSummary: "Compressed conversation:\n- User wants compact mode\n- Assistant keeps only next steps",
			},
		} as never);
	}

	private emit(event: RuntimeEvent): void {
		this.events.emit(event);
	}

	private emitUsage(
		id: string,
		usage: { input: number; output: number; totalTokens: number; cacheRead?: number; cacheWrite?: number },
		isFinal: boolean,
	): void {
		this.emit({
			id,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "usage",
			type: "usage_updated",
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				totalTokens: usage.totalTokens,
			},
			isFinal,
		} as RuntimeEvent);
	}

	private emitBashExecution(callId: string, command: string, result: string): void {
		this.emit({
			id: `tool-start-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "tool",
			type: "tool_started",
			toolName: "bash",
			toolCallId: callId,
			parameters: { command },
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
			result,
		} as RuntimeEvent);
		this.emit({
			id: `tool-text-${callId}`,
			timestamp: Date.now(),
			sessionId: this.id,
			category: "text",
			type: "text_delta",
			content: result,
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
	const recentSessions: RecentSessionEntry[] = [];
	let defaultModel = session.state.model;
	return {
		createSession: () => session,
		recoverSession: () => session,
		events,
		governor: createToolGovernor(),
		planEngine: createPlanEngine(),
		recordRecentSession: async (recoveryData, options) => {
			recentSessions.unshift({ recoveryData, title: options?.title, updatedAt: Date.now() });
		},
		recordClosedRecentSession: async (_session, recoveryData, options) => {
			recentSessions.unshift({ recoveryData, title: options?.title, updatedAt: Date.now() });
		},
		recordRecentSessionInput: async (liveSession, input) => {
			const recoveryData = await liveSession.snapshotRecoveryData();
			upsertRecentSessionForTest(recentSessions, {
				...recoveryData,
				metadata: mergeRecentSessionMetadataForTest(recoveryData.metadata, {
					firstPrompt: input,
					recentMessages: [{ role: "user", text: input }],
				}),
			});
		},
		recordRecentSessionAssistantText: async (liveSession, text) => {
			const recoveryData = await liveSession.snapshotRecoveryData();
			upsertRecentSessionForTest(recentSessions, {
				...recoveryData,
				metadata: mergeRecentSessionMetadataForTest(recoveryData.metadata, {
					recentMessages: [{ role: "assistant", text }],
				}),
			});
		},
		recordRecentSessionEvent: async () => {},
		listRecentSessions: async () => recentSessions,
		searchRecentSessions: async (query) => searchRecentSessionsForTest(recentSessions, query),
		pruneRecentSessions: async (maxEntries = 10) => {
			const before = recentSessions.length;
			recentSessions.splice(maxEntries);
			return { before, after: recentSessions.length, removed: Math.max(0, before - recentSessions.length) };
		},
		getDefaultModel: () => defaultModel,
		setDefaultModel: (model) => {
			defaultModel = model;
		},
		shutdown: async () => {},
	};
}

function createSequencedRuntime(
	sessions: readonly FakeInteractiveSession[],
	recoveredSessions: Readonly<Record<string, FakeInteractiveSession>> = {},
	initialRecentSessions: readonly RecentSessionEntry[] = [],
): AppRuntime {
	const events = createEventBus();
	let createIndex = 0;
	const recentSessions = [...initialRecentSessions];
	let defaultModel = sessions[0]?.state.model ?? { id: "glm-5.1", provider: "zai", displayName: "GLM 5.1" };
	return {
		createSession: () => {
			const next = sessions[createIndex];
			createIndex += 1;
			if (!next) {
				throw new Error("No fake session available for createSession()");
			}
			return next;
		},
		recoverSession: (data) => {
			const recovered = recoveredSessions[data.sessionId.value];
			if (!recovered) {
				throw new Error(`No fake session available for recoverSession(${data.sessionId.value})`);
			}
			return recovered;
		},
		events,
		governor: createToolGovernor(),
		planEngine: createPlanEngine(),
		recordRecentSession: async (recoveryData, options) => {
			recentSessions.unshift({ recoveryData, title: options?.title, updatedAt: Date.now() });
		},
		recordClosedRecentSession: async (_session, recoveryData, options) => {
			recentSessions.unshift({ recoveryData, title: options?.title, updatedAt: Date.now() });
		},
		recordRecentSessionInput: async (liveSession, input) => {
			const recoveryData = await liveSession.snapshotRecoveryData();
			upsertRecentSessionForTest(recentSessions, {
				...recoveryData,
				metadata: mergeRecentSessionMetadataForTest(recoveryData.metadata, {
					firstPrompt: input,
					recentMessages: [{ role: "user", text: input }],
				}),
			});
		},
		recordRecentSessionAssistantText: async (liveSession, text) => {
			const recoveryData = await liveSession.snapshotRecoveryData();
			upsertRecentSessionForTest(recentSessions, {
				...recoveryData,
				metadata: mergeRecentSessionMetadataForTest(recoveryData.metadata, {
					recentMessages: [{ role: "assistant", text }],
				}),
			});
		},
		recordRecentSessionEvent: async () => {},
		listRecentSessions: async () => recentSessions,
		searchRecentSessions: async (query) => searchRecentSessionsForTest(recentSessions, query),
		pruneRecentSessions: async (maxEntries = 10) => {
			const before = recentSessions.length;
			recentSessions.splice(maxEntries);
			return { before, after: recentSessions.length, removed: Math.max(0, before - recentSessions.length) };
		},
		getDefaultModel: () => defaultModel,
		setDefaultModel: (model) => {
			defaultModel = model;
		},
		shutdown: async () => {},
	};
}

function upsertRecentSessionForTest(recentSessions: RecentSessionEntry[], recoveryData: SessionRecoveryData): void {
	const index = recentSessions.findIndex(
		(entry) => entry.recoveryData.sessionId.value === recoveryData.sessionId.value,
	);
	const existing = index >= 0 ? recentSessions[index]?.recoveryData : undefined;
	const nextEntry = {
		recoveryData: existing
			? {
					...recoveryData,
					model: {
						...existing.model,
						...recoveryData.model,
					},
					toolSet: recoveryData.toolSet.length > 0 ? recoveryData.toolSet : existing.toolSet,
					metadata: mergeRecentSessionMetadataForTest(existing.metadata, recoveryData.metadata ?? undefined),
				}
			: recoveryData,
		updatedAt: Date.now(),
	};
	if (index >= 0) {
		recentSessions.splice(index, 1);
	}
	recentSessions.unshift(nextEntry);
}

function mergeRecentSessionMetadataForTest(
	existing: SessionRecoveryData["metadata"],
	incoming: Partial<NonNullable<SessionRecoveryData["metadata"]>> | undefined,
): NonNullable<SessionRecoveryData["metadata"]> {
	const next = incoming ?? {};
	const recentMessages = mergeRecentSessionMessagesForTest(existing?.recentMessages, next.recentMessages);
	return {
		firstPrompt: existing?.firstPrompt ?? next.firstPrompt,
		summary: next.summary ?? existing?.summary,
		messageCount: Math.max(existing?.messageCount ?? 0, recentMessages.length),
		fileSizeBytes: existing?.fileSizeBytes ?? 0,
		recentMessages,
		resumeSummary: existing?.resumeSummary ?? null,
	};
}

function mergeRecentSessionMessagesForTest(
	existing: NonNullable<SessionRecoveryData["metadata"]>["recentMessages"] | undefined,
	incoming: NonNullable<SessionRecoveryData["metadata"]>["recentMessages"] | undefined,
): Array<{ role: "user" | "assistant"; text: string }> {
	const previous = [...(existing ?? [])];
	const next = [...(incoming ?? [])];
	if (next.length === 0) {
		return previous;
	}
	if (isRecentSessionMessagePrefixForTest(previous, next)) {
		return next;
	}
	if (isRecentSessionMessagePrefixForTest(next, previous)) {
		return previous;
	}
	const overlap = findRecentSessionMessageOverlapForTest(previous, next);
	if (overlap > 0) {
		return [...previous, ...next.slice(overlap)];
	}
	return [...previous, ...next];
}

function isRecentSessionMessagePrefixForTest(
	prefix: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
	full: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): boolean {
	if (prefix.length > full.length) {
		return false;
	}
	return prefix.every((message, index) => {
		const candidate = full[index];
		return candidate?.role === message.role && candidate.text === message.text;
	});
}

function findRecentSessionMessageOverlapForTest(
	previous: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
	next: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): number {
	const maxOverlap = Math.min(previous.length, next.length);
	for (let size = maxOverlap; size > 0; size -= 1) {
		let matches = true;
		for (let index = 0; index < size; index += 1) {
			const previousMessage = previous[previous.length - size + index];
			const nextMessage = next[index];
			if (previousMessage?.role !== nextMessage?.role || previousMessage?.text !== nextMessage?.text) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return size;
		}
	}
	return 0;
}

function searchRecentSessionsForTest(
	recentSessions: readonly RecentSessionEntry[],
	query: string,
): readonly RecentSessionSearchHit[] {
	const normalizedQuery = query.toLowerCase();
	if (normalizedQuery.length === 0) {
		return [...recentSessions]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((entry) => ({
				entry,
				headline:
					entry.title ??
					entry.recoveryData.metadata?.firstPrompt ??
					entry.recoveryData.metadata?.summary ??
					entry.recoveryData.sessionId.value,
				snippet:
					entry.recoveryData.metadata?.summary ??
					entry.recoveryData.metadata?.recentMessages.find((message) => message.role === "assistant")?.text ??
					entry.recoveryData.metadata?.recentMessages.find((message) => message.role === "user")?.text ??
					entry.recoveryData.sessionId.value,
				matchSource: "recent",
			}));
	}
	return recentSessions
		.map((entry) => buildSearchHitForTest(entry, normalizedQuery))
		.filter((hit): hit is RecentSessionSearchHit => hit !== null)
		.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
}

function buildSearchHitForTest(entry: RecentSessionEntry, query: string): RecentSessionSearchHit | null {
	const fields = [
		{ source: "title" as const, value: entry.title },
		{ source: "first_prompt" as const, value: entry.recoveryData.metadata?.firstPrompt },
		{ source: "summary" as const, value: entry.recoveryData.metadata?.summary },
		...(entry.recoveryData.metadata?.recentMessages.map((message) => ({
			source: message.role === "user" ? ("recent_user_message" as const) : ("recent_assistant_message" as const),
			value: message.text,
		})) ?? []),
	];
	const matched = fields.find((field) => (field.value ?? "").toLowerCase().includes(query));
	if (!matched) {
		return null;
	}
	return {
		entry,
		headline:
			entry.title ??
			entry.recoveryData.metadata?.firstPrompt ??
			entry.recoveryData.metadata?.summary ??
			entry.recoveryData.sessionId.value,
		snippet: matched.value ?? "",
		matchSource: matched.source,
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	it("shows the debug trace in the welcome history buffer when debug logging is enabled", async () => {
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-06T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			io: {
				async mkdir() {},
				async appendFile() {},
				async writeFile() {},
				async readdir() {
					return [];
				},
				async rm() {},
			},
		});
		const session = new FakeInteractiveSession({ sessionId: "session-debug-trace" });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("Debug trace: 20260406T120000Z-p4321-deadbeef"));

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await logger.shutdown();
		}
	}, 10000);

	it("writes resume browser interaction scopes into debug logs", async () => {
		const writes: Array<{ path: string; data: string }> = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-06T12:30:00.000Z"),
			pid: 9876,
			randomHex: () => "feedbeef",
			io: {
				async mkdir() {},
				async appendFile(path, data) {
					writes.push({ path, data });
				},
				async writeFile() {},
				async readdir() {
					return [];
				},
				async rm() {},
			},
		});
		const initialSession = new FakeInteractiveSession({ sessionId: "session-debug-resume" });
		const recoveredId = "session-debug-recovered";
		const recoveredSession = new FakeInteractiveSession({ sessionId: recoveredId });
		const runtime = createSequencedRuntime([initialSession], { [recoveredId]: recoveredSession }, [
			{
				recoveryData: {
					sessionId: { value: recoveredId },
					model: { id: "glm-5.1", provider: "zai" },
					toolSet: ["bash"],
					planSummary: null,
					compactionSummary: null,
					metadata: {
						summary: "继续推进 resume 摘要",
						firstPrompt: "把 resume 的标题做得更像 Claude",
						messageCount: 2,
						fileSizeBytes: 128,
						recentMessages: [
							{ role: "user", text: "把 resume 的标题做得更像 Claude" },
							{ role: "assistant", text: "我先整理 resume metadata。" },
						],
					},
					taskState: { status: "idle", currentTaskId: null, startedAt: null },
				},
				updatedAt: Date.now(),
			},
		]);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/resume\r");
				await waitFor(() => screen.snapshot().includes("Goal: 继续推进 resume 摘要"));
				input.write("Claude");
				await waitFor(() => screen.snapshot().includes("filter: Claude"));
				input.write(Buffer.from([0x16]));
				await waitFor(() => screen.snapshot().includes("Preview"));
				input.write("\r");
				await waitFor(() => screen.snapshot().includes(`Resumed: ${recoveredId}`));

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await logger.shutdown();
		}

		const runtimeLog = writes
			.filter((write) => write.path.includes("runtime-") && write.path.endsWith(".jsonl"))
			.map((write) => write.data)
			.join("");
		expect(runtimeLog).toContain('"scope":"resume.browser.open"');
		expect(runtimeLog).toContain('"scope":"resume.browser.search"');
		expect(runtimeLog).toContain('"scope":"resume.browser.preview"');
		expect(runtimeLog).toContain('"scope":"resume.browser.resume"');
	}, 10000);

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
			const userLine = findLineIndexContaining(snapshot, "hello");
			const assistantLine = findLineIndexContaining(snapshot, "Hi from Genesis");
			const footerSeparatorLine = findLineIndexContaining(snapshot, "────────────────");
			expect(assistantLine - userLine).toBe(2);
			expect(footerSeparatorLine - assistantLine).toBeLessThanOrEqual(2);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("starts a fresh session on /clear and drops the previous transcript", async () => {
		const firstSession = new FakeInteractiveSession({ sessionId: "session-before-clear" });
		const secondSession = new FakeInteractiveSession({ sessionId: "session-after-clear" });
		const runtime = createSequencedRuntime([firstSession, secondSession]);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("hello\r");
			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));

			input.write("/clear\r");
			await waitFor(() => screen.snapshot().includes("Started a new session: session-after-clear"));

			const snapshot = screen.snapshot();
			expect(snapshot).toContain("Previous session saved: session-before-clear");
			expect(snapshot).not.toContain("Hi from Genesis");
			expect(snapshot).not.toContain("hello");
			expect(snapshot).toContain("Genesis CLI");
			expect(snapshot).toContain("❯");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("treats soft-deleted slash commands as unavailable in /help", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-help" });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/help revert\r");
			await waitFor(() => screen.snapshot().includes("Unknown command: /revert"));
			expect(screen.snapshot()).toContain("Type /help to see all commands.");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows only public commands in /help listings", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-help-listing" });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/help\r");
			await waitFor(() => output.getRawOutput().includes("Ctrl+C"));
			const rawOutput = output.getRawOutput();
			expect(rawOutput).toContain("/changes");
			expect(rawOutput).toContain("/status");
			expect(rawOutput).toContain("/model");
			expect(rawOutput).not.toContain("/config");
			expect(screen.snapshot()).toContain("Tips:");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows a git working-tree summary for /changes", async () => {
		const { repoDir } = await createGitRepoFixture({ modifiedFile: "notes.txt" });
		const session = new FakeInteractiveSession({ sessionId: "session-changes", workingDirectory: repoDir });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/changes\r");
				await waitFor(() => screen.snapshot().includes("Working tree:"));
				expect(screen.snapshot()).toContain("git status --porcelain:");
				expect(screen.snapshot()).toContain("notes.txt");
				expect(screen.snapshot()).toContain("git diff --stat:");
				expect(screen.snapshot()).toContain("Next: /review to inspect, or /diff [file] to see patches.");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	}, 10000);

	it("shows a file-scoped patch for /diff <file>", async () => {
		const { repoDir } = await createGitRepoFixture({
			modifiedFile: "notes.txt",
			initialContent: "hello\n",
			updatedContent: "hello changed\n",
		});
		const session = new FakeInteractiveSession({ sessionId: "session-diff", workingDirectory: repoDir });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/diff notes.txt\r");
				await waitFor(() => output.getRawOutput().includes("--- a/notes.txt"));
				expect(output.getRawOutput()).toContain("--- a/notes.txt");
				expect(output.getRawOutput()).toContain("+++ b/notes.txt");
				expect(output.getRawOutput()).toContain("+hello changed");
				expect(output.getRawOutput()).toContain("Next: /review to see a summary, or keep iterating.");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	}, 10000);

	it("uses the shared working-tree summary in /review and omits hidden revert guidance", async () => {
		const { repoDir } = await createGitRepoFixture({ modifiedFile: "notes.txt" });
		const session = new FakeInteractiveSession({ sessionId: "session-review", workingDirectory: repoDir });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/review\r");
				await waitFor(() => screen.snapshot().includes("Review tips:"));
				expect(screen.snapshot()).toContain("Working tree:");
				expect(screen.snapshot()).toContain("git status --porcelain:");
				expect(screen.snapshot()).toContain("/diff <file>   Inspect a specific patch");
				expect(screen.snapshot()).toContain("Use git manually if you want to discard changes");
				expect(screen.snapshot()).not.toContain("/revert");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	}, 10000);

	it("reports a clean repo in /review", async () => {
		const { repoDir } = await createGitRepoFixture({ modifiedFile: "notes.txt", updatedContent: null });
		const session = new FakeInteractiveSession({ sessionId: "session-review-clean", workingDirectory: repoDir });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/review\r");
				await waitFor(() => screen.snapshot().includes("Review: clean working tree."));
				expect(screen.snapshot()).toContain("Next: continue chatting, or /changes if you want a snapshot.");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(repoDir, { recursive: true, force: true });
		}
	}, 10000);

	it("keeps /status available to users as a low-cost session snapshot", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-status", workingDirectory: "/tmp/project" });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/help status\r");
			await waitFor(() => screen.snapshot().includes("/status"));
			expect(screen.snapshot()).toContain("Show status");

			input.write("/status\r");
			await waitFor(() => screen.snapshot().includes("Session: session-status"));
			expect(screen.snapshot()).toContain("CWD: /tmp/project");
			expect(screen.snapshot()).toContain("Type a prompt, or /help for commands");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("persists runtime-owned history from live user and assistant turns", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-runtime-history" });
		session.queueMultiChunkHello();
		const runtime = createFakeRuntime(session);
		let inputPersistCalls = 0;
		const originalRecordRecentSessionInput = runtime.recordRecentSessionInput.bind(runtime);
		runtime.recordRecentSessionInput = async (...args) => {
			inputPersistCalls += 1;
			return originalRecordRecentSessionInput(...args);
		};
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("hello\r");
			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));
			let firstPromptPersisted = false;
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const recent = await runtime.listRecentSessions();
				if (recent[0]?.recoveryData.metadata?.firstPrompt === "hello") {
					firstPromptPersisted = true;
					break;
				}
				await sleep(10);
			}
			expect(inputPersistCalls).toBeGreaterThan(0);
			expect(firstPromptPersisted).toBe(true);

			const recent = await runtime.listRecentSessions();
			expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "Hi from Genesis" },
			]);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("preserves firstPrompt and avoids duplicates for queued follow-up turns", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-runtime-queued-history" });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow hello\r");
			await waitFor(() => screen.snapshot().includes("Thinking"));

			input.write("queued followup\r");
			await waitFor(() => screen.snapshot().includes("Queued: queued followup"));
			await waitFor(() => screen.snapshot().includes("Queued follow-up reply"), 5000);

			let firstPromptPersisted = false;
			for (let attempt = 0; attempt < 250; attempt += 1) {
				const recent = await runtime.listRecentSessions();
				if (recent[0]?.recoveryData.metadata?.recentMessages?.length === 4) {
					firstPromptPersisted = recent[0]?.recoveryData.metadata?.firstPrompt === "slow hello";
					break;
				}
				await sleep(10);
			}

			expect(firstPromptPersisted).toBe(true);
			const recent = await runtime.listRecentSessions();
			expect(recent[0]?.recoveryData.metadata?.recentMessages).toEqual([
				{ role: "user", text: "slow hello" },
				{ role: "assistant", text: "First delayed reply" },
				{ role: "user", text: "queued followup" },
				{ role: "assistant", text: "Queued follow-up reply" },
			]);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("switches the current model and persists the new default via /model", async () => {
		const { agentDir, settingsPath } = await createModelFixture();
		const session = new FakeInteractiveSession({ sessionId: "session-model", agentDir });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive", {
					modelHost: {
						agentDir,
						settingsPath,
						bootstrapDefaults: {
							baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/",
							api: "openai-completions",
						},
					},
				}).start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("/model glm-5.2\r");
				await waitFor(() => runtime.getDefaultModel().id === "glm-5.2");
				expect(output.getRawOutput()).toContain("Current model: glm-5.2");
				expect(runtime.getDefaultModel().id).toBe("glm-5.2");
				expect(session.state.model.id).toBe("glm-5.2");
				expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
					provider: "zai",
					model: "glm-5.2",
				});

				input.write("/model\r");
				await waitFor(() => output.getRawOutput().includes("Available models:"));
				expect(output.getRawOutput()).toContain("glm-5.2 (current)");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
			await rm(dirname(settingsPath), { recursive: true, force: true });
		}
	}, 10000);

	it("opens a resume browser, filters as you type, and resumes the selected session", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "genesis-clear-resume-"));
		const recoveredSessionId = "session-recovered";
		try {
			const sessionFile = join(agentDir, "transcript.jsonl");
			await writeSessionTranscript(sessionFile, recoveredSessionId, [
				{ role: "user", content: "本地所有修改，commit & push" },
				{ role: "assistant", content: "我会先检查工作区并整理提交内容。" },
				{ role: "user", content: "继续推进 /resume 的体验对齐" },
			]);
			const recoveredData: SessionRecoveryData = {
				sessionId: { value: recoveredSessionId },
				model: { id: "unknown", provider: "zai" },
				toolSet: ["bash"],
				planSummary: null,
				compactionSummary: null,
				metadata: {
					summary: "继续推进 /resume 的体验对齐",
					firstPrompt: "本地所有修改，commit & push",
					messageCount: 3,
					fileSizeBytes: 256,
					recentMessages: [
						{ role: "user", text: "本地所有修改，commit & push" },
						{ role: "assistant", text: "我会先检查工作区并整理提交内容。" },
						{ role: "user", text: "继续推进 /resume 的体验对齐" },
					],
				},
				taskState: { status: "idle", currentTaskId: null, startedAt: null },
				workingDirectory: "/tmp",
				agentDir,
				sessionFile,
			};
			const initialSession = new FakeInteractiveSession({
				sessionId: "session-before-resume",
				agentDir,
			});
			const recoveredSession = new FakeInteractiveSession({
				sessionId: recoveredSessionId,
				agentDir,
			});
			const runtime = createSequencedRuntime(
				[initialSession],
				{
					[recoveredSessionId]: recoveredSession,
				},
				[{ recoveryData: recoveredData, updatedAt: Date.now() }],
			);
			const input = new FakeTtyInput();
			const output = new FakeTtyOutput();

			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => screen.snapshot().includes("❯"));

				input.write("hello\r");
				await waitFor(() => screen.snapshot().includes("Hi from Genesis"));

				input.write("/resume\r");
				await waitFor(() => screen.snapshot().includes("Goal: 继续推进 /resume 的体验对齐"));
				expect(screen.snapshot()).toContain("Search>");
				expect(screen.snapshot()).toContain("继续推进 /resume 的体验对齐");
				expect(screen.snapshot()).toContain("Goal: 继续推进 /resume 的体验对齐");
				expect(screen.snapshot()).toContain("User: 本地所有修改，commit & push");
				expect(screen.snapshot()).toContain("Type to search");

				input.write("commit & push");
				await waitFor(() => screen.snapshot().includes("filter: commit & push"));
				expect(screen.snapshot()).toContain("本地所有修改，commit & push");
				expect(screen.snapshot()).toContain("Goal: 继续推进 /resume 的体验对齐");

				input.write("\r");
				await waitFor(() => screen.snapshot().includes(`Resumed: ${recoveredSessionId}`));

				const snapshot = screen.snapshot();
				expect(snapshot).toContain("continue this session");
				expect(snapshot).not.toContain("Hi from Genesis");
				expect(snapshot).not.toContain("session-before-resume");
				expect(snapshot).toContain("Restored context:");
				expect(snapshot).toContain("User: 本地所有修改，commit & push");
				expect(snapshot).toContain("Assistant: 我会先检查工作区并整理提交内容。");
				expect(snapshot).toContain("User: 继续推进 /resume 的体验对齐");
				expect(snapshot).toContain("❯");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	}, 10000);

	it("supports arrow selection and ctrl+v preview inside the resume browser", async () => {
		const firstRecoveredId = "session-search-first";
		const secondRecoveredId = "session-search-second";
		const initialSession = new FakeInteractiveSession({ sessionId: "session-before-search" });
		const firstRecovered = new FakeInteractiveSession({ sessionId: firstRecoveredId });
		const secondRecovered = new FakeInteractiveSession({ sessionId: secondRecoveredId });
		const runtime = createSequencedRuntime(
			[initialSession],
			{
				[firstRecoveredId]: firstRecovered,
				[secondRecoveredId]: secondRecovered,
			},
			[
				{
					recoveryData: {
						sessionId: { value: firstRecoveredId },
						model: { id: "glm-5.1", provider: "zai" },
						toolSet: ["bash"],
						planSummary: null,
						compactionSummary: null,
						metadata: {
							summary: "修 README 发布文案",
							firstPrompt: "README 发布文案调整",
							messageCount: 2,
							fileSizeBytes: 256,
							recentMessages: [
								{ role: "user", text: "README 发布文案调整" },
								{ role: "assistant", text: "我先看首页文案。" },
							],
						},
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
					updatedAt: Date.now() - 10_000,
				},
				{
					recoveryData: {
						sessionId: { value: secondRecoveredId },
						model: { id: "glm-5.1", provider: "zai" },
						toolSet: ["bash"],
						planSummary: null,
						compactionSummary: null,
						metadata: {
							summary: "README 发布说明补充",
							firstPrompt: "README 发布说明补充",
							messageCount: 2,
							fileSizeBytes: 256,
							recentMessages: [
								{ role: "user", text: "README 发布说明补充" },
								{ role: "assistant", text: "我先补充安装段落。" },
							],
						},
						taskState: { status: "idle", currentTaskId: null, startedAt: null },
					},
					updatedAt: Date.now(),
				},
			],
		);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/resume\r");
			await waitFor(() => screen.snapshot().includes("Goal: README 发布说明补充"));
			input.write("README 发布");
			await waitFor(() => screen.snapshot().includes("❯ README 发布说明补充"));
			expect(screen.snapshot()).toContain("❯ README 发布说明补充");
			expect(screen.snapshot()).toContain("README 发布文案调整");
			expect(screen.snapshot()).toContain("Goal: README 发布说明补充");

			input.write("\u001b[B");
			await waitFor(() => screen.snapshot().includes("❯ README 发布文案调整"));

			input.write(Buffer.from([0x16]));
			await waitFor(() => screen.snapshot().includes("Preview"));
			expect(screen.snapshot()).toContain("User asked: README 发布文案调整");

			input.write("\r");
			await waitFor(() => screen.snapshot().includes(`Resumed: ${firstRecoveredId}`));
			expect(screen.snapshot()).toContain("User: README 发布文案调整");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("runs /compact without crashing and keeps the prompt visible", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-compact", compactDelayMs: 150 });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("hello\r");
			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));

			input.write("/compact\r");
			await waitFor(() => screen.snapshot().includes("Compacting."));
			await waitFor(() => screen.snapshot().includes("Compaction completed."));

			const snapshot = screen.snapshot();
			expect(snapshot).toContain("Compaction completed.");
			expect(snapshot).toContain("❯");

			input.write("hello\r");
			await waitFor(() => countOccurrences(screen.snapshot(), "Hi from Genesis") >= 2);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("queues input entered during compacting and sends it after compaction completes", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-compact-queue", compactDelayMs: 150 });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/compact\r");
			await waitFor(() => screen.snapshot().includes("Compacting."));

			input.write("queued during compact\r");
			await waitFor(() => screen.snapshot().includes("1 queued"));
			expect(session.getReceivedContinues()).toEqual([]);

			await waitFor(() => screen.snapshot().includes("Compaction completed."));
			await waitFor(() => session.getReceivedContinues().includes("queued during compact"));

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows compacted conversation details with ctrl+o after /compact completes", async () => {
		const session = new FakeInteractiveSession({ sessionId: "session-compact-details", compactDelayMs: 50 });
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/compact\r");
			await waitFor(() => screen.snapshot().includes("Compaction completed."));
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));

			input.write(Buffer.from([0x0f]));
			await waitFor(() => screen.snapshot().includes("Compaction summary"));
			expect(screen.snapshot()).toContain("Compressed conversation:");
			expect(screen.snapshot()).toContain("Assistant keeps only next steps");

			input.write("\x1b");
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));
			expect(screen.snapshot()).not.toContain("Assistant keeps only next steps");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("keeps the TTY alive when /compact fails", async () => {
		const session = new FakeInteractiveSession({
			sessionId: "session-compact-failure",
			compactDelayMs: 50,
			compactFailureMessage: "compact exploded",
		});
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("/compact\r");
			await waitFor(() => screen.snapshot().includes("Compacting."));
			await waitFor(() => screen.snapshot().includes("Error: compact exploded"));
			expect(screen.snapshot()).toContain("❯");

			input.write("hello\r");
			await waitFor(() => session.getReceivedPrompts().includes("hello"));
			await waitFor(() => screen.snapshot().includes("Hi from Genesis"));

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

	it("animates thinking, shows elapsed time and usage, and previews queued prompts before the next turn starts", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow hello\r");
			await waitFor(() => screen.snapshot().includes("Thinking."));
			await waitFor(() => screen.snapshot().includes("↓ 32 tokens"));

			input.write("queued followup\r");
			await waitFor(() => screen.snapshot().includes("Queued: queued followup"));
			await waitFor(() => {
				const snapshot = screen.snapshot();
				return snapshot.includes("Thinking..") || snapshot.includes("Thinking...");
			}, 2000);
			await waitFor(() => screen.snapshot().includes("2s"), 3000);
			await waitFor(() => screen.snapshot().includes("First delayed reply"), 4000);
			await waitFor(() => screen.snapshot().includes("Queued follow-up reply"), 3000);

			const snapshot = screen.snapshot();
			expect(snapshot).toContain("queued followup");
			expect(snapshot).toContain("Queued follow-up reply");
			expect(snapshot).toContain("Last turn");
			expect(snapshot).toContain("Session");
			expect(snapshot).toContain("↓ 33 tokens");
			expect(snapshot).toContain("↓ 97 tokens");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("animates responding dots during a streaming reply", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow respond\r");
			await waitFor(() => screen.snapshot().includes("Responding."));
			await waitFor(() => screen.snapshot().includes("↓ 12 tokens"));
			await waitFor(() => {
				const snapshot = screen.snapshot();
				return snapshot.includes("Responding..") || snapshot.includes("Responding...");
			}, 2000);
			await waitFor(() => /\b[23]s\b/.test(screen.snapshot()), 4000);
			await waitFor(() => screen.snapshot().includes("Draft reply finished"), 3000);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("keeps one blank line before the streaming assistant reply", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow respond\r");
			await waitFor(() => screen.snapshot().includes("Draft reply"));

			const snapshot = screen.snapshot();
			const userLine = findLineIndexContaining(snapshot, "slow respond");
			const assistantLine = findLineIndexContaining(snapshot, "Draft reply");
			expect(assistantLine - userLine).toBe(2);

			await waitFor(() => screen.snapshot().includes("Draft reply finished"), 3000);
			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows a pending down-arrow once assistant text is visible even before usage arrives", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("respond without usage\r");
			await waitFor(() => screen.snapshot().includes("Reply without usage yet"));
			const snapshot = screen.snapshot();
			expect(snapshot).toContain("Responding");
			expect(snapshot).toContain("↓");
			expect(snapshot).not.toContain("tokens");

			await waitFor(() => screen.snapshot().includes("Reply without usage yet finished"), 3000);
			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("keeps thinking visible when queued backlog appears after responding has started", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow respond\r");
			await waitFor(() => screen.snapshot().includes("Responding."));

			input.write("queued after responding\r");
			await waitFor(() => screen.snapshot().includes("Queued: queued after responding"));

			const snapshot = screen.snapshot();
			expect(snapshot).toContain("Thinking");
			expect(snapshot).not.toContain("Responding");

			await waitFor(() => screen.snapshot().includes("Draft reply finished"), 3000);
			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("batches all queued inputs into a single continuation turn", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow hello\r");
			await waitFor(() => screen.snapshot().includes("Thinking."));

			input.write("queued part one\r");
			await waitFor(() => screen.snapshot().includes("Queued: queued part one"));

			input.write("queued part two\r");
			await waitFor(() => screen.snapshot().includes("Queued 2: queued part two"));

			await waitFor(() => screen.snapshot().includes("Queued batch reply"), 4000);
			expect(session.getReceivedPrompts()).toContain("slow hello");
			expect(session.getReceivedContinues()).toEqual(["queued part one\n\nqueued part two"]);
			const snapshot = screen.snapshot();
			expect(snapshot).toContain("queued part one");
			expect(snapshot).toContain("queued part two");
			expect(output.getRawOutput().match(QUEUED_ROW_HIGHLIGHT_REGEX)?.length ?? 0).toBeGreaterThanOrEqual(2);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not emit full-screen clear sequences during interactive redraws", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash echo hello\r");
			await waitFor(() => screen.snapshot().includes("choice [Enter/1/2/3]>"));
			input.write("1\r");
			await waitFor(() => screen.snapshot().includes("Echo: hello"), 3000);

			expect(output.getRawOutput()).not.toContain("\x1b[2J");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows running tool status instead of a stale responding label during tool execution", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("slow bash pwd\r");
			await waitFor(() => screen.snapshot().includes("Running Bash(pwd)."));
			await waitFor(() => screen.snapshot().includes("2s"), 3000);
			expect(screen.snapshot()).not.toContain("Responding");
			expect(screen.snapshot()).not.toContain("Σ");
			await waitFor(() => screen.snapshot().includes("/tmp"), 4000);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("toggles the thinking detail panel with ctrl+o and esc", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("expand thinking\r");
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));
			expect(screen.snapshot()).not.toContain("Let me plan this carefully");

			input.write(Buffer.from([0x0f]));
			await waitFor(() => screen.snapshot().includes("esc to collapse"));
			await waitFor(() => screen.snapshot().includes("Let me plan this carefully"));

			input.write("\x1b");
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));
			expect(screen.snapshot()).not.toContain("Let me plan this carefully");

			await waitFor(() => screen.snapshot().includes("Planned the demo."), 4000);
			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("shows a full scrollable thinking panel with page navigation", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("long thinking\r");
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));

			input.write(Buffer.from([0x0f]));
			await waitFor(() => screen.snapshot().includes("esc to collapse"));
			await waitFor(() => screen.snapshot().includes("Thinking line 1"));
			expect(screen.snapshot()).not.toContain("Thinking line 24");

			input.write("\x1b[6~");
			await waitFor(() => screen.snapshot().includes("Thinking line 24"));

			input.write("\x1b[5~");
			await waitFor(() => screen.snapshot().includes("Thinking line 1"));

			input.write("\x1b");
			await waitFor(() => screen.snapshot().includes("ctrl+o to expand"));
			await waitFor(() => screen.snapshot().includes("Long thinking complete."), 4000);

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("enters alternate screen for interactive mode", async () => {
		const originalTerm = process.env.TERM;
		const originalTermProgram = process.env.TERM_PROGRAM;
		const originalTerminalEmulator = process.env.TERMINAL_EMULATOR;
		process.env.TERM = "xterm-256color";
		process.env.TERM_PROGRAM = "iTerm.app";
		delete process.env.TERMINAL_EMULATOR;

		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => output.getRawOutput().includes("\x1b[?1049h"));
				await waitFor(() => screen.snapshot().includes("❯"));
				expect(output.getRawOutput()).toContain("\x1b[?1004h");
				expect(output.getRawOutput()).toContain("\x1b[?1000h");
				expect(output.getRawOutput()).toContain("\x1b[?1002h");
				expect(output.getRawOutput()).toContain("\x1b[?1006h");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			if (originalTerm === undefined) {
				delete process.env.TERM;
			} else {
				process.env.TERM = originalTerm;
			}
			if (originalTermProgram === undefined) {
				delete process.env.TERM_PROGRAM;
			} else {
				process.env.TERM_PROGRAM = originalTermProgram;
			}
			if (originalTerminalEmulator === undefined) {
				delete process.env.TERMINAL_EMULATOR;
			} else {
				process.env.TERMINAL_EMULATOR = originalTerminalEmulator;
			}
		}
	});

	it("disables mouse and focus tracking inside VS Code terminals", async () => {
		const originalTerm = process.env.TERM;
		const originalTermProgram = process.env.TERM_PROGRAM;
		const originalTerminalEmulator = process.env.TERMINAL_EMULATOR;
		process.env.TERM = "xterm-256color";
		process.env.TERM_PROGRAM = "vscode";
		delete process.env.TERMINAL_EMULATOR;

		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		try {
			await withPatchedProcessTty(input, output, async (screen) => {
				const startPromise = createModeHandler("interactive").start(runtime);
				await waitFor(() => output.getRawOutput().includes("\x1b[?1049h"));
				await waitFor(() => screen.snapshot().includes("❯"));

				expect(output.getRawOutput()).not.toContain("\x1b[?1004h");
				expect(output.getRawOutput()).not.toContain("\x1b[?1000h");
				expect(output.getRawOutput()).not.toContain("\x1b[?1002h");
				expect(output.getRawOutput()).not.toContain("\x1b[?1006h");

				input.write("/exit\r");
				await startPromise;
			});
		} finally {
			if (originalTerm === undefined) {
				delete process.env.TERM;
			} else {
				process.env.TERM = originalTerm;
			}
			if (originalTermProgram === undefined) {
				delete process.env.TERM_PROGRAM;
			} else {
				process.env.TERM_PROGRAM = originalTermProgram;
			}
			if (originalTerminalEmulator === undefined) {
				delete process.env.TERMINAL_EMULATOR;
			} else {
				process.env.TERMINAL_EMULATOR = originalTerminalEmulator;
			}
		}
	}, 10000);

	it("keeps scrolled transcript history visible while new output arrives", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("scroll history\r");
			await waitFor(() => screen.snapshot().includes("History line 30"));
			expect(screen.snapshot()).not.toContain("History line 01");
			expect(screen.snapshot()).not.toContain("Genesis CLI");

			for (let index = 0; index < 10; index += 1) {
				input.write("\u001b[5~");
			}
			await waitFor(() => screen.snapshot().includes("History line 01"));
			expect(screen.snapshot()).toContain("Genesis CLI");

			await sleep(900);
			expect(screen.snapshot()).toContain("History line 01");
			expect(screen.snapshot()).not.toContain("History line 60");

			for (let index = 0; index < 10; index += 1) {
				input.write("\u001b[6~");
			}
			await waitFor(() => screen.snapshot().includes("History line 60"));

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

			input.write("bash echo hello\r");
			await waitFor(() => session.isWaitingForPermission());
			await waitFor(() => screen.snapshot().includes("choice [Enter/1/2/3]>"));
			expect(screen.snapshot()).toContain("bash echo hello");

			input.write("2\r");
			await waitFor(() => screen.snapshot().includes("Echo: hello"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("bash echo hello\r");
			await waitFor(() => countOccurrences(screen.snapshot(), "Echo: hello") >= 2);
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash pwd", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash pwd\r");
			await waitFor(() => screen.snapshot().includes("/tmp"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash ls", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash ls\r");
			await waitFor(() => screen.snapshot().includes("README.md"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash cat", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash cat README.md\r");
			await waitFor(() => screen.snapshot().includes("# Genesis CLI"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash head", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash head -n 5 README.md\r");
			await waitFor(() => screen.snapshot().includes("# Genesis CLI"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash tail", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write('bash tail -f "logs/app.log"\r');
			await waitFor(() => screen.snapshot().includes("tailing logs/app.log"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash wc", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("bash wc -l README.md\r");
			await waitFor(() => screen.snapshot().includes("42 README.md"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash grep", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write('bash grep -n "Genesis CLI" README.md\r');
			await waitFor(() => screen.snapshot().includes("1:# Genesis CLI"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash rg", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write('bash rg -n "createToolGovernor" packages\r');
			await waitFor(() => screen.snapshot().includes("createToolGovernor"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash find", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write('bash find . -name "*.ts" -type f\r');
			await waitFor(() => screen.snapshot().includes("./packages/app-cli/src/mode-dispatch.ts"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("does not show a permission prompt for bash fd", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write('bash fd -t f "governor" packages\r');
			await waitFor(() => screen.snapshot().includes("tool-governor.ts"));
			expect(screen.snapshot()).not.toContain("choice [Enter/1/2/3]>");

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);

	it("keeps the user prompt visible when write/edit permissions are requested", async () => {
		const session = new FakeInteractiveSession();
		const runtime = createFakeRuntime(session);
		const input = new FakeTtyInput();
		const output = new FakeTtyOutput();

		await withPatchedProcessTty(input, output, async (screen) => {
			const startPromise = createModeHandler("interactive").start(runtime);
			await waitFor(() => screen.snapshot().includes("❯"));

			input.write("write file\r");
			await waitFor(() => session.isWaitingForPermission());
			await waitFor(() => screen.snapshot().includes("choice [Enter/1/2/3]>"));
			expect(screen.snapshot()).toContain("write file");
			expect(screen.snapshot()).toContain("Write");

			input.write("3\r");
			await waitFor(() => !screen.snapshot().includes("choice [Enter/1/2/3]>"));

			input.write("edit file\r");
			await waitFor(() => session.isWaitingForPermission());
			await waitFor(() => screen.snapshot().includes("choice [Enter/1/2/3]>"));
			expect(screen.snapshot()).toContain("edit file");
			expect(screen.snapshot()).toContain("Edit");

			input.write("3\r");
			await waitFor(() => !screen.snapshot().includes("choice [Enter/1/2/3]>"));

			input.write("/exit\r");
			await startPromise;
		});
	}, 10000);
});
