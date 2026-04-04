/**
 * MCP (Model Context Protocol) tool integration types.
 *
 * MCP tools enter the unified catalog alongside built-in tools.
 * These types describe how an MCP server and its tools are represented
 * in the governance system. Actual MCP client logic is outside P3 scope.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type McpTransportType = "stdio" | "sse" | "http" | "websocket" | "streamableHttp";

// ---------------------------------------------------------------------------
// Server descriptor
// ---------------------------------------------------------------------------

export interface McpServerDescriptor {
	/** Unique server name within the project. */
	readonly name: string;
	/** Transport type for connecting to this server. */
	readonly transport: McpTransportType;
	/** Command (stdio) or URL (network) to connect. */
	readonly endpoint: string;
	/** Whether this server is currently enabled. */
	readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// MCP tool entry
// ---------------------------------------------------------------------------

export interface McpToolEntry {
	/** The MCP server this tool comes from. */
	readonly serverName: string;
	/** The tool name as reported by the MCP server. */
	readonly toolName: string;
	/** The unified name in the catalog: "mcp__<server>__<tool>". */
	readonly unifiedName: string;
	/** Parameter schema from the MCP server. */
	readonly parameterSchema: Readonly<Record<string, unknown>>;
	/** Tool description from the MCP server. */
	readonly description?: string;
}
