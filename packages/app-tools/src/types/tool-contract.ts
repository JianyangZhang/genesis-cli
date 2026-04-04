/**
 * The contract dimension of the four-part tool model.
 *
 * Describes what a tool accepts (parameters), returns (output),
 * and how it can fail (errors). No execution logic lives here.
 */

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

/**
 * A lightweight JSON-Schema-like description of a tool's parameters.
 *
 * Kept intentionally minimal to avoid pulling in a full JSON-Schema library.
 * The runtime layer can validate actual parameters against this schema.
 */
export interface ParameterSchema {
	readonly type: "object";
	readonly properties: Readonly<Record<string, ParameterProperty>>;
	readonly required?: readonly string[];
}

export interface ParameterProperty {
	readonly type: string;
	readonly description?: string;
	readonly enum?: readonly string[];
	readonly items?: ParameterProperty;
	readonly default?: unknown;
}

// ---------------------------------------------------------------------------
// Output descriptor
// ---------------------------------------------------------------------------

/**
 * Describes the shape of a tool's output.
 */
export interface OutputDescriptor {
	readonly type: "text" | "structured" | "binary";
	readonly contentType?: string;
	readonly description?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Well-known error categories a tool can produce.
 */
export type ToolErrorKind =
	| "validation_error"
	| "permission_denied"
	| "not_found"
	| "conflict"
	| "timeout"
	| "execution_error"
	| "unknown";

export interface ToolError {
	readonly kind: ToolErrorKind;
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// ToolContract
// ---------------------------------------------------------------------------

/**
 * The contract dimension of the four-part tool model.
 */
export interface ToolContract {
	readonly parameterSchema: ParameterSchema;
	readonly output: OutputDescriptor;
	readonly errorTypes: readonly ToolErrorKind[];
}
