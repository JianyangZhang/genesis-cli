import { describe, expect, it } from "vitest";
import { computeTranscriptDisplayRows, flattenTranscriptLines, wrapTranscriptContent } from "../index.js";

describe("transcript layout", () => {
	it("wraps transcript content by terminal display width", () => {
		expect(wrapTranscriptContent("abcdef", 3)).toEqual(["abc", "def"]);
		expect(wrapTranscriptContent("你好吗", 4)).toEqual(["你好", "吗"]);
	});

	it("flattens blocks while preserving unwrapped leading blocks", () => {
		expect(flattenTranscriptLines(["hello\nworld", "abcdef"], 3, 1)).toEqual(["hello", "world", "abc", "def"]);
	});

	it("counts rendered transcript rows after wrapping", () => {
		expect(computeTranscriptDisplayRows(["one\ntwo", "three"], 10)).toBe(3);
		expect(computeTranscriptDisplayRows(["abcdef"], 3)).toBe(2);
	});
});
