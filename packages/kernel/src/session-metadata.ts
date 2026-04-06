import { readFile } from "node:fs/promises";

export interface GenesisTranscriptMessagePreview {
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface GenesisSessionMetadata {
	readonly summary?: string;
	readonly firstPrompt?: string;
	readonly messageCount: number;
	readonly fileSizeBytes: number;
	readonly recentMessages: readonly GenesisTranscriptMessagePreview[];
}

interface SessionJsonlEntry {
	readonly type?: unknown;
	readonly name?: unknown;
	readonly summary?: unknown;
	readonly message?: {
		readonly role?: unknown;
		readonly content?: unknown;
	};
}

export async function loadSessionMetadataFromSessionFile(
	sessionFile?: string,
): Promise<GenesisSessionMetadata | null> {
	if (!sessionFile) return null;
	try {
		const raw = await readFile(sessionFile, "utf8");
		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length === 0) {
			return null;
		}

		let latestSessionTitle: string | undefined;
		let latestCompactionSummary: string | undefined;
		let firstPrompt: string | undefined;
		let lastUserPrompt: string | undefined;
		const recentMessages: GenesisTranscriptMessagePreview[] = [];
		let messageCount = 0;

		for (const line of lines) {
			let entry: SessionJsonlEntry;
			try {
				entry = JSON.parse(line) as SessionJsonlEntry;
			} catch {
				continue;
			}

			if (entry.type === "session_info") {
				const nextTitle = sanitizeLine(entry.name);
				if (nextTitle) latestSessionTitle = nextTitle;
				continue;
			}

			if (entry.type === "compaction") {
				const nextSummary = sanitizeLine(entry.summary);
				if (nextSummary) latestCompactionSummary = nextSummary;
				continue;
			}

			if (entry.type !== "message") continue;
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractMessageText(entry.message?.content);
			if (!text) continue;

			messageCount += 1;
			if (role === "user") {
				if (!firstPrompt) firstPrompt = text;
				lastUserPrompt = text;
			}

			recentMessages.push({ role, text });
			if (recentMessages.length > 4) {
				recentMessages.shift();
			}
		}

		const summary = latestSessionTitle ?? lastUserPrompt ?? latestCompactionSummary ?? firstPrompt;
		if (!summary && recentMessages.length === 0) {
			return null;
		}

		return {
			summary,
			firstPrompt,
			messageCount,
			fileSizeBytes: Buffer.byteLength(raw, "utf8"),
			recentMessages,
		};
	} catch {
		return null;
	}
}

function extractMessageText(content: unknown): string | undefined {
	if (typeof content === "string") {
		return sanitizeLine(content);
	}
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const maybePart = part as { type?: unknown; text?: unknown };
			return maybePart.type === "text" && typeof maybePart.text === "string" ? maybePart.text : "";
		})
		.filter((part) => part.trim().length > 0)
		.join("\n");
	return sanitizeLine(text);
}

function sanitizeLine(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : undefined;
}
