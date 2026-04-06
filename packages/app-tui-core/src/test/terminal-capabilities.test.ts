import { describe, expect, it } from "vitest";
import { detectTerminalCapabilities, detectTerminalHostFamily } from "../index.js";

describe("terminal capabilities", () => {
	it("classifies VS Code integrated terminals as xterm.js hosts", () => {
		expect(
			detectTerminalHostFamily({
				term: "xterm-256color",
				termProgram: "vscode",
			}),
		).toBe("vscode-xtermjs");
	});

	it("disables mouse and focus reporting for JetBrains terminals", () => {
		const capabilities = detectTerminalCapabilities({
			term: "xterm-256color",
			terminalEmulator: "JetBrains-JediTerm",
		});

		expect(capabilities.hostFamily).toBe("jetbrains-jediterm");
		expect(capabilities.mouseTracking).toBe(false);
		expect(capabilities.focusReporting).toBe(false);
		expect(capabilities.alternateScreen).toBe(true);
	});

	it("keeps native terminals on the richer default path", () => {
		const capabilities = detectTerminalCapabilities({
			term: "xterm-256color",
			termProgram: "iTerm.app",
		});

		expect(capabilities.hostFamily).toBe("native");
		expect(capabilities.mouseTracking).toBe(true);
		expect(capabilities.focusReporting).toBe(true);
		expect(capabilities.synchronizedOutput).toBe(true);
	});
});
