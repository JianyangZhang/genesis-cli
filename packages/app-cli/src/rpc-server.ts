/**
 * RPC server — JSON-RPC 2.0 over stdio for IDE/embedded mode.
 *
 * Reads JSON-RPC requests from an input stream, dispatches them
 * to runtime methods, and writes notifications/responses to an output stream.
 */

import * as readline from "node:readline";
import type { AppRuntime, SessionFacade } from "@genesis-cli/runtime";
import type { RpcEnvelope } from "@genesis-cli/ui";
import {
	createRpcError,
	createRpcResponse,
	eventToRpcNotification,
	parseRpcRequest,
	RPC_ERRORS,
	RPC_METHODS,
} from "@genesis-cli/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcServer {
	start(runtime: AppRuntime): Promise<void>;
	stop(): Promise<void>;
}

export interface RpcServerOptions {
	readonly input?: NodeJS.ReadableStream;
	readonly output?: NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRpcServer(options: RpcServerOptions = {}): RpcServer {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	let running = false;
	const sessions = new Map<string, SessionFacade>();
	const activePrompts = new Map<string, Promise<void>>();
	let activeSessionId: string | null = null;
	let unsubscribeRuntime: (() => void) | null = null;
	const eventFilters: {
		all: boolean;
		sessionIds: Set<string>;
		categories: Set<string>;
	} = { all: true, sessionIds: new Set(), categories: new Set() };
	const PERMISSION_DECISIONS = new Set(["allow", "allow_for_session", "allow_once", "deny"]);

	function send(envelope: RpcEnvelope): void {
		output.write(`${JSON.stringify(envelope)}\n`);
	}

	function asParams(value: unknown): Record<string, unknown> | null {
		if (typeof value !== "object" || value === null) return null;
		return value as Record<string, unknown>;
	}

	function getSessionFromParams(params: Record<string, unknown> | null): { session: SessionFacade; sessionId: string } | null {
		const sid = typeof params?.sessionId === "string" ? params.sessionId : activeSessionId;
		if (!sid) return null;
		const session = sessions.get(sid) ?? null;
		if (!session) return null;
		return { session, sessionId: sid };
	}

	function shouldForwardEvent(event: { sessionId: { value: string }; category: string }): boolean {
		if (eventFilters.all) return true;
		if (eventFilters.sessionIds.size > 0 && !eventFilters.sessionIds.has(event.sessionId.value)) return false;
		if (eventFilters.categories.size > 0 && !eventFilters.categories.has(event.category)) return false;
		return true;
	}

	async function handleRequest(req: RpcEnvelope, runtime: AppRuntime): Promise<void> {
		const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : req.id === null ? null : null;
		if (typeof req.method !== "string") {
			send(createRpcError(id, RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC request"));
			return;
		}
		const params = asParams(req.params);

		switch (req.method) {
			case RPC_METHODS.SESSION_CREATE: {
				const created = runtime.createSession();
				sessions.set(created.id.value, created);
				activeSessionId = created.id.value;
				send(createRpcResponse(id ?? 0, { sessionId: created.id.value, status: "created" }));
				break;
			}

			case RPC_METHODS.SESSION_SELECT: {
				const target = typeof params?.sessionId === "string" ? params.sessionId : null;
				if (!target) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Missing 'sessionId' parameter"));
					break;
				}
				if (!sessions.has(target)) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, `Session not found: ${target}`));
					break;
				}
				activeSessionId = target;
				send(createRpcResponse(id ?? 0, { sessionId: target, status: "selected" }));
				break;
			}

			case RPC_METHODS.SESSION_PROMPT: {
				const resolved = getSessionFromParams(params);
				if (!resolved) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const { session, sessionId } = resolved;
				if (activePrompts.has(sessionId)) {
					send(createRpcError(id, RPC_ERRORS.SESSION_BUSY, "Session is already processing a prompt"));
					break;
				}
				const text = params?.text;
				if (typeof text !== "string") {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Missing 'text' parameter"));
					break;
				}
				const runningPrompt = session
					.prompt(text)
					.catch(() => {
						// Prompt failures are surfaced through session events; keep the RPC loop responsive.
					})
					.finally(() => {
						activePrompts.delete(sessionId);
					});
				activePrompts.set(sessionId, runningPrompt);
				send(createRpcResponse(id ?? 0, { status: "prompt_sent" }));
				break;
			}

			case RPC_METHODS.SESSION_ABORT: {
				const resolved = getSessionFromParams(params);
				if (!resolved) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const { session } = resolved;
				session.abort();
				send(createRpcResponse(id ?? 0, { status: "aborted" }));
				break;
			}

			case RPC_METHODS.SESSION_CLOSE: {
				const resolved = getSessionFromParams(params);
				if (!resolved) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const { session, sessionId } = resolved;
				await session.close();
				sessions.delete(sessionId);
				activePrompts.delete(sessionId);
				if (activeSessionId === sessionId) {
					activeSessionId = null;
				}
				send(createRpcResponse(id ?? 0, { sessionId, status: "closed" }));
				break;
			}

			case RPC_METHODS.SESSION_LIST: {
				const result = [...sessions.values()].map((s) => ({
					sessionId: s.id.value,
					status: s.state.status,
					model: s.state.model,
				}));
				send(createRpcResponse(id ?? 0, result));
				break;
			}

			case RPC_METHODS.PLAN_STATUS: {
				const resolved = getSessionFromParams(params);
				if (!resolved || !resolved.session.plan) {
					send(createRpcResponse(id ?? 0, { active: false, plan: null }));
					break;
				}
				const summary = resolved.session.plan.summarize();
				if (summary) {
					send(
						createRpcResponse(id ?? 0, {
							active: true,
							plan: {
								planId: summary.planId,
								goal: summary.goal,
								status: summary.status,
								stepCount: summary.stepCount,
								completedSteps: summary.completedSteps,
							},
						}),
					);
				} else {
					send(createRpcResponse(id ?? 0, { active: false, plan: null }));
				}
				break;
			}

			case RPC_METHODS.TOOLS_LIST: {
				const tools = runtime.governor.catalog.listAll();
				const toolList = tools.map((t) => ({
					name: t.identity.name,
					category: t.identity.category,
					riskLevel: t.policy.riskLevel,
					readOnly: t.policy.readOnly,
				}));
				send(createRpcResponse(id ?? 0, { tools: toolList, count: toolList.length }));
				break;
			}

			case RPC_METHODS.PERMISSION_RESOLVE: {
				const resolved = getSessionFromParams(params);
				if (!resolved) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const callId = params?.callId;
				const decision = params?.decision;
				if (typeof callId !== "string" || typeof decision !== "string" || !PERMISSION_DECISIONS.has(decision)) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Missing 'callId' or 'decision'"));
					break;
				}
				await resolved.session.resolvePermission(
					callId,
					decision as "allow" | "allow_for_session" | "allow_once" | "deny",
				);
				send(createRpcResponse(id ?? 0, { status: "resolved" }));
				break;
			}

			case RPC_METHODS.EVENTS_STATUS: {
				send(
					createRpcResponse(id ?? 0, {
						all: eventFilters.all,
						sessionIds: [...eventFilters.sessionIds],
						categories: [...eventFilters.categories],
					}),
				);
				break;
			}

			case RPC_METHODS.EVENTS_SUBSCRIBE: {
				const sessionIds = params?.sessionIds;
				const categories = params?.categories;
				if (sessionIds !== undefined && !Array.isArray(sessionIds)) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid 'sessionIds' parameter"));
					break;
				}
				if (categories !== undefined && !Array.isArray(categories)) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid 'categories' parameter"));
					break;
				}
				eventFilters.all = false;
				if (Array.isArray(sessionIds)) {
					for (const sid of sessionIds) {
						if (typeof sid === "string") eventFilters.sessionIds.add(sid);
					}
				}
				if (Array.isArray(categories)) {
					for (const c of categories) {
						if (typeof c === "string") eventFilters.categories.add(c);
					}
				}
				send(createRpcResponse(id ?? 0, { status: "subscribed" }));
				break;
			}

			case RPC_METHODS.EVENTS_UNSUBSCRIBE: {
				const sessionIds = params?.sessionIds;
				const categories = params?.categories;
				if (sessionIds !== undefined && !Array.isArray(sessionIds)) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid 'sessionIds' parameter"));
					break;
				}
				if (categories !== undefined && !Array.isArray(categories)) {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Invalid 'categories' parameter"));
					break;
				}
				if (Array.isArray(sessionIds)) {
					for (const sid of sessionIds) {
						if (typeof sid === "string") eventFilters.sessionIds.delete(sid);
					}
				}
				if (Array.isArray(categories)) {
					for (const c of categories) {
						if (typeof c === "string") eventFilters.categories.delete(c);
					}
				}
				if (eventFilters.sessionIds.size === 0 && eventFilters.categories.size === 0) {
					eventFilters.all = true;
				}
				send(createRpcResponse(id ?? 0, { status: "unsubscribed" }));
				break;
			}

			default: {
				send(createRpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${req.method}`));
				break;
			}
		}
	}

	return {
		async start(runtime: AppRuntime): Promise<void> {
			running = true;
			const rl = readline.createInterface({ input: input as NodeJS.ReadableStream });

			unsubscribeRuntime?.();
			unsubscribeRuntime = runtime.events.onAny((event) => {
				if (!running) return;
				if (!shouldForwardEvent(event)) return;
				send(eventToRpcNotification(event));
			});

			for await (const line of rl) {
				if (!running) break;
				const req = parseRpcRequest(line);
				if (req) {
					await handleRequest(req, runtime);
				} else {
					// Invalid JSON or not a valid request
					send(createRpcError(null, RPC_ERRORS.PARSE_ERROR, "Invalid JSON-RPC request"));
				}
			}
		},

		async stop(): Promise<void> {
			running = false;
			unsubscribeRuntime?.();
			unsubscribeRuntime = null;
			for (const [sid, s] of sessions) {
				try {
					await s.close();
				} catch {}
				activePrompts.delete(sid);
			}
			sessions.clear();
			activeSessionId = null;
		},
	};
}
