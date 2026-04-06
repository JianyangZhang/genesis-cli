import type { FramePatch, ScreenFrame } from "../types/index.js";

export function diffScreenFrames(previous: ScreenFrame | null, next: ScreenFrame): readonly FramePatch[] {
	if (previous === null || previous.width !== next.width || previous.height !== next.height) {
		return fullRedraw(next);
	}

	const patches: FramePatch[] = [];
	for (let row = 1; row <= next.height; row += 1) {
		const previousLine = previous.lines[row - 1] ?? "";
		const nextLine = next.lines[row - 1] ?? "";

		if (previousLine === nextLine) {
			continue;
		}

		if (nextLine.length === 0) {
			patches.push({ type: "clear-line", row });
			continue;
		}

		patches.push({
			type: "write-line",
			row,
			content: nextLine,
		});
	}

	patches.push({
		type: "move-cursor",
		cursor: next.cursor,
	});
	return patches;
}

function fullRedraw(frame: ScreenFrame): readonly FramePatch[] {
	const patches: FramePatch[] = [];
	for (let row = 1; row <= frame.height; row += 1) {
		const content = frame.lines[row - 1] ?? "";
		patches.push(
			content.length === 0
				? { type: "clear-line", row }
				: {
						type: "write-line",
						row,
						content,
					},
		);
	}

	patches.push({
		type: "move-cursor",
		cursor: frame.cursor,
	});
	return patches;
}
