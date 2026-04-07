import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_RECENT_SESSION_MAX_ENTRIES = 10;
const RECENT_SESSION_MAX_ENTRIES_ENV = "GENESIS_RECENT_SESSION_MAX_ENTRIES";
const SESSION_FILE_RETENTION_BUFFER = 5;

interface SessionMetadata {
	readonly cwd?: string;
	readonly sessionId?: string;
}

export class SessionManager {
	private constructor(
		private readonly cwd: string,
		private readonly sessionId: string,
		private readonly sessionFile?: string,
	) {}

	static create(cwd: string): SessionManager {
		const sessionId = randomUUID();
		const sessionDir = join(cwd, ".genesis-local", "sessions");
		const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ cwd, sessionId })}\n`, "utf8");
		SessionManager.pruneSessionFiles(sessionDir, sessionFile);
		return new SessionManager(cwd, sessionId, sessionFile);
	}

	static open(sessionPath: string): SessionManager {
		const metadata = SessionManager.readMetadata(sessionPath);
		return new SessionManager(metadata.cwd ?? process.cwd(), metadata.sessionId ?? randomUUID(), sessionPath);
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	private static readMetadata(sessionPath: string): SessionMetadata {
		if (!existsSync(sessionPath)) {
			return {};
		}

		try {
			const firstLine = readFileSync(sessionPath, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0);
			if (!firstLine) {
				return {};
			}
			return JSON.parse(firstLine) as SessionMetadata;
		} catch {
			return {};
		}
	}

	private static pruneSessionFiles(sessionDir: string, newestSessionFile: string): void {
		const maxEntries = readSessionFileMaxEntries();
		try {
			const entries = readdirSync(sessionDir)
				.filter((entry) => entry.endsWith(".jsonl"))
				.map((entry) => {
					const filePath = join(sessionDir, entry);
					return {
						filePath,
						modifiedMs: statSync(filePath).mtimeMs,
					};
				})
				.sort((left, right) => right.modifiedMs - left.modifiedMs || left.filePath.localeCompare(right.filePath));
			const keep = new Set(entries.slice(0, maxEntries).map((entry) => entry.filePath));
			keep.add(newestSessionFile);
			for (const entry of entries) {
				if (keep.has(entry.filePath)) {
					continue;
				}
				rmSync(entry.filePath, { force: true });
			}
		} catch {
			// Best-effort retention: keep session creation resilient even if cleanup fails.
		}
	}
}

function readSessionFileMaxEntries(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[RECENT_SESSION_MAX_ENTRIES_ENV];
	if (typeof raw !== "string") {
		return DEFAULT_RECENT_SESSION_MAX_ENTRIES + SESSION_FILE_RETENTION_BUFFER;
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed + SESSION_FILE_RETENTION_BUFFER
		: DEFAULT_RECENT_SESSION_MAX_ENTRIES + SESSION_FILE_RETENTION_BUFFER;
}
