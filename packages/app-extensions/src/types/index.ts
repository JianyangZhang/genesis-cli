/**
 * Extension point identifiers.
 *
 * Each extension point defines a contract that extensions must satisfy.
 */
export type ExtensionPoint = "tool" | "provider" | "command";

/**
 * Extension lifecycle states.
 */
export type ExtensionState = "registered" | "loaded" | "active" | "error";

/**
 * Extension descriptor.
 */
export interface ExtensionDescriptor {
	readonly name: string;
	readonly version: string;
	readonly extensionPoints: readonly ExtensionPoint[];
}
