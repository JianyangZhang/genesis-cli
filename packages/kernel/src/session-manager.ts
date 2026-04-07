import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
		const sessionFile = join(cwd, ".genesis-local", "sessions", `${sessionId}.jsonl`);
		mkdirSync(dirname(sessionFile), { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ cwd, sessionId })}\n`, "utf8");
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
}
