/**
 * Built-in slash commands for P5.
 *
 * Five commands: /model, /session, /tools, /plan, /compact.
 * All commands are type "local" and output through OutputSink.
 */

import type { SlashCommand, SlashCommandContext } from "../types/index.js";

// ---------------------------------------------------------------------------
// /model — show or switch model
// ---------------------------------------------------------------------------

const modelCommand: SlashCommand = {
	name: "model",
	description: "Show the active model",
	type: "local",
	visibility: "internal",
	async execute(ctx: SlashCommandContext): Promise<undefined> {
		const model = ctx.session.state.model;
		if (ctx.args.length === 0) {
			ctx.output.writeLine(`Current model: ${model.displayName ?? model.id}`);
			ctx.output.writeLine(`  Provider: ${model.provider}`);
			ctx.output.writeLine(`  ID: ${model.id}`);
		} else {
			ctx.output.writeError("Model switching is not available in this release.");
			ctx.output.writeLine(`Current model: ${model.displayName ?? model.id}`);
		}
		return undefined;
	},
};

// ---------------------------------------------------------------------------
// /session — show session info
// ---------------------------------------------------------------------------

const sessionCommand: SlashCommand = {
	name: "session",
	description: "Show current session information",
	type: "local",
	visibility: "internal",
	async execute(ctx: SlashCommandContext): Promise<undefined> {
		const state = ctx.session.state;
		ctx.output.writeLine(`Session: ${state.id.value}`);
		ctx.output.writeLine(`  Status: ${state.status}`);
		ctx.output.writeLine(`  Model: ${state.model.displayName ?? state.model.id}`);
		ctx.output.writeLine(`  Tools: ${state.toolSet.size} registered`);
		ctx.output.writeLine(`  Task: ${state.taskState.status}`);
		if (state.taskState.currentTaskId) {
			ctx.output.writeLine(`    Task ID: ${state.taskState.currentTaskId}`);
		}
		const uptime = Date.now() - state.createdAt;
		ctx.output.writeLine(`  Uptime: ${formatUptime(uptime)}`);
		if (state.planSummary) {
			ctx.output.writeLine("  Plan: active");
		}
		if (state.compactionSummary) {
			const cs = state.compactionSummary;
			ctx.output.writeLine(`  Last compaction: ${cs.estimatedTokensSaved} tokens saved`);
		}
		return undefined;
	},
};

// ---------------------------------------------------------------------------
// /tools — list registered tools
// ---------------------------------------------------------------------------

const toolsCommand: SlashCommand = {
	name: "tools",
	description: "List registered tools with risk levels",
	type: "local",
	visibility: "internal",
	async execute(ctx: SlashCommandContext): Promise<undefined> {
		const governor = ctx.runtime.governor;
		const catalog = governor.catalog;
		const all = catalog.listAll();

		if (all.length === 0) {
			ctx.output.writeLine("No tools registered.");
			return undefined;
		}

		ctx.output.writeLine(`Registered tools (${all.length}):`);
		for (const tool of all) {
			const risk = tool.policy.riskLevel;
			const category = tool.identity.category;
			const ro = tool.policy.readOnly ? " [ro]" : "";
			ctx.output.writeLine(`  ${tool.identity.name} — ${category}, risk: ${risk}${ro}`);
		}
		return undefined;
	},
};

// ---------------------------------------------------------------------------
// /plan — show current plan summary
// ---------------------------------------------------------------------------

const planCommand: SlashCommand = {
	name: "plan",
	description: "Show current plan summary",
	type: "local",
	visibility: "internal",
	async execute(ctx: SlashCommandContext): Promise<undefined> {
		const state = ctx.session.state;
		if (!state.planSummary) {
			ctx.output.writeLine("No active plan.");
			return undefined;
		}

		const summary = state.planSummary;
		ctx.output.writeLine(`Plan: ${summary.goal}`);
		ctx.output.writeLine(`  Status: ${summary.status}`);
		ctx.output.writeLine(`  Progress: ${summary.completedSteps}/${summary.stepCount} steps completed`);
		return undefined;
	},
};

// ---------------------------------------------------------------------------
// /compact — trigger context compaction
// ---------------------------------------------------------------------------

const compactCommand: SlashCommand = {
	name: "compact",
	description: "Trigger context compaction",
	type: "local",
	visibility: "public",
	async execute(ctx: SlashCommandContext): Promise<undefined> {
		await ctx.session.compact();
		ctx.output.writeLine("Compaction completed.");
		return undefined;
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the five built-in slash commands for P5. */
export function createBuiltinCommands(): SlashCommand[] {
	return [modelCommand, sessionCommand, toolsCommand, planCommand, compactCommand];
}
