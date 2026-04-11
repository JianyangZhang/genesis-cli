import { describe, expect, it, vi } from "vitest";
import { createInteractiveHostState } from "../interactive-host-state.js";

describe("interactive host state", () => {
	it("tracks active local command lifecycle", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const onFailed = vi.fn();
		const onSettled = vi.fn();
		const state = createInteractiveHostState({
			onBusyLocalCommandFailed: onFailed,
			onBusyLocalCommandSettled: onSettled,
		});

		state.runLocalBusyCommand(pending);
		expect(state.hasActiveLocalCommand()).toBe(true);

		release();
		await pending;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(state.hasActiveLocalCommand()).toBe(false);
		expect(onFailed).not.toHaveBeenCalled();
		expect(onSettled).toHaveBeenCalledTimes(1);
	});
});
