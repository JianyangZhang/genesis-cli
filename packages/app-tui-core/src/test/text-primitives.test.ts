import { describe, expect, it } from "vitest";
import {
	fitTerminalLine,
	measureTerminalDisplayWidth,
	stripAnsiControlSequences,
	truncatePlainText,
} from "../index.js";

describe("text primitives", () => {
	it("measures ASCII, CJK, emoji, and combining marks", () => {
		expect(measureTerminalDisplayWidth("hello")).toBe(5);
		expect(measureTerminalDisplayWidth("你好")).toBe(4);
		expect(measureTerminalDisplayWidth("a😊b")).toBe(4);
		expect(measureTerminalDisplayWidth("e\u0301")).toBe(1);
	});

	it("strips ANSI control sequences before plain-text operations", () => {
		expect(stripAnsiControlSequences("\x1b[32mhello\x1b[0m")).toBe("hello");
	});

	it("truncates and fits text by terminal display width", () => {
		expect(truncatePlainText("abcdef", 3)).toBe("abc");
		expect(truncatePlainText("你好吗", 4)).toBe("你好");
		expect(fitTerminalLine("abc", 5)).toBe("abc  ");
		expect(fitTerminalLine("\x1b[32mabcdef\x1b[0m", 3)).toBe("abc");
	});
});
