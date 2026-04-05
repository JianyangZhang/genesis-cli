import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RawUpstreamEvent } from "../adapters/kernel-session-adapter.js";
import { loadPiMonoSdk, PiMonoSessionAdapter } from "../adapters/pi-mono-session-adapter.js";

type TestTool = {
	name: string;
	execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown): Promise<unknown>;
};

type TestCreateSessionOptions = {
	tools?: readonly TestTool[];
};

describe("PiMonoSessionAdapter", () => {
	it("prefers the installed kernel package when resolving the vendored sdk", async () => {
		const packageSdk = {
			AuthStorage: { create: () => ({}) },
			ModelRegistry: { create: () => ({ find: () => undefined }) },
			SessionManager: { create: () => ({}), open: () => ({}) },
			createAgentSession: async () => ({ session: {} }),
			createBashTool: () => ({ name: "bash", execute: async () => ({}) }),
			createEditTool: () => ({ name: "edit", execute: async () => ({}) }),
			createFindTool: () => ({ name: "find", execute: async () => ({}) }),
			createGrepTool: () => ({ name: "grep", execute: async () => ({}) }),
			createLsTool: () => ({ name: "ls", execute: async () => ({}) }),
			createReadTool: () => ({ name: "read", execute: async () => ({}) }),
			createWriteTool: () => ({ name: "write", execute: async () => ({}) }),
		};

		const sdk = await loadPiMonoSdk({
			importModule: async (specifier) => {
				expect(specifier).toBe("@pickle-pee/kernel");
				return packageSdk;
			},
			fileCandidates: [],
		});

		expect(sdk).toBe(packageSdk);
	});

	it("falls back to a file candidate when package resolution fails", async () => {
		const agentDir = await createAgentDir();
		const fallbackModulePath = join(agentDir, "kernel-fallback.mjs");
		await writeFile(
			fallbackModulePath,
			[
				"export const AuthStorage = { create: () => ({}) };",
				"export const ModelRegistry = { create: () => ({ find: () => undefined }) };",
				"export const SessionManager = { create: () => ({}), open: () => ({}) };",
				"export async function createAgentSession() { return { session: {} }; }",
				"export function createBashTool() { return { name: 'bash', execute: async () => ({}) }; }",
				"export function createEditTool() { return { name: 'edit', execute: async () => ({}) }; }",
				"export function createFindTool() { return { name: 'find', execute: async () => ({}) }; }",
				"export function createGrepTool() { return { name: 'grep', execute: async () => ({}) }; }",
				"export function createLsTool() { return { name: 'ls', execute: async () => ({}) }; }",
				"export function createReadTool() { return { name: 'read', execute: async () => ({}) }; }",
				"export function createWriteTool() { return { name: 'write', execute: async () => ({}) }; }",
			].join("\n"),
			"utf8",
		);

		const sdk = await loadPiMonoSdk({
			importModule: async (specifier) => {
				if (specifier === "@pickle-pee/kernel") {
					throw new Error("package not available");
				}
				return await import(specifier);
			},
			fileCandidates: [fallbackModulePath],
		});

		expect(typeof sdk.createAgentSession).toBe("function");
	});

	it("streams raw events from a prompt", async () => {
		const agentDir = await createAgentDir();
		const session = new FakeAgentSession(async (input) => {
			session.emit({ type: "agent_start" } as never);
			session.emit({
				type: "message_update",
				message: {} as never,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: `echo:${input}`,
					partial: {} as never,
				},
			} as never);
			session.emit({ type: "agent_end", messages: [] } as never);
		});

		const adapter = new PiMonoSessionAdapter({
			workingDirectory: process.cwd(),
			agentDir,
			model: { provider: "test-provider", id: "test-model" },
			createTools: () => [],
			createSession: async () => session.asAgentSession(),
		});

		const events = await collectEvents(adapter.sendPrompt("hello"));
		expect(events.map((event) => event.type)).toEqual(["agent_start", "message_update", "agent_end"]);
		expect(events[1]).toEqual(
			expect.objectContaining({
				payload: {
					kind: "text",
					content: "echo:hello",
				},
			}),
		);
	});

	it("uses followUp for continue while streaming", async () => {
		const agentDir = await createAgentDir();
		const session = new FakeAgentSession(async () => {
			session.emit({ type: "agent_start" } as never);
			session.emit({ type: "agent_end", messages: [] } as never);
		});
		session.isStreaming = true;

		const adapter = new PiMonoSessionAdapter({
			workingDirectory: process.cwd(),
			agentDir,
			model: { provider: "test-provider", id: "test-model" },
			createTools: () => [],
			createSession: async () => session.asAgentSession(),
		});

		await collectEvents(adapter.sendContinue("queued"));
		expect(session.followUpInputs).toEqual(["queued"]);
	});

	it("emits permission_request and resumes the tool after approval", async () => {
		const agentDir = await createAgentDir();
		const testFile = join(agentDir, "sample.txt");
		await writeFile(testFile, "adapter-read-ok", "utf8");

		let tools: readonly TestTool[] = [];
		const session = new FakeAgentSession(async () => {
			const readTool = tools.find((tool) => tool.name === "read");
			if (!readTool) {
				throw new Error("Expected wrapped read tool");
			}

			session.emit({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { file_path: testFile },
			} as never);

			try {
				const result = await readTool.execute("call-1", { path: testFile } as never);
				session.emit({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "read",
					result,
					isError: false,
				} as never);
			} finally {
				session.emit({ type: "agent_end", messages: [] } as never);
			}
		});

		const adapter = new PiMonoSessionAdapter({
			workingDirectory: process.cwd(),
			agentDir,
			model: { provider: "test-provider", id: "test-model" },
			toolSet: ["read"],
			createTools: (_cwd, _toolSet) => createFakeTools() as never,
			createSession: async (options) => {
				tools = ((options as TestCreateSessionOptions).tools ?? []) as readonly TestTool[];
				return session.asAgentSession();
			},
		});
		adapter.setToolExecutionGate({
			beforeToolExecution: () => ({
				type: "ask_user",
				reason: "Need approval",
				riskLevel: "L3",
			}),
		});

		const eventsPromise = collectEventsWithHook(adapter.sendPrompt("read file"), async (event) => {
			if (event.type === "permission_request") {
				await adapter.resolveToolPermission("call-1", "allow_once");
			}
		});

		const events = await eventsPromise;
		expect(events.map((event) => event.type)).toEqual([
			"permission_request",
			"tool_execution_start",
			"tool_execution_end",
			"agent_end",
		]);
	});

	it("emits tool_execution_denied when permission is rejected", async () => {
		const agentDir = await createAgentDir();
		const testFile = join(agentDir, "sample.txt");
		await writeFile(testFile, "adapter-read-ok", "utf8");

		let tools: readonly TestTool[] = [];
		const session = new FakeAgentSession(async () => {
			const readTool = tools.find((tool) => tool.name === "read");
			if (!readTool) {
				throw new Error("Expected wrapped read tool");
			}

			session.emit({
				type: "tool_execution_start",
				toolCallId: "call-2",
				toolName: "read",
				args: { file_path: testFile },
			} as never);

			try {
				await readTool.execute("call-2", { path: testFile } as never);
			} catch (error) {
				session.emit({
					type: "tool_execution_end",
					toolCallId: "call-2",
					toolName: "read",
					result: {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						details: {},
					},
					isError: true,
				} as never);
			} finally {
				session.emit({ type: "agent_end", messages: [] } as never);
			}
		});

		const adapter = new PiMonoSessionAdapter({
			workingDirectory: process.cwd(),
			agentDir,
			model: { provider: "test-provider", id: "test-model" },
			toolSet: ["read"],
			createTools: (_cwd, _toolSet) => createFakeTools() as never,
			createSession: async (options) => {
				tools = ((options as TestCreateSessionOptions).tools ?? []) as readonly TestTool[];
				return session.asAgentSession();
			},
		});
		adapter.setToolExecutionGate({
			beforeToolExecution: () => ({
				type: "ask_user",
				reason: "Need approval",
				riskLevel: "L3",
			}),
		});

		const events = await collectEventsWithHook(adapter.sendPrompt("deny read"), async (event) => {
			if (event.type === "permission_request") {
				await adapter.resolveToolPermission("call-2", "deny");
			}
		});

		expect(events.map((event) => event.type)).toEqual(["permission_request", "tool_execution_denied", "agent_end"]);
	});
});

class FakeAgentSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	public isStreaming = false;
	public readonly sessionId = "fake-session";
	public readonly sessionFile = "/tmp/fake-session.jsonl";
	public readonly followUpInputs: string[] = [];

	constructor(private readonly promptHandler: (input: string) => Promise<void>) {}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: unknown): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	async prompt(input: string): Promise<void> {
		this.isStreaming = true;
		try {
			await this.promptHandler(input);
		} finally {
			this.isStreaming = false;
		}
	}

	async followUp(input: string): Promise<void> {
		this.followUpInputs.push(input);
		this.isStreaming = false;
		this.emit({ type: "agent_end", messages: [] } as never);
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	dispose(): void {}

	asAgentSession(): ReturnType<PiMonoSessionAdapter["resume"]> extends void ? never : never {
		return this as never;
	}
}

async function createAgentDir(): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "genesis-pi-mono-"));
	await mkdir(agentDir, { recursive: true });
	return agentDir;
}

async function collectEvents(stream: AsyncIterable<RawUpstreamEvent>): Promise<RawUpstreamEvent[]> {
	const events: RawUpstreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

async function collectEventsWithHook(
	stream: AsyncIterable<RawUpstreamEvent>,
	onEvent: (event: RawUpstreamEvent) => Promise<void>,
): Promise<RawUpstreamEvent[]> {
	const events: RawUpstreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		await onEvent(event);
	}
	return events;
}

function createFakeTools(): TestTool[] {
	return [
		{
			name: "read",
			async execute(_toolCallId: string, params: unknown): Promise<unknown> {
				const path = (params as { path?: string }).path;
				if (!path) {
					throw new Error("Missing path");
				}
				return {
					content: [{ type: "text", text: await readFile(path, "utf8") }],
					details: {},
				};
			},
		},
	];
}
