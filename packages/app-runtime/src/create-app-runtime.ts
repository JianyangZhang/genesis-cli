/**
 * The single entry point for creating the product-layer runtime.
 *
 * `createAppRuntime()` initializes the runtime with configuration, model,
 * tool set, and adapter provisioning. All four CLI modes (interactive,
 * print, json, rpc) use the same factory and the same AppRuntime interface.
 */

import type { ToolDefinition } from "@pickle-pee/tools";
import type { KernelSessionAdapter } from "./adapters/kernel-session-adapter.js";
import type { EventBus } from "./events/event-bus.js";
import { createEventBus } from "./events/event-bus.js";
import type { RuntimeEvent } from "./events/runtime-event.js";
import type { ToolGovernor } from "./governance/tool-governor.js";
import { createToolGovernor } from "./governance/tool-governor.js";
import type { PlanEngine } from "./planning/plan-engine.js";
import { createPlanEngine } from "./planning/plan-engine.js";
import { createRuntimeContext } from "./runtime-context.js";
import {
	listRecentSessions,
	pruneRecentSessions,
	recordRecentSession,
	searchRecentSessions,
} from "./services/recent-session-catalog.js";
import { sessionCreated, sessionResumed } from "./session/session-events.js";
import type { SessionFacade } from "./session/session-facade.js";
import { SessionFacadeImpl } from "./session/session-facade.js";
import { createInitialSessionState, recoverSessionState } from "./session/session-state.js";
import type {
	CliMode,
	ModelDescriptor,
	RecentSessionEntry,
	RecentSessionSearchHit,
	SessionRecoveryData,
	SessionRecoveryMetadata,
	SessionTranscriptMessagePreview,
} from "./types/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AppRuntimeConfig {
	/** Working directory for the session. */
	readonly workingDirectory: string;

	/** Agent directory (models/auth/local agent state). */
	readonly agentDir?: string;

	/** Stable user-level history directory for resume catalogs. */
	readonly historyDir?: string;

	/** Optional config source map for explainability. */
	readonly configSources?: Readonly<Record<string, { layer: string; detail: string }>>;

	/** CLI mode — determines how input/output is handled by consumers. */
	readonly mode: CliMode;

	/** Model to use for this session. */
	readonly model: ModelDescriptor;

	/** Tool names to enable. Defaults to an empty set if omitted. */
	readonly toolSet?: readonly string[];

	/**
	 * Legacy single-session adapter override.
	 * Prefer `createAdapter` for runtimes that may host multiple sessions.
	 */
	readonly adapter?: KernelSessionAdapter;

	/** Factory for creating one fresh adapter per session. */
	readonly createAdapter?: (model: ModelDescriptor) => KernelSessionAdapter;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface AppRuntime {
	/** Create a new session. */
	createSession(): SessionFacade;

	/** Recover a previous session from serialized data. */
	recoverSession(data: SessionRecoveryData): SessionFacade;

	/** Global event bus — receives events from all sessions. */
	readonly events: EventBus;

	/** Tool governance — catalog, permissions, mutations, audit. */
	readonly governor: ToolGovernor;

	/** Plan engine — shared immutable state machine for plan management. */
	readonly planEngine: PlanEngine;

	/** Persist a closed session into the recent-session catalog. */
	recordRecentSession(recoveryData: SessionRecoveryData, options?: { readonly title?: string }): Promise<void>;

	/** Persist a closed session while merging runtime-owned live history. */
	recordClosedRecentSession(
		session: SessionFacade,
		recoveryData: SessionRecoveryData,
		options?: { readonly title?: string },
	): Promise<void>;

	/** Persist one user input turn into runtime-owned session history. */
	recordRecentSessionInput(
		session: SessionFacade,
		input: string,
		options?: { readonly title?: string },
	): Promise<void>;

	/** Persist one finalized assistant text block into runtime-owned session history. */
	recordRecentSessionAssistantText(
		session: SessionFacade,
		text: string,
		options?: { readonly title?: string },
	): Promise<void>;

	/** Persist event-derived session history updates owned by the runtime. */
	recordRecentSessionEvent(
		session: SessionFacade,
		event: RuntimeEvent,
		options?: { readonly title?: string },
	): Promise<void>;

	/** List recent recoverable sessions for resume flows. */
	listRecentSessions(): Promise<readonly RecentSessionEntry[]>;

	/** Search recent sessions by human-readable text, ordered by relevance. */
	searchRecentSessions(query: string): Promise<readonly RecentSessionSearchHit[]>;

	/** Compact the recent-session catalog to a bounded size. */
	pruneRecentSessions(
		maxEntries?: number,
	): Promise<{ readonly before: number; readonly after: number; readonly removed: number }>;

	/** The current default model for newly created sessions. */
	getDefaultModel(): ModelDescriptor;

	/** Update the default model for newly created sessions. */
	setDefaultModel(model: ModelDescriptor): void;

	/** Shut down the runtime and release resources. */
	shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppRuntime(config: AppRuntimeConfig): AppRuntime {
	const globalBus = createEventBus();
	const governor = createToolGovernor();
	const planEngine = createPlanEngine();
	const toolSet = new Set(config.toolSet ?? []);
	registerBuiltinToolDefinitions(governor, toolSet);
	const sessions = new Set<SessionFacade>();
	let shutdown = false;
	let staticAdapterClaimed = false;
	let defaultModel = config.model;
	let recentSessionWriteChain: Promise<void> = Promise.resolve();
	const liveRecentSessionMetadata = new Map<string, SessionRecoveryMetadata>();

	function assertNotShutdown(): void {
		if (shutdown) {
			throw new Error("Runtime has been shut down");
		}
	}

	function getAdapter(model: ModelDescriptor): KernelSessionAdapter {
		if (config.createAdapter) {
			return config.createAdapter(model);
		}

		if (config.adapter) {
			if (staticAdapterClaimed) {
				throw new Error(
					"AppRuntimeConfig.adapter can only back a single session. Use createAdapter() to provision a fresh adapter per session.",
				);
			}
			staticAdapterClaimed = true;
			return config.adapter;
		}

		throw new Error(
			"No KernelSessionAdapter provided. Pass adapter for a single session or createAdapter for multi-session runtimes.",
		);
	}

	function enqueueRecentSessionWrite(task: () => Promise<void>): Promise<void> {
		const run = recentSessionWriteChain.then(task, task);
		recentSessionWriteChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function getLiveRecentSessionMetadata(session: SessionFacade): SessionRecoveryMetadata {
		return (
			liveRecentSessionMetadata.get(session.id.value) ?? {
				messageCount: 0,
				fileSizeBytes: 0,
				recentMessages: [],
				resumeSummary: null,
			}
		);
	}

	function setLiveRecentSessionMetadata(session: SessionFacade, metadata: SessionRecoveryMetadata): void {
		liveRecentSessionMetadata.set(session.id.value, metadata);
	}

	function clearLiveRecentSessionMetadata(session: SessionFacade): void {
		liveRecentSessionMetadata.delete(session.id.value);
	}

	function withRecentSessionContext(session: SessionFacade, recoveryData: SessionRecoveryData): SessionRecoveryData {
		return {
			...recoveryData,
			workingDirectory: recoveryData.workingDirectory ?? session.context.workingDirectory,
			agentDir: recoveryData.agentDir ?? session.context.agentDir,
		};
	}

	return {
		get events(): EventBus {
			return globalBus;
		},

		get governor(): ToolGovernor {
			return governor;
		},

		get planEngine(): PlanEngine {
			return planEngine;
		},

		recordRecentSession(recoveryData: SessionRecoveryData, options?: { readonly title?: string }): Promise<void> {
			return enqueueRecentSessionWrite(() => recordRecentSession(config.historyDir, recoveryData, options));
		},

		recordClosedRecentSession(
			session: SessionFacade,
			recoveryData: SessionRecoveryData,
			options?: { readonly title?: string },
		): Promise<void> {
			return enqueueRecentSessionWrite(async () => {
				const merged = mergeRecoveryDataWithLiveMetadata(
					withRecentSessionContext(session, recoveryData),
					getLiveRecentSessionMetadata(session),
				);
				await recordRecentSession(config.historyDir, merged, {
					...options,
					authoritativeMetadata: true,
				});
				clearLiveRecentSessionMetadata(session);
			});
		},

		recordRecentSessionInput(
			session: SessionFacade,
			input: string,
			options?: { readonly title?: string },
		): Promise<void> {
			return enqueueRecentSessionWrite(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyRuntimeOwnedUserInput(getLiveRecentSessionMetadata(session), input);
				setLiveRecentSessionMetadata(session, metadata);
				if (shouldPersistLiveRecentSession(recoveryData)) {
					await recordRecentSession(
						config.historyDir,
						mergeRecoveryDataWithLiveMetadata(recoveryData, metadata),
						options,
					);
				}
			});
		},

		recordRecentSessionAssistantText(
			session: SessionFacade,
			text: string,
			options?: { readonly title?: string },
		): Promise<void> {
			return enqueueRecentSessionWrite(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyRuntimeOwnedAssistantText(getLiveRecentSessionMetadata(session), text);
				setLiveRecentSessionMetadata(session, metadata);
				if (shouldPersistLiveRecentSession(recoveryData)) {
					await recordRecentSession(
						config.historyDir,
						mergeRecoveryDataWithLiveMetadata(recoveryData, metadata),
						options,
					);
				}
			});
		},

		recordRecentSessionEvent(
			session: SessionFacade,
			event: RuntimeEvent,
			options?: { readonly title?: string },
		): Promise<void> {
			return enqueueRecentSessionWrite(async () => {
				const recoveryData = withRecentSessionContext(session, await session.snapshotRecoveryData());
				const metadata = applyRuntimeOwnedEvent(getLiveRecentSessionMetadata(session), event);
				setLiveRecentSessionMetadata(session, metadata);
				if (shouldPersistLiveRecentSession(recoveryData)) {
					await recordRecentSession(
						config.historyDir,
						mergeRecoveryDataWithLiveMetadata(recoveryData, metadata),
						options,
					);
				}
			});
		},

		listRecentSessions(): Promise<readonly RecentSessionEntry[]> {
			return listRecentSessions(config.historyDir);
		},

		searchRecentSessions(query: string): Promise<readonly RecentSessionSearchHit[]> {
			return searchRecentSessions(config.historyDir, query);
		},

		pruneRecentSessions(
			maxEntries?: number,
		): Promise<{ readonly before: number; readonly after: number; readonly removed: number }> {
			return pruneRecentSessions(config.historyDir, maxEntries);
		},

		getDefaultModel(): ModelDescriptor {
			return defaultModel;
		},

		setDefaultModel(model: ModelDescriptor): void {
			defaultModel = model;
		},

		createSession(): SessionFacade {
			assertNotShutdown();

			const model = defaultModel;
			const sessionId = { value: crypto.randomUUID() };
			const state = createInitialSessionState(sessionId, model, toolSet);
			const context = createRuntimeContext({
				sessionId,
				workingDirectory: config.workingDirectory,
				agentDir: config.agentDir,
				configSources: config.configSources,
				mode: config.mode,
				model,
				toolSet,
			});

			const facade = new SessionFacadeImpl(getAdapter(model), state, context, globalBus, governor, planEngine);

			// Emit session_created on the global bus
			const event = sessionCreated(sessionId, model, [...toolSet]);
			globalBus.emit(event);

			sessions.add(facade);
			return facade;
		},

		recoverSession(data: SessionRecoveryData): SessionFacade {
			assertNotShutdown();

			const state = recoverSessionState(data);
			const context = createRuntimeContext({
				sessionId: data.sessionId,
				workingDirectory: data.workingDirectory ?? config.workingDirectory,
				agentDir: data.agentDir ?? config.agentDir,
				configSources: config.configSources,
				mode: config.mode,
				model: data.model,
				toolSet: new Set(data.toolSet),
			});

			const adapter = getAdapter(data.model);

			// Tell the adapter about the recovery so it can restore its own state.
			adapter.resume(data);

			const facade = new SessionFacadeImpl(adapter, state, context, globalBus, governor, planEngine);

			// Emit session_resumed on the global bus
			const event = sessionResumed(data.sessionId, data);
			globalBus.emit(event);

			sessions.add(facade);
			return facade;
		},

		async shutdown(): Promise<void> {
			if (shutdown) return;
			shutdown = true;

			// Close all active sessions
			for (const session of sessions) {
				try {
					await session.close();
				} catch {
					// Best-effort close during shutdown
				}
			}
			sessions.clear();
			liveRecentSessionMetadata.clear();
			globalBus.removeAllListeners();
		},
	};
}

function shouldPersistLiveRecentSession(recoveryData: SessionRecoveryData): boolean {
	return recoveryData.sessionId.value !== "unknown-session";
}

function mergeRecoveryDataWithLiveMetadata(
	recoveryData: SessionRecoveryData,
	metadata: SessionRecoveryMetadata,
): SessionRecoveryData {
	return {
		...recoveryData,
		metadata: mergeRuntimeOwnedMetadata(recoveryData.metadata, metadata),
	};
}

function mergeRuntimeOwnedMetadata(
	existing: SessionRecoveryMetadata | null | undefined,
	live: SessionRecoveryMetadata,
): SessionRecoveryMetadata {
	// Kernel/session-file metadata is the authority. Runtime live metadata is fallback-only.
	const recentMessages = (existing?.recentMessages?.length ?? 0) > 0 ? existing!.recentMessages : live.recentMessages;
	return {
		firstPrompt: existing?.firstPrompt ?? live.firstPrompt,
		summary: existing?.summary ?? live.summary,
		messageCount: Math.max(existing?.messageCount ?? 0, live.messageCount, recentMessages.length),
		fileSizeBytes: Math.max(existing?.fileSizeBytes ?? 0, live.fileSizeBytes),
		recentMessages,
		resumeSummary:
			existing?.resumeSummary?.source === "model"
				? existing.resumeSummary
				: (live.resumeSummary ?? existing?.resumeSummary ?? null),
	};
}

function applyRuntimeOwnedUserInput(metadata: SessionRecoveryMetadata, input: string): SessionRecoveryMetadata {
	const text = normalizeRuntimeOwnedText(input);
	if (!text) {
		return metadata;
	}
	const recentMessages = trimRuntimeOwnedMessages([...metadata.recentMessages, { role: "user", text }]);
	return {
		...metadata,
		firstPrompt: metadata.firstPrompt ?? text,
		messageCount: Math.max(metadata.messageCount, recentMessages.length),
		recentMessages,
		resumeSummary: null,
	};
}

function applyRuntimeOwnedAssistantText(metadata: SessionRecoveryMetadata, text: string): SessionRecoveryMetadata {
	const normalized = normalizeRuntimeOwnedText(text);
	if (!normalized) {
		return metadata;
	}
	const recentMessages = appendRuntimeOwnedAssistantMessage(metadata.recentMessages, normalized);
	return {
		...metadata,
		summary: metadata.summary ?? normalized,
		messageCount: Math.max(metadata.messageCount, recentMessages.length),
		recentMessages,
		resumeSummary: null,
	};
}

function applyRuntimeOwnedEvent(metadata: SessionRecoveryMetadata, event: RuntimeEvent): SessionRecoveryMetadata {
	if (event.category !== "compaction" || event.type !== "compaction_completed") {
		return metadata;
	}
	const compactedSummary = normalizeRuntimeOwnedText(event.summary.compactedSummary);
	if (!compactedSummary) {
		return metadata;
	}
	return {
		...metadata,
		summary: metadata.summary ?? compactedSummary,
		resumeSummary: null,
	};
}

function appendRuntimeOwnedAssistantMessage(
	existing: readonly SessionTranscriptMessagePreview[],
	text: string,
): readonly SessionTranscriptMessagePreview[] {
	const recentMessages = [...existing];
	const last = recentMessages.at(-1);
	if (last && last.role === "assistant") {
		recentMessages[recentMessages.length - 1] = { role: "assistant", text: `${last.text}${text}` };
		return trimRuntimeOwnedMessages(recentMessages);
	}
	return trimRuntimeOwnedMessages([...recentMessages, { role: "assistant", text }]);
}

function trimRuntimeOwnedMessages(
	messages: readonly SessionTranscriptMessagePreview[],
): readonly SessionTranscriptMessagePreview[] {
	return messages.slice(-6);
}

function normalizeRuntimeOwnedText(value: string | null | undefined): string | undefined {
	const normalized = value?.replace(/\s+/g, " ").trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function registerBuiltinToolDefinitions(governor: ToolGovernor, toolSet: ReadonlySet<string>): void {
	for (const toolName of toolSet) {
		const definition = builtinToolDefinition(toolName);
		if (definition && !governor.catalog.has(toolName)) {
			governor.catalog.register(definition);
		}
	}
}

function builtinToolDefinition(toolName: string): ToolDefinition | null {
	switch (toolName) {
		case "read":
			return makeBuiltinToolDefinition("read", "file-read", "L0", true, "never", "unlimited", 30_000);
		case "grep":
		case "find":
		case "ls":
			return makeBuiltinToolDefinition(toolName, "file-read", "L0", true, "never", "unlimited", 30_000);
		case "write":
			return makeBuiltinToolDefinition("write", "file-mutation", "L1", false, "always", "per_target", 30_000);
		case "edit":
			return makeBuiltinToolDefinition("edit", "file-mutation", "L2", false, "on_write", "per_target", 30_000);
		case "bash":
			return makeBuiltinToolDefinition("bash", "command-execution", "L3", false, "always", "unlimited", 120_000);
		default:
			return null;
	}
}

function makeBuiltinToolDefinition(
	name: string,
	category: string,
	riskLevel: "L0" | "L1" | "L2" | "L3" | "L4",
	readOnly: boolean,
	confirmation: "never" | "always" | "on_write",
	concurrency: "unlimited" | "serial" | "per_target",
	timeoutMs: number,
): ToolDefinition {
	return {
		identity: { name, category },
		contract: {
			parameterSchema: { type: "object", properties: {} },
			output: { type: "text" },
			errorTypes: [],
		},
		policy: {
			riskLevel,
			readOnly,
			concurrency,
			confirmation,
			subAgentAllowed: true,
			timeoutMs,
		},
		executorTag: name,
	};
}
