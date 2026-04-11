import type { RuntimeEvent } from "../events/runtime-event.js";
import type { SessionFacade } from "../session/session-facade.js";
import type {
	RecentSessionEntry,
	RecentSessionSearchHit,
	SessionRecoveryData,
	SessionRecoveryMetadata,
	SessionTranscriptMessagePreview,
} from "../types/index.js";
import {
	listRecentSessions,
	pruneRecentSessions,
	recordRecentSession,
	searchRecentSessions,
} from "./recent-session-catalog.js";

export interface RecentSessionAuthority {
	recordSession(recoveryData: SessionRecoveryData, options?: { readonly title?: string }): Promise<void>;
	recordClosedSession(
		session: SessionFacade,
		recoveryData: SessionRecoveryData,
		options?: { readonly title?: string },
	): Promise<void>;
	recordInput(session: SessionFacade, input: string, options?: { readonly title?: string }): Promise<void>;
	recordAssistantText(session: SessionFacade, text: string, options?: { readonly title?: string }): Promise<void>;
	recordEvent(session: SessionFacade, event: RuntimeEvent, options?: { readonly title?: string }): Promise<void>;
	listSessions(): Promise<readonly RecentSessionEntry[]>;
	searchSessions(query: string): Promise<readonly RecentSessionSearchHit[]>;
	pruneSessions(maxEntries?: number): Promise<{ readonly before: number; readonly after: number; readonly removed: number }>;
	clearSessionOverlay(session: SessionFacade): void;
	dispose(): void;
}

export function createRecentSessionAuthority(historyDir: string | undefined): RecentSessionAuthority {
	let writeChain: Promise<void> = Promise.resolve();
	const overlays = new Map<string, SessionRecoveryMetadata>();

	function enqueue(task: () => Promise<void>): Promise<void> {
		const run = writeChain.then(task, task);
		writeChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function getOverlay(session: SessionFacade): SessionRecoveryMetadata {
		return (
			overlays.get(session.id.value) ?? {
				messageCount: 0,
				fileSizeBytes: 0,
				recentMessages: [],
				resumeSummary: null,
			}
		);
	}

	function setOverlay(session: SessionFacade, metadata: SessionRecoveryMetadata): void {
		overlays.set(session.id.value, metadata);
	}

	function clearOverlay(session: SessionFacade): void {
		overlays.delete(session.id.value);
	}

	return {
		recordSession(recoveryData, options): Promise<void> {
			return enqueue(() => recordRecentSession(historyDir, recoveryData, options));
		},

		recordClosedSession(session, recoveryData, options): Promise<void> {
			return enqueue(async () => {
				const merged = mergeRecoveryDataWithOverlay(withRecentSessionContext(session, recoveryData), getOverlay(session));
				await recordRecentSession(historyDir, merged, {
					...options,
					authoritativeMetadata: true,
				});
				clearOverlay(session);
			});
		},

		recordInput(session, input, options): Promise<void> {
			return enqueue(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyOverlayUserInput(getOverlay(session), input);
				setOverlay(session, metadata);
				if (shouldPersistOverlayProjection(recoveryData)) {
					await recordRecentSession(historyDir, mergeRecoveryDataWithOverlay(recoveryData, metadata), options);
				}
			});
		},

		recordAssistantText(session, text, options): Promise<void> {
			return enqueue(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyOverlayAssistantText(getOverlay(session), text);
				setOverlay(session, metadata);
				if (shouldPersistOverlayProjection(recoveryData)) {
					await recordRecentSession(historyDir, mergeRecoveryDataWithOverlay(recoveryData, metadata), options);
				}
			});
		},

		recordEvent(session, event, options): Promise<void> {
			return enqueue(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyOverlayRuntimeEvent(getOverlay(session), event);
				setOverlay(session, metadata);
				if (shouldPersistOverlayProjection(recoveryData)) {
					await recordRecentSession(historyDir, mergeRecoveryDataWithOverlay(recoveryData, metadata), options);
				}
			});
		},

		listSessions(): Promise<readonly RecentSessionEntry[]> {
			return listRecentSessions(historyDir);
		},

		searchSessions(query: string): Promise<readonly RecentSessionSearchHit[]> {
			return searchRecentSessions(historyDir, query);
		},

		pruneSessions(maxEntries?: number): Promise<{ readonly before: number; readonly after: number; readonly removed: number }> {
			return pruneRecentSessions(historyDir, maxEntries);
		},

		clearSessionOverlay(session: SessionFacade): void {
			clearOverlay(session);
		},

		dispose(): void {
			overlays.clear();
		},
	};
}

function withRecentSessionContext(session: SessionFacade, recoveryData: SessionRecoveryData): SessionRecoveryData {
	return {
		...recoveryData,
		workingDirectory: recoveryData.workingDirectory ?? session.context.workingDirectory,
		agentDir: recoveryData.agentDir ?? session.context.agentDir,
	};
}

function shouldPersistOverlayProjection(recoveryData: SessionRecoveryData): boolean {
	return recoveryData.sessionId.value !== "unknown-session";
}

function mergeRecoveryDataWithOverlay(
	recoveryData: SessionRecoveryData,
	overlay: SessionRecoveryMetadata,
): SessionRecoveryData {
	return {
		...recoveryData,
		metadata: mergeAuthorityMetadata(recoveryData.metadata, overlay),
	};
}

function mergeAuthorityMetadata(
	authoritative: SessionRecoveryMetadata | null | undefined,
	overlay: SessionRecoveryMetadata,
): SessionRecoveryMetadata {
	const recentMessages =
		(authoritative?.recentMessages?.length ?? 0) > 0 ? authoritative!.recentMessages : overlay.recentMessages;
	return {
		firstPrompt: authoritative?.firstPrompt ?? overlay.firstPrompt,
		summary: authoritative?.summary ?? overlay.summary,
		messageCount: Math.max(authoritative?.messageCount ?? 0, overlay.messageCount, recentMessages.length),
		fileSizeBytes: Math.max(authoritative?.fileSizeBytes ?? 0, overlay.fileSizeBytes),
		recentMessages,
		resumeSummary:
			authoritative?.resumeSummary?.source === "model"
				? authoritative.resumeSummary
				: (overlay.resumeSummary ?? authoritative?.resumeSummary ?? null),
	};
}

function applyOverlayUserInput(metadata: SessionRecoveryMetadata, input: string): SessionRecoveryMetadata {
	const text = normalizeOverlayText(input);
	if (!text) {
		return metadata;
	}
	const recentMessages = trimOverlayMessages([...metadata.recentMessages, { role: "user", text }]);
	return {
		...metadata,
		firstPrompt: metadata.firstPrompt ?? text,
		messageCount: Math.max(metadata.messageCount, recentMessages.length),
		recentMessages,
		resumeSummary: null,
	};
}

function applyOverlayAssistantText(metadata: SessionRecoveryMetadata, text: string): SessionRecoveryMetadata {
	const normalized = normalizeOverlayText(text);
	if (!normalized) {
		return metadata;
	}
	const recentMessages = appendOverlayAssistantMessage(metadata.recentMessages, normalized);
	return {
		...metadata,
		summary: metadata.summary ?? normalized,
		messageCount: Math.max(metadata.messageCount, recentMessages.length),
		recentMessages,
		resumeSummary: null,
	};
}

function applyOverlayRuntimeEvent(metadata: SessionRecoveryMetadata, event: RuntimeEvent): SessionRecoveryMetadata {
	if (event.category !== "compaction" || event.type !== "compaction_completed") {
		return metadata;
	}
	const compactedSummary = normalizeOverlayText(event.summary.compactedSummary);
	if (!compactedSummary) {
		return metadata;
	}
	return {
		...metadata,
		summary: metadata.summary ?? compactedSummary,
		resumeSummary: null,
	};
}

function appendOverlayAssistantMessage(
	existing: readonly SessionTranscriptMessagePreview[],
	text: string,
): readonly SessionTranscriptMessagePreview[] {
	const recentMessages = [...existing];
	const last = recentMessages.at(-1);
	if (last && last.role === "assistant") {
		recentMessages[recentMessages.length - 1] = { role: "assistant", text: `${last.text}${text}` };
		return trimOverlayMessages(recentMessages);
	}
	return trimOverlayMessages([...recentMessages, { role: "assistant", text }]);
}

function trimOverlayMessages(messages: readonly SessionTranscriptMessagePreview[]): readonly SessionTranscriptMessagePreview[] {
	return messages.slice(-6);
}

function normalizeOverlayText(value: string | null | undefined): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}
