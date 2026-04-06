import { describe, expect, it } from "vitest";
import { createInteractiveModePlan, createRestoredModeState } from "../index.js";

describe("terminal mode plans", () => {
	it("includes enter, refresh, reenter, and exit sequences for native terminals", () => {
		const plan = createInteractiveModePlan({
			hostFamily: "native",
			alternateScreen: true,
			mouseTracking: true,
			focusReporting: true,
			bracketedPaste: false,
			synchronizedOutput: true,
			extendedKeys: true,
		});

		expect(plan.enter).toContain("\x1b[?1049h");
		expect(plan.enter).toContain("\x1b[?1004h");
		expect(plan.enter).toContain("\x1b[?1000h");
		expect(plan.refresh).not.toContain("\x1b[?1049h");
		expect(plan.reenter).toContain("\x1b[?1049h");
		expect(plan.exit).toContain("\x1b[?1049l");
		expect(plan.exit).toContain("\x1b[?1004l");
		expect(plan.exit).toContain("\x1b[?1000l");
	});

	it("omits focus and mouse sequences for degraded IDE hosts", () => {
		const plan = createInteractiveModePlan({
			hostFamily: "jetbrains-jediterm",
			alternateScreen: true,
			mouseTracking: false,
			focusReporting: false,
			bracketedPaste: false,
			synchronizedOutput: false,
			extendedKeys: false,
		});

		expect(plan.enter).toContain("\x1b[?1049h");
		expect(plan.enter).not.toContain("\x1b[?1004h");
		expect(plan.enter).not.toContain("\x1b[?1000h");
		expect(plan.exit).not.toContain("\x1b[?1004l");
		expect(plan.exit).not.toContain("\x1b[?1000l");
	});

	it("provides a fully cleared restored state", () => {
		expect(createRestoredModeState()).toEqual({
			cursorHidden: false,
			alternateScreenActive: false,
			mouseTrackingActive: false,
			focusReportingActive: false,
			bracketedPasteActive: false,
		});
	});
});
