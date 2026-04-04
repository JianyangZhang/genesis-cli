// CLI — entry point, mode dispatch, input loop, and RPC server.

export type { InputLoop, InputLoopOptions } from "./input-loop.js";
export { createInputLoop } from "./input-loop.js";
export type { CliOptions, ParsedArgs } from "./main.js";
export { main, parseArgs } from "./main.js";
export type { ModeHandler } from "./mode-dispatch.js";
export { createModeHandler } from "./mode-dispatch.js";
export type { RpcServer, RpcServerOptions } from "./rpc-server.js";
export { createRpcServer } from "./rpc-server.js";
export type { CliMode } from "./types/index.js";
