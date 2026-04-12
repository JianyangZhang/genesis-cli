import { readFile } from "node:fs/promises";
import type { RecentSessionEntry, RecentSessionSearchHit } from "@pickle-pee/runtime";
import { buildRestoredContextLines } from "@pickle-pee/ui";

type ResumeSource = RecentSessionEntry | RecentSessionSearchHit;

export async function buildResumedContextLines(source: ResumeSource): Promise<readonly string[]> {
	const entry = "entry" in source ? source.entry : source;
	const parsed = await parseSessionTranscriptMessages(entry.recoveryData.sessionFile);
	if (parsed.length === 0) {
		return buildRestoredContextLines(source);
	}
	const lines = ["Restored context:"];
	for (const message of parsed) {
		const label = message.role === "user" ? "User" : "Assistant";
		lines.push(`  ${label}: ${message.text}`);
	}
	return lines;
}

async function parseSessionTranscriptMessages(
	sessionFile: string | undefined,
): Promise<ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>> {
	if (typeof sessionFile !== "string" || sessionFile.length === 0) {
		return [];
	}
	let raw: string;
	try {
		raw = await readFile(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!payload || typeof payload !== "object") {
			continue;
		}
		const entry = payload as { type?: unknown; message?: unknown };
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (!message) {
			continue;
		}
		const role = message.role === "user" || message.role === "assistant" ? message.role : null;
		if (!role) {
			continue;
		}
		const text = normalizeResumeMessageText(message.content);
		if (text.length === 0) {
			continue;
		}
		messages.push({ role, text });
	}
	return messages;
}

function normalizeResumeMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!part || typeof part !== "object") {
					return "";
				}
				const candidate = part as { text?: unknown };
				return typeof candidate.text === "string" ? candidate.text : "";
			})
			.join("")
			.trim();
	}
	if (content && typeof content === "object") {
		const candidate = content as { text?: unknown };
		if (typeof candidate.text === "string") {
			return candidate.text.trim();
		}
	}
	return "";
}
