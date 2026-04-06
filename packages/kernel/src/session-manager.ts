import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

	static create(cwd: string, sessionStorageDir?: string): SessionManager {
		const sessionId = randomUUID();
		const sessionFile = sessionStorageDir ? join(sessionStorageDir, `${sessionId}.jsonl`) : undefined;
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
			return JSON.parse(readFileSync(sessionPath, "utf8")) as SessionMetadata;
		} catch {
			return {};
		}
	}
}
