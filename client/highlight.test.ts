import { HIGHLIGHT_MAX_SOURCE_BYTES } from "@getpaseo/highlight";
import { describe, expect, it } from "vitest";
import { expandedOffset, expandTabs, highlightPreview, previewSpans, surfaceColorScheme } from "./highlight";

describe("file preview", () => {
  it("uses Paseo keyword tokens and preserves Python text", async () => {
    const source = "def answer():\r\n\treturn 42\r\n";
    const lines = await highlightPreview(source, "answer.py");
    expect(lines?.map((line) => line.map((token) => token.text).join(""))).toEqual(["def answer():", "\treturn 42", ""]);
    expect(lines?.[0]).toContainEqual({ text: "def", style: "keyword" });
    expect(lines?.[1]).toContainEqual({ text: "return", style: "keyword" });
    const spans = previewSpans("\treturn 42", lines?.[1], { start: 1, end: 7 });
    expect(spans.map((span) => span.text).join("")).toBe("    return 42");
    expect(spans.filter((span) => span.matched)).toEqual([{ text: "return", style: "keyword", matched: true }]);
  });

  it("retains plain text for cancellation, unsupported files, and the UTF-8 byte limit", async () => {
    const lifetime = new AbortController();
    const pending = highlightPreview("def answer():\n\treturn 42", "answer.py", lifetime.signal);
    lifetime.abort();
    expect(await pending).toBeNull();
    expect(await highlightPreview("plain text", "notes.unknown")).toBeNull();
    expect(await highlightPreview(`#${"é".repeat(HIGHLIGHT_MAX_SOURCE_BYTES / 2)}`, "large.py")).toBeNull();
    expect(await highlightPreview("\r\n".repeat(HIGHLIGHT_MAX_SOURCE_BYTES / 2 + 1), "large.py")).toBeNull();
  });

  it("expands four-column tabs and maps UTF-16 offsets without losing whitespace", () => {
    const source = " \ta\t😀x\n\tz";
    const expanded = "    a   😀x\n    z";
    expect(expandTabs(source)).toBe(expanded);
    for (let offset = 0; offset <= source.length; offset += 1) {
      expect(expandedOffset(source, offset)).toBe(expandTabs(source.slice(0, offset)).length);
    }
    expect(expandTabs("a\tb", 8)).toBe("a       b");
    expect(expandedOffset("a\tb", -1)).toBe(0);
    expect(expandedOffset("a\tb", 99)).toBe(5);
    expect(previewSpans("a\tb", [{ text: "a", style: "variable" }, { text: "\tb", style: null }], { start: 2, end: 3 }))
      .toEqual([{ text: "a", style: "variable", matched: false }, { text: "   ", style: null, matched: false }, { text: "b", style: null, matched: true }]);
    expect(previewSpans("abc", undefined, { start: 1, end: 1 }).filter((span) => span.matched).map((span) => span.text).join(""))
      .toBe("b");
    expect(previewSpans("abc", undefined, { start: 3, end: 3 }).filter((span) => span.matched))
      .toEqual([{ text: "│", style: null, matched: true }]);
    for (const end of [0, 1]) {
      expect(previewSpans("😀x", undefined, { start: 0, end }))
        .toEqual([{ text: "😀", style: null, matched: true }, { text: "x", style: null, matched: false }]);
    }
    const denseTokens = Array.from({ length: 257 }, () => ({ text: "x", style: "variable" as const }));
    expect(previewSpans("x".repeat(257), denseTokens)).toEqual([{ text: "x".repeat(257), style: null, matched: false }]);
  });

  it("uses surface luminance for the light and dark syntax palettes", () => {
    expect(surfaceColorScheme("#ffffff")).toBe("light");
    expect(surfaceColorScheme("#fff")).toBe("light");
    expect(surfaceColorScheme("#000000ff")).toBe("dark");
    expect(surfaceColorScheme("#1234")).toBe("dark");
  });
});
