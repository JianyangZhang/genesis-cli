/**
 * CLI mode identifiers.
 *
 * All modes share the same runtime; this type only controls
 * how input is received and output is formatted.
 */
export type CliMode = "interactive" | "print" | "json" | "rpc";
