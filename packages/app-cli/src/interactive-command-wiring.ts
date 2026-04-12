import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppRuntime, SessionEngine, SessionFacade } from "@pickle-pee/runtime";
import { createInteractiveCommandRegistry, resolveRecentSessionDirectSelection } from "@pickle-pee/ui";
import { buildResumedContextLines } from "./interactive-resume-context.js";
import type { InteractiveSessionBinding } from "./interactive-session-binding.js";

interface InteractiveExitSignal {
	requestExit(): void;
	isExitRequested(): boolean;
}

interface InteractiveCommandWiringOptions {
	readonly runtime: AppRuntime;
	readonly sessionEngine: SessionEngine;
	readonly sessionBinding: InteractiveSessionBinding;
	readonly getCurrentSession: () => SessionFacade;
	readonly replaceSession: (session: SessionFacade) => void;
	readonly exitSignal: InteractiveExitSignal;
	readonly isInteractionBusy: () => boolean;
	readonly hasPendingPermissionRequest: () => boolean;
	readonly getInteractionPhase: () => string;
	readonly getLastError: () => string | null;
	readonly getChangedPaths: () => readonly string[];
	readonly getPendingPermissionCallId: () => string | null;
	readonly openResumeBrowser: (query: string) => Promise<void>;
	readonly closeResumeBrowser: () => void;
}

export function createInteractiveExitSignal(onExitRequested: () => void): InteractiveExitSignal {
	let requested = false;
	return {
		requestExit(): void {
			requested = true;
			onExitRequested();
		},
		isExitRequested(): boolean {
			return requested;
		},
	};
}

export function createInteractiveCommandWiring(options: InteractiveCommandWiringOptions) {
	const registry = createInteractiveCommandRegistry({
		getCurrentSession: options.getCurrentSession,
		getSessionTitle: () => options.sessionEngine.getSessionTitle(options.getCurrentSession().id.value),
		setSessionTitle: (next) => {
			options.sessionEngine.setSessionTitle(next, { sessionId: options.getCurrentSession().id.value });
		},
		createSession: () => options.sessionEngine.createSession(),
		closeCurrentSession: async () => {
			await options.sessionEngine.closeSession(options.getCurrentSession().id.value);
		},
		requestExit: () => {
			options.exitSignal.requestExit();
		},
		isInteractionBusy: options.isInteractionBusy,
		hasPendingPermissionRequest: options.hasPendingPermissionRequest,
		replaceSession: options.replaceSession,
		getAgentDir: () => options.sessionBinding.resolveAgentDir(),
		getInteractionPhase: options.getInteractionPhase,
		getLastError: options.getLastError,
		getChangedFileCount: () => options.getChangedPaths().length,
		getPendingPermissionCallId: options.getPendingPermissionCallId,
		getToolUsageSummary: () => summarizeToolUsage(options.runtime),
		getConfigSnapshot: async (ctx) => buildConfigSnapshot(options.sessionBinding.resolveAgentDir(), ctx),
		getWorkingTreeSummary: async () => ({
			changedPaths: options.getChangedPaths(),
			snapshot: await inspectGitWorkingTree(options.getCurrentSession().context.workingDirectory),
		}),
		getGitDiff: async (target) => readGitDiff(options.getCurrentSession().context.workingDirectory, target),
		getDoctorSnapshot: async (ctx) => buildDoctorSnapshot(options.sessionBinding.resolveAgentDir(), ctx),
	});

	registry.register({
		name: "resume",
		description: "Show recent sessions or resume one",
		type: "local",
		visibility: "public",
		async execute(ctx) {
			if (options.isInteractionBusy() || options.hasPendingPermissionRequest()) {
				ctx.output.writeError("Session is busy.");
				return undefined;
			}

			const recent = await options.runtime.listRecentSessions();
			const selector = ctx.args.trim();
			if (selector.length === 0) {
				await options.openResumeBrowser("");
				return undefined;
			}

			const directMatch = resolveRecentSessionDirectSelection(selector, recent, recent);
			if (!directMatch) {
				await options.openResumeBrowser(selector);
				return undefined;
			}

			const resumableRecoveryData = await resolveResumableRecoveryData(directMatch.recoveryData);
			if (!resumableRecoveryData) {
				ctx.output.writeError("This session cannot be resumed: transcript file is missing.");
				ctx.output.writeLine("Tip: pick a newer session that has full transcript persistence.");
				return undefined;
			}
			const recovered = await options.sessionEngine.recoverSession(resumableRecoveryData, { closeActive: true });
			options.replaceSession(recovered);
			options.closeResumeBrowser();
			for (const line of await buildResumedContextLines(directMatch)) {
				ctx.output.writeLine(line);
			}
			ctx.output.writeLine(`Resumed: ${directMatch.recoveryData.sessionId.value}`);
			ctx.output.writeLine("Next: continue this session, or /resume to view history again.");
			return undefined;
		},
	});

	return { registry };
}

export async function resolveResumableRecoveryData(
	recoveryData: Parameters<SessionEngine["recoverSession"]>[0],
): Promise<Parameters<SessionEngine["recoverSession"]>[0] | null> {
	if (typeof recoveryData.sessionFile === "string" && recoveryData.sessionFile.length > 0) {
		try {
			await readFile(recoveryData.sessionFile, "utf8");
			return recoveryData;
		} catch {
			return null;
		}
	}
	return null;
}

function summarizeToolUsage(runtime: AppRuntime) {
	const entries = runtime.governor.audit.getAll();
	return {
		total: entries.length,
		success: entries.filter((entry) => entry.status === "success").length,
		failure: entries.filter((entry) => entry.status === "failure").length,
		denied: entries.filter((entry) => entry.status === "denied").length,
		recent: entries.slice(-10).map((entry) => ({
			status: entry.status,
			toolName: entry.toolName,
			riskLevel: entry.riskLevel,
			targetPath: entry.targetPath,
			durationMs: entry.durationMs,
		})),
	};
}

async function buildConfigSnapshot(
	agentDir: string,
	ctx: { session: SessionFacade },
): Promise<{
	readonly sources: readonly { readonly key: string; readonly layer: string; readonly detail: string }[];
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
}> {
	const sources = ctx.session.context.configSources ?? {};
	const modelsPath = join(agentDir, "models.json");
	let raw = "";
	try {
		raw = await readFile(modelsPath, "utf8");
	} catch {
		return {
			sources: Object.keys(sources)
				.sort((a, b) => a.localeCompare(b))
				.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
			agentDir,
			modelsPath,
			error: "models.json not found. Run Genesis once or pass --agent-dir.",
		};
	}

	const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
	const providerKey = ctx.session.state.model.provider;
	const provider = parsed.providers?.[providerKey];
	if (!provider) {
		return {
			sources: Object.keys(sources)
				.sort((a, b) => a.localeCompare(b))
				.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
			agentDir,
			modelsPath,
			providerKey,
		};
	}

	const models = Array.isArray(provider.models) ? provider.models : [];
	const active = models.find((model: any) => model?.id === ctx.session.state.model.id);
	const apiKeyEnv = typeof provider.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
	return {
		sources: Object.keys(sources)
			.sort((a, b) => a.localeCompare(b))
			.map((key) => ({ key, layer: sources[key]!.layer, detail: sources[key]!.detail })),
		agentDir,
		modelsPath,
		providerKey,
		provider: {
			api: provider.api ?? "(missing)",
			baseUrl: provider.baseUrl ?? "(missing)",
			apiKeyEnv,
			apiKeyPresent: Boolean(process.env[apiKeyEnv]),
		},
		activeModel: active
			? {
					name: active.name ?? active.id,
					id: active.id,
					reasoning: Boolean(active.reasoning),
				}
			: null,
		modelError: active ? null : `Model not configured: ${ctx.session.state.model.id}`,
	};
}

async function buildDoctorSnapshot(
	agentDir: string,
	ctx: { session: SessionFacade },
): Promise<{
	readonly providerKey: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly apiKeyEnv: string;
	readonly apiKeyPresent: boolean;
	readonly httpStatus?: number;
	readonly responseText?: string | null;
	readonly errorText?: string | null;
} | null> {
	const modelsPath = join(agentDir, "models.json");
	let raw = "";
	try {
		raw = await readFile(modelsPath, "utf8");
	} catch {
		return null;
	}
	const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
	const providerKey = ctx.session.state.model.provider;
	const provider = parsed.providers?.[providerKey];
	const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	const api = typeof provider?.api === "string" ? provider.api : "";
	const apiKeyEnv = typeof provider?.apiKey === "string" ? provider.apiKey : "GENESIS_API_KEY";
	const apiKey = process.env[apiKeyEnv];
	const snapshot = {
		providerKey,
		api,
		baseUrl,
		apiKeyEnv,
		apiKeyPresent: Boolean(apiKey),
	};
	if (!apiKey || !baseUrl || api !== "openai-completions") {
		return snapshot;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 3000);
	try {
		const response = await fetch(new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: ctx.session.state.model.id,
				stream: false,
				messages: [{ role: "user", content: "Reply exactly DOCTOR_OK" }],
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			return { ...snapshot, httpStatus: response.status, errorText: await response.text() };
		}
		const payload = (await response.json()) as any;
		const text = payload?.choices?.[0]?.message?.content;
		return {
			...snapshot,
			httpStatus: response.status,
			responseText: typeof text === "string" ? text.trim() : null,
		};
	} catch (err) {
		return { ...snapshot, errorText: `  error: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		clearTimeout(timeout);
	}
}

function runGit(cwd: string, args: readonly string[]): Promise<{ type: "ok"; stdout: string } | { type: "error" }> {
	return new Promise((resolve) => {
		execFile("git", [...args], { cwd }, (error, stdout) => {
			if (error) {
				resolve({ type: "error" });
				return;
			}
			resolve({ type: "ok", stdout: String(stdout) });
		});
	});
}

async function inspectGitWorkingTree(cwd: string): Promise<{
	readonly available: boolean;
	readonly statusLines: readonly string[];
	readonly diffStatLines: readonly string[];
}> {
	const [status, diffStat] = await Promise.all([
		runGit(cwd, ["status", "--porcelain"]),
		runGit(cwd, ["diff", "--stat"]),
	]);
	if (status.type === "error" || diffStat.type === "error") {
		return {
			available: false,
			statusLines: [],
			diffStatLines: [],
		};
	}
	return {
		available: true,
		statusLines: splitNonEmptyLines(status.stdout),
		diffStatLines: splitNonEmptyLines(diffStat.stdout),
	};
}

function readGitDiff(cwd: string, target: string | null): Promise<{ type: "ok"; stdout: string } | { type: "error" }> {
	return runGit(cwd, target ? ["diff", "--", target] : ["diff"]);
}

function splitNonEmptyLines(text: string): readonly string[] {
	return text
		.trim()
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}
