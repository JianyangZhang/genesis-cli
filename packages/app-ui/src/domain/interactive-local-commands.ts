import type { SessionFacade } from "@pickle-pee/runtime";
import type { SlashCommand, SlashCommandContext } from "../types/index.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";

export interface InteractiveToolUsageEntry {
	readonly status: string;
	readonly toolName: string;
	readonly riskLevel: string;
	readonly targetPath?: string;
	readonly durationMs: number;
}

export interface InteractiveToolUsageSummary {
	readonly total: number;
	readonly success: number;
	readonly failure: number;
	readonly denied: number;
	readonly recent: readonly InteractiveToolUsageEntry[];
}

export interface InteractiveConfigSnapshot {
	readonly sources: readonly {
		readonly key: string;
		readonly layer: string;
		readonly detail: string;
	}[];
	readonly agentDir: string;
	readonly modelsPath: string;
	readonly providerKey?: string;
	readonly provider?: {
		readonly api?: string | null;
		readonly baseUrl?: string | null;
		readonly apiKeyEnv: string;
		readonly apiKeyPresent: boolean;
	};
	readonly activeModel?: {
		readonly name: string;
		readonly id: string;
		readonly reasoning: boolean;
	} | null;
	readonly error?: string | null;
	readonly modelError?: string | null;
}

export interface InteractiveGitWorkingTreeSnapshot {
	readonly available: boolean;
	readonly statusLines: readonly string[];
	readonly diffStatLines: readonly string[];
}

export type InteractiveGitDiffSnapshot =
	| {
			readonly type: "ok";
			readonly stdout: string;
	  }
	| {
			readonly type: "error";
	  };

export interface InteractiveDoctorSnapshot {
	readonly providerKey: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly apiKeyEnv: string;
	readonly apiKeyPresent: boolean;
	readonly httpStatus?: number;
	readonly responseText?: string | null;
	readonly errorText?: string | null;
}

export interface InteractiveLocalCommandDeps {
	readonly registry: SlashCommandRegistry;
	readonly getCurrentSession: () => SessionFacade;
	readonly getSessionTitle: () => string | undefined;
	readonly setSessionTitle: (title: string) => void;
	readonly requestExit: () => void;
	readonly isInteractionBusy: () => boolean;
	readonly hasPendingPermissionRequest: () => boolean;
	readonly replaceSession: (session: SessionFacade) => void;
	readonly getAgentDir: () => string;
	readonly getInteractionPhase: () => string;
	readonly getLastError: () => string | null;
	readonly getChangedFileCount: () => number;
	readonly getPendingPermissionCallId: () => string | null;
	readonly getToolUsageSummary: () => InteractiveToolUsageSummary;
	readonly getConfigSnapshot: (ctx: SlashCommandContext) => Promise<InteractiveConfigSnapshot>;
	readonly getWorkingTreeSummary: () => Promise<{
		readonly changedPaths: readonly string[];
		readonly snapshot: InteractiveGitWorkingTreeSnapshot;
	}>;
	readonly getGitDiff: (target: string | null) => Promise<InteractiveGitDiffSnapshot>;
	readonly getDoctorSnapshot: (ctx: SlashCommandContext) => Promise<InteractiveDoctorSnapshot | null>;
}

export function createInteractiveLocalCommands(deps: InteractiveLocalCommandDeps): SlashCommand[] {
	return [
		createTitleCommand(deps),
		createHelpCommand(deps.registry),
		createStatusCommand(deps),
		createUsageCommand(deps),
		createConfigCommand(deps),
		createChangesCommand(deps),
		createReviewCommand(deps),
		createDiffCommand(deps),
		createDoctorCommand(deps),
		createExitCommand("exit", "Exit the interactive session", deps),
		createExitCommand("quit", "Exit the interactive session (alias of /exit)", deps),
		createClearCommand(deps),
	];
}

function createTitleCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "title",
		description: "Set the current session title",
		type: "local",
		visibility: "internal",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const next = ctx.args.trim();
			if (next.length === 0) {
				ctx.output.writeError("Usage: /title <text>");
				return undefined;
			}
			deps.setSessionTitle(next);
			ctx.output.writeLine(`Title: ${next}`);
			return undefined;
		},
	};
}

function createHelpCommand(registry: SlashCommandRegistry): SlashCommand {
	return {
		name: "help",
		description: "Show available commands",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const query = ctx.args.trim().replace(/^\/+/, "");
			const all = registry.listPublic().slice();

			if (query.length > 0) {
				const cmd = all.find((command) => command.name === query) ?? null;
				if (!cmd) {
					ctx.output.writeError(`Unknown command: /${query}`);
					ctx.output.writeLine("Type /help to see all commands.");
					return undefined;
				}
				ctx.output.writeLine(`/${cmd.name}`);
				ctx.output.writeLine(`  ${cmd.description}`);
				ctx.output.writeLine(`  Type: ${cmd.type}`);
				return undefined;
			}

			ctx.output.writeLine("Commands:");
			renderHelpGroup(ctx, "Local", registry.listByType("local", "public"));
			renderHelpGroup(ctx, "Prompt", registry.listByType("prompt", "public"));
			renderHelpGroup(ctx, "UI", registry.listByType("ui", "public"));

			ctx.output.writeLine("\nTips:");
			ctx.output.writeLine("  /help <name>  Show details for a command");
			ctx.output.writeLine("  Ctrl+C        Abort the current turn (or exit if idle)");
			return undefined;
		},
	};
}

function createExitCommand(
	name: "exit" | "quit",
	description: string,
	deps: InteractiveLocalCommandDeps,
): SlashCommand {
	return {
		name,
		description,
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			deps.requestExit();
			ctx.output.writeLine("Bye.");
			return undefined;
		},
	};
}

function createStatusCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "status",
		description: "Show status",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const state = ctx.session.state;
			const changedFileCount = deps.getChangedFileCount();
			const pendingPermissionCallId = deps.getPendingPermissionCallId();
			const lastError = deps.getLastError();

			ctx.output.writeLine(`Session: ${state.id.value}`);
			ctx.output.writeLine(`  CWD: ${ctx.session.context.workingDirectory}`);
			ctx.output.writeLine(`  Agent dir: ${deps.getAgentDir()}`);
			ctx.output.writeLine(`  Model: ${state.model.displayName ?? state.model.id}`);
			ctx.output.writeLine(`  Provider: ${state.model.provider}`);
			ctx.output.writeLine(`  Phase: ${deps.getInteractionPhase()}`);
			ctx.output.writeLine(
				`  Task: ${state.taskState.status}${state.taskState.currentTaskId ? ` (${state.taskState.currentTaskId})` : ""}`,
			);
			ctx.output.writeLine(`  Tools: ${[...state.toolSet].join(", ") || "(none)"}`);
			if (state.planSummary) {
				ctx.output.writeLine(`  Plan: ${state.planSummary.completedSteps}/${state.planSummary.stepCount}`);
			}
			if (state.compactionSummary) {
				ctx.output.writeLine(`  Last compaction: ${state.compactionSummary.estimatedTokensSaved} tokens saved`);
			}
			if (lastError) {
				ctx.output.writeLine(`  Last error: ${lastError}`);
			}
			if (changedFileCount > 0) {
				ctx.output.writeLine(`  Changed files: ${changedFileCount}`);
			}
			if (pendingPermissionCallId) {
				ctx.output.writeLine(`  Waiting permission: ${pendingPermissionCallId}`);
			}

			ctx.output.writeLine("Next:");
			if (pendingPermissionCallId) {
				ctx.output.writeLine("  Reply y (once), Y (session), n (deny), or Ctrl+C to deny");
			} else if (deps.isInteractionBusy()) {
				ctx.output.writeLine("  Wait for the active turn, or Ctrl+C to abort");
			} else if (changedFileCount > 0) {
				ctx.output.writeLine("  /review to inspect changes, or /diff <file>");
			} else if (lastError) {
				ctx.output.writeLine("  /doctor to diagnose, or /help for commands");
			} else {
				ctx.output.writeLine("  Type a prompt, or /help for commands");
			}
			return undefined;
		},
	};
}

function createUsageCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "usage",
		description: "Show tool usage and governance summary",
		type: "local",
		visibility: "internal",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const summary = deps.getToolUsageSummary();
			ctx.output.writeLine(
				`Tools: ${summary.total} total — ${summary.success} success, ${summary.failure} failure, ${summary.denied} denied`,
			);
			if (summary.recent.length > 0) {
				ctx.output.writeLine("Recent:");
				for (const entry of summary.recent) {
					const path = entry.targetPath ? ` ${entry.targetPath}` : "";
					ctx.output.writeLine(
						`  ${entry.status} ${entry.toolName} (${entry.riskLevel})${path} ${entry.durationMs}ms`,
					);
				}
			}
			return undefined;
		},
	};
}

function createConfigCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "config",
		description: "Show effective config",
		type: "local",
		visibility: "internal",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const snapshot = await deps.getConfigSnapshot(ctx);
			ctx.output.writeLine("Precedence: default < agent < project < env < cli");
			if (snapshot.sources.length > 0) {
				ctx.output.writeLine("Sources:");
				for (const source of snapshot.sources) {
					ctx.output.writeLine(`  ${source.key}: ${source.layer} (${source.detail})`);
				}
			}

			ctx.output.writeLine(`agentDir: ${snapshot.agentDir}`);
			ctx.output.writeLine(`models.json: ${snapshot.modelsPath}`);
			if (snapshot.error) {
				ctx.output.writeError(snapshot.error);
				return undefined;
			}

			if (!snapshot.providerKey || !snapshot.provider) {
				ctx.output.writeError(`Provider not configured: ${ctx.session.state.model.provider}`);
				return undefined;
			}

			ctx.output.writeLine(`provider: ${snapshot.providerKey}`);
			ctx.output.writeLine(`  api: ${snapshot.provider.api ?? "(missing)"}`);
			ctx.output.writeLine(`  baseUrl: ${snapshot.provider.baseUrl ?? "(missing)"}`);
			ctx.output.writeLine(
				`  apiKey env: ${snapshot.provider.apiKeyEnv} (${snapshot.provider.apiKeyPresent ? "set" : "missing"})`,
			);

			if (snapshot.activeModel) {
				ctx.output.writeLine(`model: ${snapshot.activeModel.name}`);
				ctx.output.writeLine(`  id: ${snapshot.activeModel.id}`);
				ctx.output.writeLine(`  reasoning: ${snapshot.activeModel.reasoning}`);
				return undefined;
			}

			ctx.output.writeError(snapshot.modelError ?? `Model not configured: ${ctx.session.state.model.id}`);
			return undefined;
		},
	};
}

function createChangesCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "changes",
		description: "Show changed files and diff summary",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const summary = await deps.getWorkingTreeSummary();
			renderWorkingTreeSummary(ctx.output, summary.changedPaths, summary.snapshot);
			if (summary.snapshot.available === false) {
				ctx.output.writeError("git not available in this working directory.");
				return undefined;
			}
			ctx.output.writeLine("Next: /review to inspect, or /diff [file] to see patches.");
			return undefined;
		},
	};
}

function createReviewCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "review",
		description: "Review changes and decide next steps",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const summary = await deps.getWorkingTreeSummary();
			if (summary.snapshot.available && summary.snapshot.statusLines.length === 0 && summary.changedPaths.length === 0) {
				ctx.output.writeLine("Review: clean working tree.");
				ctx.output.writeLine("Next: continue chatting, or /changes if you want a snapshot.");
				return undefined;
			}
			renderWorkingTreeSummary(ctx.output, summary.changedPaths, summary.snapshot);
			if (summary.snapshot.available === false) {
				ctx.output.writeError("git not available in this working directory.");
				ctx.output.writeLine("Next: continue chatting, or inspect tool-observed changes manually.");
				return undefined;
			}
			ctx.output.writeLine("Review tips:");
			ctx.output.writeLine("  /diff <file>   Inspect a specific patch");
			ctx.output.writeLine("  Use git manually if you want to discard changes");
			ctx.output.writeLine("Next: inspect diffs, then continue chatting.");
			return undefined;
		},
	};
}

function createDiffCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "diff",
		description: "Show git diff (optionally for a file)",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const target = ctx.args.trim();
			ctx.output.writeLine(target.length === 0 ? "Diff:" : `Diff: ${target}`);
			const diff = await deps.getGitDiff(target.length > 0 ? target : null);
			if (diff.type === "error") {
				ctx.output.writeError("git not available in this working directory.");
				return undefined;
			}
			ctx.output.writeLine(diff.stdout.trimEnd().length > 0 ? diff.stdout.trimEnd() : "(no diff)");
			ctx.output.writeLine("Next: /review to see a summary, or keep iterating.");
			return undefined;
		},
	};
}

function createDoctorCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "doctor",
		description: "Diagnose OpenAI-compatible mainline",
		type: "local",
		visibility: "internal",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			const snapshot = await deps.getDoctorSnapshot(ctx);
			if (!snapshot) {
				ctx.output.writeError("models.json not found.");
				return undefined;
			}
			ctx.output.writeLine(`provider: ${snapshot.providerKey}`);
			ctx.output.writeLine(`  api: ${snapshot.api || "(missing)"}`);
			ctx.output.writeLine(`  baseUrl: ${snapshot.baseUrl || "(missing)"}`);
			ctx.output.writeLine(`  apiKey env: ${snapshot.apiKeyEnv} (${snapshot.apiKeyPresent ? "set" : "missing"})`);
			if (!snapshot.apiKeyPresent || !snapshot.baseUrl || snapshot.api !== "openai-completions") {
				return undefined;
			}
			if (typeof snapshot.httpStatus === "number") {
				ctx.output.writeLine(`  http: ${snapshot.httpStatus}`);
			}
			if (snapshot.errorText) {
				ctx.output.writeError(snapshot.errorText);
				return undefined;
			}
			if (snapshot.responseText) {
				ctx.output.writeLine(`  response: ${snapshot.responseText}`);
			}
			return undefined;
		},
	};
}

function createClearCommand(deps: InteractiveLocalCommandDeps): SlashCommand {
	return {
		name: "clear",
		description: "Clear the transcript",
		type: "local",
		visibility: "public",
		async execute(ctx: SlashCommandContext): Promise<undefined> {
			await Promise.resolve();
			if (deps.isInteractionBusy() || deps.hasPendingPermissionRequest()) {
				ctx.output.writeError("Session is busy.");
				return undefined;
			}

			const currentSession = deps.getCurrentSession();
			const previousSessionId = currentSession.state.id.value;
			const previousTitleSuffix = deps.getSessionTitle() ? ` — ${deps.getSessionTitle()}` : "";
			await currentSession.close();

			const next = ctx.runtime.createSession();
			deps.replaceSession(next);
			ctx.output.writeLine(`Started a new session: ${next.state.id.value}`);
			ctx.output.writeLine(`Previous session saved: ${previousSessionId}${previousTitleSuffix}`);
			ctx.output.writeLine("Next: type a prompt, or /resume <sessionId|#N|title> to return.");
			return undefined;
		},
	};
}

export function renderWorkingTreeSummary(
	output: SlashCommandContext["output"],
	changedPaths: readonly string[],
	snapshot: InteractiveGitWorkingTreeSnapshot,
): void {
	output.writeLine("Working tree:");
	if (changedPaths.length > 0) {
		output.writeLine("Changed files (observed by tools):");
		for (const path of [...changedPaths].sort((a, b) => a.localeCompare(b))) {
			output.writeLine(`  ${path}`);
		}
	} else {
		output.writeLine("Changed files (observed by tools): none");
	}
	if (!snapshot.available) {
		return;
	}
	output.writeLine("git status --porcelain:");
	output.writeLine(snapshot.statusLines.length > 0 ? `  ${snapshot.statusLines.join("\n  ")}` : "  clean");
	if (snapshot.diffStatLines.length > 0) {
		output.writeLine("git diff --stat:");
		output.writeLine(`  ${snapshot.diffStatLines.join("\n  ")}`);
	}
}

function renderHelpGroup(ctx: SlashCommandContext, label: string, commands: readonly SlashCommand[]): void {
	const sorted = commands.slice().sort((a, b) => a.name.localeCompare(b.name));
	if (sorted.length === 0) {
		return;
	}
	ctx.output.writeLine(`\n${label} (${sorted.length}):`);
	for (const command of sorted) {
		ctx.output.writeLine(`  /${command.name} — ${command.description}`);
	}
}
