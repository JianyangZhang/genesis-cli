import { describe, expect, it, vi } from "vitest";
import { DebugLogger, getLastDebugSession, initializeDebugLogger } from "../debug-logger.js";

function formatLocalTraceTimestamp(value: Date): string {
	const padTwo = (part: number): string => String(part).padStart(2, "0");
	const offsetMinutes = -value.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteMinutes = Math.abs(offsetMinutes);
	return (
		`${value.getFullYear()}${padTwo(value.getMonth() + 1)}${padTwo(value.getDate())}` +
		`T${padTwo(value.getHours())}${padTwo(value.getMinutes())}${padTwo(value.getSeconds())}` +
		`${sign}${padTwo(Math.floor(absoluteMinutes / 60))}${padTwo(absoluteMinutes % 60)}`
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
});
