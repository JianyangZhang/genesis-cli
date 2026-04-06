import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DebugLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRASH";

export interface DebugLoggerContext {
	readonly workingDirectory?: string;
	readonly agentDir?: string;
	readonly mode?: string;
	readonly model?: {
		readonly provider?: string;
		readonly id?: string;
		readonly displayName?: string;
	};
}

export interface DebugLoggerSession {
	readonly traceId: string;
	readonly startedAt: string;
	readonly pid: number;
	readonly debugEnabled: boolean;
	readonly logRootDir: string;
	readonly sessionDir: string;
}

interface DebugLogEntry {
	readonly timestamp: string;
	readonly level: DebugLogLevel;
	readonly traceId: string;
	readonly pid: number;
	readonly scope: string;
	readonly message: string;
	readonly data?: unknown;
}

interface LoggerMetadata extends DebugLoggerSession {
	readonly argv: readonly string[];
	readonly context: DebugLoggerContext;
}

interface LoggerIo {
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	appendFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
	writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
	readdir(path: string): Promise<readonly string[]>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

interface DebugLoggerOptions {
	readonly debugEnabled: boolean;
	readonly argv: readonly string[];
	readonly logRootDir?: string;
	readonly now?: () => Date;
	readonly pid?: number;
	readonly randomHex?: () => string;
	readonly stderrWrite?: (text: string) => void;
	readonly io?: LoggerIo;
}

const defaultIo: LoggerIo = {
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	appendFile: async (path, data, encoding) => appendFile(path, data, encoding),
	writeFile,
	readdir: async (path) => readdir(path),
	rm: async (path, options) => {
		await rm(path, options);
	},
};

const DEBUG_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const runtimeSeverityOrder: Record<DebugLogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARN: 30,
	ERROR: 40,
	CRASH: 50,
};

let activeLogger: DebugLogger | null = null;
let lastLoggerSession: DebugLoggerSession | null = null;

export class DebugLogger {
	private readonly io: LoggerIo;
	private readonly stderrWrite: (text: string) => void;
	private readonly sessionValue: DebugLoggerSession;
	private readonly runtimeLogPath: string;
	private readonly errorLogPath: string;
	private readonly crashLogPath: string;
	private readonly metadataPath: string;
	private readonly minRuntimeLevel: number;
	private readonly argv: readonly string[];
	private context: DebugLoggerContext = {};
	private initialized = false;
	private pendingWrites = new Map<string, string[]>();
	private flushScheduled = false;
	private flushing = false;
	private lastFlushPromise = Promise.resolve();
	private fatalWriteErrorReported = false;
	private readonly processListeners: Array<() => void> = [];

	constructor(options: DebugLoggerOptions) {
		this.io = options.io ?? defaultIo;
		this.stderrWrite = options.stderrWrite ?? ((text) => process.stderr.write(text));
		const startedAt = (options.now ?? (() => new Date()))().toISOString();
		const pid = options.pid ?? process.pid;
		const logRootDir = resolve(options.logRootDir ?? join(homedir(), ".genesis-cli", "debug-logs"));
		const traceId = buildTraceId(startedAt, pid, options.randomHex ?? defaultRandomHex);
		const sessionDir = join(logRootDir, traceId);
		const fileTimestamp = formatCompactTimestamp(startedAt);
		this.sessionValue = {
			traceId,
			startedAt,
			pid,
			debugEnabled: options.debugEnabled,
			logRootDir,
			sessionDir,
		};
		this.runtimeLogPath = join(sessionDir, `runtime-${fileTimestamp}.jsonl`);
		this.errorLogPath = join(sessionDir, `error-${fileTimestamp}.jsonl`);
		this.crashLogPath = join(sessionDir, `crash-${fileTimestamp}.jsonl`);
		this.metadataPath = join(sessionDir, `session-${fileTimestamp}.json`);
		this.minRuntimeLevel = options.debugEnabled ? runtimeSeverityOrder.DEBUG : runtimeSeverityOrder.ERROR;
		this.argv = [...options.argv];
	}

	get session(): DebugLoggerSession {
		return this.sessionValue;
	}

	async initialize(): Promise<void> {
		await this.cleanupExpiredSessions();
		await this.ensureInitialized();
		activeLogger = this;
		lastLoggerSession = this.sessionValue;
		this.installProcessHandlers();
		this.info("cli.start", "CLI process started", {
			argv: this.argv,
			debugEnabled: this.sessionValue.debugEnabled,
		});
	}

	updateContext(next: DebugLoggerContext): void {
		this.context = {
			...this.context,
			...next,
		};
		void this.writeMetadata();
	}

	debug(scope: string, message: string, data?: unknown): void {
		this.log("DEBUG", scope, message, data);
	}

	info(scope: string, message: string, data?: unknown): void {
		this.log("INFO", scope, message, data);
	}

	warn(scope: string, message: string, data?: unknown): void {
		this.log("WARN", scope, message, data);
	}

	error(scope: string, message: string, data?: unknown): void {
		this.log("ERROR", scope, message, data);
	}

	crash(scope: string, message: string, data?: unknown): void {
		this.log("CRASH", scope, message, data);
	}

	async flush(): Promise<void> {
		if (this.flushing) {
			await this.lastFlushPromise;
			return;
		}
		this.flushing = true;
		this.flushScheduled = false;
		const batch = this.pendingWrites;
		this.pendingWrites = new Map();
		this.lastFlushPromise = (async () => {
			try {
				await this.ensureInitialized();
				for (const [path, chunks] of batch) {
					if (chunks.length === 0) continue;
					await this.io.appendFile(path, chunks.join(""), "utf8");
				}
			} catch (error) {
				this.reportWriteFailure(error);
			} finally {
				this.flushing = false;
				if (this.pendingWrites.size > 0) {
					this.scheduleFlush();
				}
			}
		})();
		await this.lastFlushPromise;
	}

	async shutdown(): Promise<void> {
		this.info("cli.shutdown", "CLI logger shutting down");
		await this.flush();
		for (const remove of this.processListeners.splice(0)) {
			remove();
		}
		if (activeLogger === this) {
			activeLogger = null;
		}
	}

	private log(level: DebugLogLevel, scope: string, message: string, data?: unknown): void {
		const entry: DebugLogEntry = {
			timestamp: new Date().toISOString(),
			level,
			traceId: this.sessionValue.traceId,
			pid: this.sessionValue.pid,
			scope,
			message,
			...(data === undefined ? {} : { data: sanitizeForJson(data) }),
		};
		const line = `${JSON.stringify(entry)}\n`;
		if (runtimeSeverityOrder[level] >= this.minRuntimeLevel) {
			this.enqueue(this.runtimeLogPath, line);
		}
		if (runtimeSeverityOrder[level] >= runtimeSeverityOrder.ERROR) {
			this.enqueue(this.errorLogPath, line);
		}
		if (level === "CRASH") {
			this.enqueue(this.crashLogPath, line);
		}
	}

	private enqueue(path: string, line: string): void {
		const bucket = this.pendingWrites.get(path);
		if (bucket) {
			bucket.push(line);
		} else {
			this.pendingWrites.set(path, [line]);
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return;
		this.flushScheduled = true;
		setImmediate(() => {
			void this.flush();
		});
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		try {
			await this.io.mkdir(this.sessionValue.sessionDir, { recursive: true });
			await this.writeMetadata();
			this.initialized = true;
		} catch (error) {
			this.reportWriteFailure(error);
			this.initialized = true;
		}
	}

	private async cleanupExpiredSessions(): Promise<void> {
		const cutoff = Date.parse(this.sessionValue.startedAt) - DEBUG_LOG_RETENTION_MS;
		try {
			const entries = await this.io.readdir(this.sessionValue.logRootDir);
			for (const entry of entries) {
				const entryStartedAt = parseTraceTimestamp(entry);
				if (entryStartedAt === null || entryStartedAt >= cutoff) {
					continue;
				}
				try {
					await this.io.rm(join(this.sessionValue.logRootDir, entry), { recursive: true, force: true });
				} catch (error) {
					this.reportMaintenanceFailure("clean old debug logs", error);
				}
			}
		} catch (error) {
			if (!isMissingPathError(error)) {
				this.reportMaintenanceFailure("scan debug log directory", error);
			}
		}
	}

	private async writeMetadata(): Promise<void> {
		const metadata: LoggerMetadata = {
			...this.sessionValue,
			argv: this.argv,
			context: this.context,
		};
		try {
			await this.io.mkdir(this.sessionValue.sessionDir, { recursive: true });
			await this.io.writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
		} catch (error) {
			this.reportWriteFailure(error);
		}
	}

	private installProcessHandlers(): void {
		const onUnhandledRejection = (reason: unknown) => {
			this.crash("process.unhandledRejection", "Unhandled promise rejection", { reason });
			void this.flush();
		};
		const onUncaughtException = (error: Error) => {
			this.crash("process.uncaughtException", "Uncaught exception", { error });
			void this.flush();
		};
		process.on("unhandledRejection", onUnhandledRejection);
		process.on("uncaughtException", onUncaughtException);
		this.processListeners.push(() => process.off("unhandledRejection", onUnhandledRejection));
		this.processListeners.push(() => process.off("uncaughtException", onUncaughtException));
	}

	private reportWriteFailure(error: unknown): void {
		if (this.fatalWriteErrorReported) return;
		this.fatalWriteErrorReported = true;
		const message = error instanceof Error ? error.message : String(error);
		this.stderrWrite(`[genesis-debug] Failed to persist debug logs: ${message}\n`);
	}

	private reportMaintenanceFailure(action: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.stderrWrite(`[genesis-debug] Failed to ${action}: ${message}\n`);
	}
}

export async function initializeDebugLogger(options: DebugLoggerOptions): Promise<DebugLogger> {
	const logger = new DebugLogger(options);
	await logger.initialize();
	return logger;
}

export function getActiveDebugLogger(): DebugLogger | null {
	return activeLogger;
}

export function getLastDebugSession(): DebugLoggerSession | null {
	return lastLoggerSession;
}

function buildTraceId(startedAt: string, pid: number, randomHexFactory: () => string): string {
	const compactTs = formatCompactTimestamp(startedAt);
	return `${compactTs}-p${pid}-${randomHexFactory()}`;
}

function formatCompactTimestamp(startedAt: string): string {
	return startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseTraceTimestamp(traceId: string): number | null {
	const match = /^(\d{8})T(\d{6})Z-p\d+-[0-9a-f]+$/i.exec(traceId);
	if (!match) {
		return null;
	}
	const datePart = match[1];
	const timePart = match[2];
	const iso = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}Z`;
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? null : parsed;
}

function isMissingPathError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"),
	);
}

function defaultRandomHex(): string {
	return randomBytes(4).toString("hex");
}

function sanitizeForJson(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeForJson(entry));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeForJson(entry)]));
	}
	return value;
}
