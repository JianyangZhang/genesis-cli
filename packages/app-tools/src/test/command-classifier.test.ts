import { describe, expect, it } from "vitest";
import { classifyCommand, createCommandPolicy } from "../policy/command-classifier.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyCommand", () => {
	describe("short commands", () => {
		it("classifies ls as short_command", () => {
			expect(classifyCommand("ls -la")).toBe("short_command");
		});

		it("classifies echo as short_command", () => {
			expect(classifyCommand("echo hello")).toBe("short_command");
		});

		it("classifies git status as short_command", () => {
			expect(classifyCommand("git status")).toBe("short_command");
		});
	});

	describe("web servers", () => {
		it("classifies npm serve as web_server", () => {
			expect(classifyCommand("npm serve")).toBe("web_server");
		});

		it("classifies npm run dev as web_server", () => {
			expect(classifyCommand("npm run dev")).toBe("web_server");
		});

		it("classifies vite as web_server", () => {
			expect(classifyCommand("vite")).toBe("web_server");
		});

		it("classifies next dev as web_server", () => {
			expect(classifyCommand("next dev")).toBe("web_server");
		});
	});

	describe("background processes", () => {
		it("classifies trailing & as background_process", () => {
			expect(classifyCommand("sleep 100 &")).toBe("background_process");
		});

		it("classifies nohup as background_process", () => {
			expect(classifyCommand("nohup ./server")).toBe("background_process");
		});

		it("classifies disown as background_process", () => {
			expect(classifyCommand("disown %1")).toBe("background_process");
		});

		it("prioritizes background over web_server", () => {
			expect(classifyCommand("nohup npm serve")).toBe("background_process");
		});
	});

	describe("long tasks", () => {
		it("classifies npm build as long_task", () => {
			expect(classifyCommand("npm run build")).toBe("long_task");
		});

		it("classifies npm test as long_task", () => {
			expect(classifyCommand("npm test")).toBe("long_task");
		});

		it("classifies compile as long_task", () => {
			expect(classifyCommand("tsc --noEmit")).toBe("short_command");
			expect(classifyCommand("compile src/")).toBe("long_task");
		});

		it("classifies npm install as long_task", () => {
			expect(classifyCommand("npm install")).toBe("long_task");
		});
	});
});

describe("createCommandPolicy", () => {
	it("returns a full policy with correct defaults for short_command", () => {
		const policy = createCommandPolicy("ls -la", "/project");

		expect(policy.commandClass).toBe("short_command");
		expect(policy.cwd).toBe("/project");
		expect(policy.blocking).toBe(true);
		expect(policy.timeoutMs).toBe(30_000);
		expect(policy.riskLevel).toBe("L2");
	});

	it("returns non-blocking for background_process", () => {
		const policy = createCommandPolicy("nohup ./server &", "/project");

		expect(policy.commandClass).toBe("background_process");
		expect(policy.blocking).toBe(false);
		expect(policy.timeoutMs).toBe(0);
	});

	it("returns no timeout for web_server", () => {
		const policy = createCommandPolicy("npm run dev", "/project");

		expect(policy.commandClass).toBe("web_server");
		expect(policy.timeoutMs).toBe(0);
		expect(policy.riskLevel).toBe("L3");
	});

	it("returns extended timeout for long_task", () => {
		const policy = createCommandPolicy("npm run build", "/project");

		expect(policy.commandClass).toBe("long_task");
		expect(policy.timeoutMs).toBe(300_000);
	});
});
