/**
 * Tests for the slash command registry.
 */

import { describe, expect, it } from "vitest";
import { createSlashCommandRegistry } from "../domain/slash-command-registry.js";
import type { SlashCommand } from "../types/index.js";

const cmdHello: SlashCommand = {
	name: "hello",
	description: "Says hello",
	type: "local",
};

const cmdWorld: SlashCommand = {
	name: "world",
	description: "Says world",
	type: "prompt",
};

describe("createSlashCommandRegistry", () => {
	it("starts empty", () => {
		const reg = createSlashCommandRegistry();
		expect(reg.listAll()).toHaveLength(0);
	});

	it("registers and retrieves a command", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		expect(reg.get("hello")).toBe(cmdHello);
	});

	it("returns undefined for unknown command", () => {
		const reg = createSlashCommandRegistry();
		expect(reg.get("nonexistent")).toBeUndefined();
	});

	it("overwrites on duplicate registration", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		const cmdHello2: SlashCommand = { name: "hello", description: "updated", type: "local" };
		reg.register(cmdHello2);
		expect(reg.get("hello")).toBe(cmdHello2);
	});

	it("lists all registered commands", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		reg.register(cmdWorld);
		expect(reg.listAll()).toHaveLength(2);
	});

	it("lists only public commands for user-facing surfaces", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		reg.register({ name: "internal", description: "hidden", type: "local", visibility: "internal" });
		expect(reg.listPublic().map((cmd) => cmd.name)).toEqual(["hello"]);
	});

	it("lists commands by type with optional visibility filtering", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		reg.register(cmdWorld);
		reg.register({ name: "secret-ui", description: "hidden ui", type: "ui", visibility: "internal" });
		reg.register({ name: "public-ui", description: "visible ui", type: "ui" });

		expect(reg.listByType("local").map((cmd) => cmd.name)).toEqual(["hello"]);
		expect(reg.listByType("ui").map((cmd) => cmd.name)).toEqual(["secret-ui", "public-ui"]);
		expect(reg.listByType("ui", "public").map((cmd) => cmd.name)).toEqual(["public-ui"]);
		expect(reg.listByType("ui", "internal").map((cmd) => cmd.name)).toEqual(["secret-ui"]);
	});
});

describe("resolve", () => {
	it("returns null for non-slash input", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		expect(reg.resolve("hello")).toBeNull();
		expect(reg.resolve("plain text")).toBeNull();
	});

	it("returns null for bare slash", () => {
		const reg = createSlashCommandRegistry();
		expect(reg.resolve("/")).toBeNull();
	});

	it("resolves command with no args", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		const result = reg.resolve("/hello");
		expect(result).not.toBeNull();
		expect(result?.type).toBe("command");
		if (result?.type === "command") {
			expect(result.command).toBe(cmdHello);
			expect(result.args).toBe("");
		}
	});

	it("resolves command with args", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		const result = reg.resolve("/hello world and more");
		expect(result).not.toBeNull();
		if (result?.type === "command") {
			expect(result.command).toBe(cmdHello);
			expect(result.args).toBe("world and more");
		}
	});

	it("returns not_found for unknown command", () => {
		const reg = createSlashCommandRegistry();
		const result = reg.resolve("/unknown");
		expect(result).not.toBeNull();
		expect(result?.type).toBe("not_found");
		if (result?.type === "not_found") {
			expect(result.name).toBe("unknown");
		}
	});

	it("trims leading whitespace", () => {
		const reg = createSlashCommandRegistry();
		reg.register(cmdHello);
		const result = reg.resolve("  /hello");
		expect(result?.type).toBe("command");
	});
});
