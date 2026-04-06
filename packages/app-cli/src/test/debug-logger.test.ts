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
				async readdir() {
					return [];
				},
				async rm() {},
			},
		});

		expect(logger.session.traceId).toBe("20260406T120000Z-p4321-deadbeef");
		expect(getLastDebugSession()?.traceId).toBe("20260406T120000Z-p4321-deadbeef");

		logger.debug("test.scope", "hello");
		await logger.flush();
		expect(writes.some((write) => write.path.endsWith("runtime-20260406T120000Z.jsonl"))).toBe(true);
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
				async readdir() {
					return [];
				},
				async rm() {},
			},
		});
		await logger.initialize();

		logger.info("test.info", "ignored");
		logger.error("test.error", "visible");
		logger.crash("test.crash", "fatal");
		await logger.flush();

		const runtimeLines = writes
			.filter((write) => write.path.endsWith("runtime-20260406T120000Z.jsonl"))
			.flatMap((write) => write.data.trim().split("\n"))
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { level: string; message: string });

		expect(runtimeLines.map((line) => line.level)).toEqual(["ERROR", "CRASH"]);
		expect(runtimeLines.map((line) => line.message)).toContain("visible");

		expect(writes.some((write) => write.path.endsWith("error-20260406T120000Z.jsonl"))).toBe(true);
		expect(writes.some((write) => write.path.endsWith("crash-20260406T120000Z.jsonl"))).toBe(true);
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
				async readdir() {
					return [];
				},
				async rm() {},
			},
		});
		await logger.initialize();

		logger.error("test.error", "will fail");
		await expect(logger.flush()).resolves.toBeUndefined();
		expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("Failed to persist debug logs: EPERM"));
		await logger.shutdown();
	});

	it("cleans up trace directories older than seven days during startup", async () => {
		const removed: string[] = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-10T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			logRootDir: "/tmp/genesis-debug-logs",
			io: {
				async mkdir() {},
				async appendFile() {},
				async writeFile() {},
				async readdir() {
					return ["20260401T115959Z-p1-deadbeef", "20260403T120000Z-p2-feedcafe", "not-a-trace-dir"];
				},
				async rm(path) {
					removed.push(path);
				},
			},
		});

		expect(removed).toEqual(["/tmp/genesis-debug-logs/20260401T115959Z-p1-deadbeef"]);
		await logger.shutdown();
	});
});
