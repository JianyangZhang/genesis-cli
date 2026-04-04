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
	let session: SessionFacade | null = null;

	function send(envelope: RpcEnvelope): void {
		output.write(`${JSON.stringify(envelope)}\n`);
	}

	async function handleRequest(req: RpcEnvelope, runtime: AppRuntime): Promise<void> {
		const id = req.id ?? null;

		switch (req.method) {
			case RPC_METHODS.SESSION_CREATE: {
				session = runtime.createSession();
				// Subscribe to all events and forward as notifications
				session.events.onCategory("*", (event) => {
					send(eventToRpcNotification(event));
				});
				send(createRpcResponse(id ?? 0, { sessionId: session.id.value, status: "created" }));
				break;
			}

			case RPC_METHODS.SESSION_PROMPT: {
				if (!session) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const text = (req.params as Record<string, unknown>)?.text;
				if (typeof text !== "string") {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Missing 'text' parameter"));
					break;
				}
				try {
					await session.prompt(text);
					send(createRpcResponse(id ?? 0, { status: "prompt_sent" }));
				} catch (err) {
					send(createRpcError(id, RPC_ERRORS.INTERNAL_ERROR, String(err)));
				}
				break;
			}

			case RPC_METHODS.SESSION_ABORT: {
				if (!session) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				session.abort();
				send(createRpcResponse(id ?? 0, { status: "aborted" }));
				break;
			}

			case RPC_METHODS.SESSION_CLOSE: {
				if (!session) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				await session.close();
				session = null;
				send(createRpcResponse(id ?? 0, { status: "closed" }));
				break;
			}

			case RPC_METHODS.SESSION_LIST: {
				// Single-session for now; list the active session if any.
				const result = session ? [{ sessionId: session.id.value, status: session.state.status }] : [];
				send(createRpcResponse(id ?? 0, result));
				break;
			}

			case RPC_METHODS.PLAN_STATUS: {
				if (!session?.plan) {
					send(createRpcResponse(id ?? 0, { active: false, plan: null }));
					break;
				}
				const summary = session.plan.summarize();
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
				if (!session) {
					send(createRpcError(id, RPC_ERRORS.SESSION_NOT_FOUND, "No active session"));
					break;
				}
				const permParams = req.params as Record<string, unknown> | undefined;
				const callId = permParams?.callId;
				const decision = permParams?.decision;
				if (typeof callId !== "string" || typeof decision !== "string") {
					send(createRpcError(id, RPC_ERRORS.INVALID_PARAMS, "Missing 'callId' or 'decision'"));
					break;
				}
				session.resolvePermission(callId, decision as "allow" | "allow_for_session" | "allow_once" | "deny");
				send(createRpcResponse(id ?? 0, { status: "resolved" }));
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

			// Also forward global runtime events
			runtime.events.onCategory("*", (event) => {
				// Only forward global events that aren't session-scoped
				// (session-scoped events are forwarded by the session listener)
				if (event.category === "session") {
					send(eventToRpcNotification(event));
				}
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
			if (session) {
				await session.close();
				session = null;
			}
		},
	};
}
