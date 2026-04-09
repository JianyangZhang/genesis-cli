export interface InteractiveConversationState {
	clear(): void;
	rememberTranscriptBlock(text: string, newline: boolean): void;
	rememberAssistantTranscriptBlock(block: string): void;
	mergeAssistantDelta(delta: string): void;
	consumeAssistantBuffer(): string;
	hasAssistantBuffer(): boolean;
	getTranscriptBlocks(): readonly string[];
	renderedTranscriptBlocks(welcomeBlocks: readonly string[]): readonly string[];
	getLatestTranscriptBlock(): string | null;
}

export function createInteractiveConversationState(): InteractiveConversationState {
	let transcriptBlocks: readonly string[] = [];
	let assistantBuffer = "";

	return {
		clear(): void {
			transcriptBlocks = [];
			assistantBuffer = "";
		},
		rememberTranscriptBlock(text: string, newline: boolean): void {
			const block = newline ? text : text.replace(/\n$/, "");
			if (block.length === 0) {
				return;
			}
			transcriptBlocks = appendTranscriptBlockWithSpacer(transcriptBlocks, block);
		},
		rememberAssistantTranscriptBlock(block: string): void {
			transcriptBlocks = appendAssistantTranscriptBlock(transcriptBlocks, block);
		},
		mergeAssistantDelta(delta: string): void {
			assistantBuffer = mergeStreamingText(assistantBuffer, delta);
		},
		consumeAssistantBuffer(): string {
			const snapshot = assistantBuffer;
			assistantBuffer = "";
			return snapshot;
		},
		hasAssistantBuffer(): boolean {
			return assistantBuffer.length > 0;
		},
		getTranscriptBlocks(): readonly string[] {
			return transcriptBlocks;
		},
		renderedTranscriptBlocks(welcomeBlocks: readonly string[]): readonly string[] {
			if (assistantBuffer.length === 0) {
				return [...welcomeBlocks, ...transcriptBlocks];
			}
			const assistantBlock = materializeAssistantTranscriptBlock(assistantBuffer);
			if (assistantBlock === null) {
				return [...welcomeBlocks, ...transcriptBlocks];
			}
			return appendAssistantTranscriptBlock([...welcomeBlocks, ...transcriptBlocks], assistantBlock);
		},
		getLatestTranscriptBlock(): string | null {
			const lastNonEmptyIndex = findLastNonEmptyBlockIndex(transcriptBlocks);
			if (lastNonEmptyIndex < 0) {
				return null;
			}
			return transcriptBlocks[lastNonEmptyIndex] ?? null;
		},
	};
}

export function mergeStreamingText(existing: string, incoming: string): string {
	if (existing.length === 0) {
		return incoming;
	}
	if (incoming.length === 0) {
		return existing;
	}
	if (incoming.startsWith(existing)) {
		return incoming;
	}
	if (existing.endsWith(incoming)) {
		return existing;
	}
	const trimmedIncoming = incoming.trimStart();
	// Some providers occasionally resend the whole sentence with accidental leading whitespace.
	// Only trim in that snapshot-style case; otherwise preserve real token spaces.
	if (trimmedIncoming.startsWith(existing)) {
		return trimmedIncoming;
	}
	const maxOverlap = Math.min(existing.length, incoming.length);
	for (let size = maxOverlap; size > 0; size -= 1) {
		if (existing.endsWith(incoming.slice(0, size))) {
			return `${existing}${incoming.slice(size)}`;
		}
	}
	return `${existing}${incoming}`;
}

export function materializeAssistantTranscriptBlock(buffer: string): string | null {
	const trimmed = buffer.trim();
	if (trimmed.length === 0) {
		return null;
	}
	return `⏺ ${trimmed}`;
}

export function appendAssistantTranscriptBlock(blocks: readonly string[], assistantBlock: string): readonly string[] {
	return appendTranscriptBlockWithSpacer(blocks, assistantBlock);
}

export function appendTranscriptBlockWithSpacer(blocks: readonly string[], block: string): readonly string[] {
	if (blocks.length === 0) {
		return [block];
	}
	const last = blocks[blocks.length - 1] ?? "";
	if (last.length === 0) {
		return [...blocks, block];
	}
	return [...blocks, "", block];
}

function findLastNonEmptyBlockIndex(blocks: readonly string[]): number {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		if ((blocks[index] ?? "").trim().length > 0) {
			return index;
		}
	}
	return -1;
}
