import { describe, expect, it, vi } from "vitest";
import { DebugLogger, getLastDebugSession, initializeDebugLogger } from "../debug-logger.js";

function formatLocalTraceTimestamp(value: Date): string {
	const padTwo = (part: number): string => String(part).padStart(2, "0");
	return (
		`${value.getFullYear()}${padTwo(value.getMonth() + 1)}${padTwo(value.getDate())}` +
		`T${padTwo(value.getHours())}${padTwo(value.getMinutes())}${padTwo(value.getSeconds())}`
	);
}

describe("DebugLogger", () => {
	it("creates a trace session with timestamp, pid and random suffix", async () => {
		const now = new Date("2026-04-06T12:00:00.000Z");
		const expectedTimestamp = formatLocalTraceTimestamp(now);
		const writes: Array<{ path: string; data: string }> = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => now,
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

		expect(logger.session.traceId).toBe(`${expectedTimestamp}-p4321-deadbeef`);
		expect(getLastDebugSession()?.traceId).toBe(`${expectedTimestamp}-p4321-deadbeef`);

		logger.debug("test.scope", "hello");
		await logger.flush();
		expect(writes.some((write) => write.path.endsWith(`runtime-${expectedTimestamp}.jsonl`))).toBe(true);
		await logger.shutdown();
	});

	it("records only error-and-above runtime logs outside debug mode", async () => {
		const now = new Date("2026-04-06T12:00:00.000Z");
		const expectedTimestamp = formatLocalTraceTimestamp(now);
		const writes: Array<{ path: string; data: string }> = [];
		const logger = new DebugLogger({
			debugEnabled: false,
			argv: [],
			now: () => now,
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
			.filter((write) => write.path.endsWith(`runtime-${expectedTimestamp}.jsonl`))
			.flatMap((write) => write.data.trim().split("\n"))
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { level: string; message: string });

		expect(runtimeLines.map((line) => line.level)).toEqual(["ERROR", "CRASH"]);
		expect(runtimeLines.map((line) => line.message)).toContain("visible");

		expect(writes.some((write) => write.path.endsWith(`error-${expectedTimestamp}.jsonl`))).toBe(true);
		expect(writes.some((write) => write.path.endsWith(`crash-${expectedTimestamp}.jsonl`))).toBe(true);
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
		const recentDir = `${formatLocalTraceTimestamp(new Date("2026-04-03T12:00:00.000Z"))}-p2-feedcafe`;
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
					return ["20260401T115959Z-p1-deadbeef", recentDir, "not-a-trace-dir"];
				},
				async rm(path) {
					removed.push(path);
				},
			},
		});

		expect(removed).toEqual(["/tmp/genesis-debug-logs/20260401T115959Z-p1-deadbeef"]);
		await logger.shutdown();
	});

	it("keeps only the ten most recent trace directories during startup", async () => {
		const removed: string[] = [];
		const entries = Array.from({ length: 12 }, (_, index) => {
			const pid = String(index + 1).padStart(2, "0");
			return `20260412T120000-p${pid}-deadbeef`;
		});
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-12T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			logRootDir: "/tmp/genesis-debug-logs",
			io: {
				async mkdir() {},
				async appendFile() {},
				async writeFile() {},
				async readdir() {
					return entries;
				},
				async rm(path) {
					removed.push(path);
				},
			},
		});

		expect(removed).toEqual([
			"/tmp/genesis-debug-logs/20260412T120000-p11-deadbeef",
			"/tmp/genesis-debug-logs/20260412T120000-p12-deadbeef",
		]);
		await logger.shutdown();
	});

	it("honors env overrides for debug log retention settings", async () => {
		const removed: string[] = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-20T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			logRootDir: "/tmp/genesis-debug-logs",
			env: {
				...process.env,
				GENESIS_DEBUG_LOG_MAX_SESSIONS: "2",
				GENESIS_DEBUG_LOG_RETENTION_DAYS: "3",
			},
			io: {
				async mkdir() {},
				async appendFile() {},
				async writeFile() {},
				async readdir() {
					return [
						"20260420T120000-p1-deadbeef",
						"20260419T120000-p2-deadbeef",
						"20260418T120000-p3-deadbeef",
						"20260417T120000-p4-deadbeef",
					];
				},
				async rm(path) {
					removed.push(path);
				},
			},
		});

		expect(removed).toEqual([
			"/tmp/genesis-debug-logs/20260418T120000-p3-deadbeef",
			"/tmp/genesis-debug-logs/20260417T120000-p4-deadbeef",
		]);
		await logger.shutdown();
	});

	it("applies the seven-day ttl even within the ten most recent sessions", async () => {
		const removed: string[] = [];
		const logger = await initializeDebugLogger({
			debugEnabled: true,
			argv: ["--debug"],
			now: () => new Date("2026-04-20T12:00:00.000Z"),
			pid: 4321,
			randomHex: () => "deadbeef",
			logRootDir: "/tmp/genesis-debug-logs",
			io: {
				async mkdir() {},
				async appendFile() {},
				async writeFile() {},
				async readdir() {
					return [
						"20260420T120000-p1-deadbeef",
						"20260419T120000-p2-deadbeef",
						"20260418T120000-p3-deadbeef",
						"20260417T120000-p4-deadbeef",
						"20260416T120000-p5-deadbeef",
						"20260415T120000-p6-deadbeef",
						"20260414T120000-p7-deadbeef",
						"20260410T120000-p8-deadbeef",
						"20260409T120000-p9-deadbeef",
					];
				},
				async rm(path) {
					removed.push(path);
				},
			},
		});

		expect(removed).toEqual([
			"/tmp/genesis-debug-logs/20260410T120000-p8-deadbeef",
			"/tmp/genesis-debug-logs/20260409T120000-p9-deadbeef",
		]);
		await logger.shutdown();
	});
});
