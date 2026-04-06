import { describe, expect, it, vi } from "vitest";
import { DebugLogger, getLastDebugSession, initializeDebugLogger } from "../debug-logger.js";

describe("DebugLogger", () => {
	it("creates a trace session with timestamp, pid and random suffix", async () => {
		const writes: Array<{ path: string; data: string }> = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-06T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			io: {
				async mkdir() {},
				async appendFile(path, data) {
					writes.push({ path, data });
				},
				async writeFile() {},
			},
		});

		expect(logger.session.traceId).toBe("20260406T120000Z-p4321-deadbeef");
		expect(getLastDebugSession()?.traceId).toBe("20260406T120000Z-p4321-deadbeef");

		logger.debug("test.scope", "hello");
		await logger.flush();
		expect(writes.some((write) => write.path.endsWith("runtime.jsonl"))).toBe(true);
		await logger.shutdown();
	});

	it("records only error-and-above runtime logs outside debug mode", async () => {
		const writes: Array<{ path: string; data: string }> = [];
		const logger = new DebugLogger({
			debugEnabled: false,
			argv: [],
			now: () => new Date("2026-04-06T12:00:00.000Z"),
			randomHex: () => "deadbeef",
			io: {
				async mkdir() {},
				async appendFile(path, data) {
					writes.push({ path, data });
				},
				async writeFile() {},
			},
		});
		await logger.initialize();

		logger.info("test.info", "ignored");
		logger.error("test.error", "visible");
		logger.crash("test.crash", "fatal");
		await logger.flush();

		const runtimeLines = writes
			.filter((write) => write.path.endsWith("runtime.jsonl"))
			.flatMap((write) => write.data.trim().split("\n"))
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { level: string; message: string });

		expect(runtimeLines.map((line) => line.level)).toEqual(["ERROR", "CRASH"]);
		expect(runtimeLines.map((line) => line.message)).toContain("visible");

		expect(writes.some((write) => write.path.endsWith("error.jsonl"))).toBe(true);
		expect(writes.some((write) => write.path.endsWith("crash.jsonl"))).toBe(true);
		await logger.shutdown();
	});

	it("survives append failures and reports them to stderr", async () => {
		const stderrWrite = vi.fn();
		const logger = new DebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-06T12:00:00.000Z"),
			randomHex: () => "deadbeef",
			stderrWrite,
			io: {
				async mkdir() {},
				async appendFile() {
					throw new Error("EPERM");
				},
				async writeFile() {},
			},
		});
		await logger.initialize();

		logger.error("test.error", "will fail");
		await expect(logger.flush()).resolves.toBeUndefined();
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Failed to persist debug logs: EPERM"));
		await logger.shutdown();
	});
});
