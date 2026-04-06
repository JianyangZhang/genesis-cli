import { describe, expect, it } from "vitest";
import { composePromptBlock, composeSectionBlock, materializeComposerBlock, materializeTextBlock } from "../index.js";

describe("composer layout", () => {
	it("builds a standard prompt block with leading lines, hint, and trailing separator", () => {
		const result = composePromptBlock({
			leadingLines: ["Thinking"],
			separator: "---",
			prompt: "❯ ",
			buffer: "/he",
			cursor: 3,
			hint: "lp",
		});

		expect(result.lines).toEqual(["Thinking", "---", "❯ /help", "---"]);
		expect(result.cursorLineIndex).toBe(2);
		expect(result.cursorColumn).toBe(5);
	});

	it("builds a permission-style block with extra body lines", () => {
		const result = composePromptBlock({
			leadingLines: ["Responding"],
			separator: "---",
			bodyLines: ["Write(test.txt)", "Allow?"],
			prompt: "choice [Enter/1/2/3]> ",
			buffer: "2",
			cursor: 1,
		});

		expect(result.lines).toEqual([
			"Responding",
			"---",
			"Write(test.txt)",
			"Allow?",
			"choice [Enter/1/2/3]> 2",
			"---",
		]);
		expect(result.cursorLineIndex).toBe(4);
		expect(result.cursorColumn).toBe("choice [Enter/1/2/3]> ".length + 1);
	});

	it("composes generic section blocks with separators", () => {
		expect(
			composeSectionBlock({
				leadingLines: ["Header"],
				separator: "---",
				bodyLines: ["Body A", "Body B"],
				trailingSeparator: true,
			}),
		).toEqual(["Header", "---", "Body A", "Body B", "---"]);
	});

	it("materializes composer layout into a rendered block", () => {
		const rendered = materializeComposerBlock(
			composePromptBlock({
				leadingLines: ["Thinking"],
				separator: "---",
				prompt: "❯ ",
				buffer: "hi",
				cursor: 2,
			}),
			80,
		);

		expect(rendered.block).toBe("Thinking\n---\n❯ hi\n---");
		expect(rendered.lines).toEqual(["Thinking", "---", "❯ hi", "---"]);
		expect(rendered.cursorLineIndex).toBe(2);
		expect(rendered.renderedWidth).toBe(80);
	});

	it("materializes plain text blocks without cursor metadata", () => {
		const rendered = materializeTextBlock(["Header", "---", "Body"]);

		expect(rendered.block).toBe("Header\n---\nBody");
		expect(rendered.lines).toEqual(["Header", "---", "Body"]);
	});

	it("always inserts a separator above the prompt even without leading lines", () => {
		const result = composePromptBlock({
			leadingLines: [],
			separator: "---",
			prompt: "❯ ",
			buffer: "",
			cursor: 0,
		});

		expect(result.lines).toEqual(["---", "❯ ", "---"]);
		expect(result.cursorLineIndex).toBe(1);
	});
});
