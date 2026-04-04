/**
 * Output mode identifiers.
 *
 * Each mode consumes the same runtime events but renders differently.
 */
export type OutputMode = "interactive" | "print" | "json" | "rpc";

/**
 * Minimal render context for any output mode.
 */
export interface RenderContext {
	readonly mode: OutputMode;
}
