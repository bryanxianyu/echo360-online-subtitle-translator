/**
 * Branch-coverage tests for extension/vtt.js
 *
 * Branch map (every decision point and both outcomes):
 *   formatVttTime      – negative clamping, h/m/s/ms boundaries
 *   cueTextToLine      – null/undefined/\r/whitespace
 *   parseVttStats      – no lines, match vs no-match, e > maxEnd vs ≤
 *   parseVttBlocks     – empty, CRLF, cue at EOF, empty text
 *   isAlreadyBilingual – 6 early-return branches + threshold boundary
 *   hasCjk             – match / no match
 *   reorderCueTextZhFirst – single line, zh at 0, zh at idx>0, zh absent
 *   extractPrimary     – empty parts, zhLine found, zhLine absent
 *   applyCueBottom     – non-timing, existing line:, unknown size fallback
 */

import { beforeAll, describe, it, expect } from "vitest";
import { evalModule, makeVttNs } from "../helpers/load-module.js";

let vtt;

beforeAll(() => {
  window.Echo360Translator = makeVttNs();
  evalModule("vtt.js");
  vtt = window.Echo360Translator.vtt;
});

// ---------------------------------------------------------------------------
// formatVttTime
// ---------------------------------------------------------------------------
describe("formatVttTime", () => {
  it("formats zero exactly", () => {
    expect(vtt.formatVttTime(0)).toBe("00:00:00.000");
  });

  it("clamps negative to zero", () => {
    expect(vtt.formatVttTime(-0.001)).toBe("00:00:00.000");
    expect(vtt.formatVttTime(-999)).toBe("00:00:00.000");
  });

  it("formats sub-second correctly — pads ms to 3 digits", () => {
    expect(vtt.formatVttTime(0.001)).toBe("00:00:00.001");
    expect(vtt.formatVttTime(0.01)).toBe("00:00:00.010");
    expect(vtt.formatVttTime(0.5)).toBe("00:00:00.500");
  });

  it("formats seconds with padding", () => {
    expect(vtt.formatVttTime(1)).toBe("00:00:01.000");
    expect(vtt.formatVttTime(9)).toBe("00:00:09.000");
    expect(vtt.formatVttTime(59)).toBe("00:00:59.000");
  });

  it("rolls seconds over to minutes", () => {
    expect(vtt.formatVttTime(60)).toBe("00:01:00.000");
    expect(vtt.formatVttTime(61)).toBe("00:01:01.000");
  });

  it("rolls minutes over to hours", () => {
    expect(vtt.formatVttTime(3600)).toBe("01:00:00.000");
    expect(vtt.formatVttTime(3661.5)).toBe("01:01:01.500");
  });

  it("handles large values", () => {
    expect(vtt.formatVttTime(36000)).toBe("10:00:00.000");
  });
});

// ---------------------------------------------------------------------------
// cueTextToLine
// ---------------------------------------------------------------------------
describe("cueTextToLine", () => {
  it("returns empty string for null", () => {
    expect(vtt.cueTextToLine(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(vtt.cueTextToLine(undefined)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(vtt.cueTextToLine("")).toBe("");
  });

  it("strips carriage returns", () => {
    expect(vtt.cueTextToLine("hello\r")).toBe("hello");
    expect(vtt.cueTextToLine("line1\r\nline2")).toBe("line1\nline2");
  });

  it("trims surrounding whitespace", () => {
    expect(vtt.cueTextToLine("  hello  ")).toBe("hello");
    expect(vtt.cueTextToLine("\thello\t")).toBe("hello");
  });

  it("preserves internal spaces and newlines", () => {
    expect(vtt.cueTextToLine("hello world")).toBe("hello world");
    expect(vtt.cueTextToLine("a\nb")).toBe("a\nb");
  });
});

// ---------------------------------------------------------------------------
// parseVttStats
// ---------------------------------------------------------------------------
const SIMPLE_VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:03.000",
  "Hello world",
  "",
  "2",
  "00:00:05.000 --> 00:00:10.500",
  "Second cue",
  "",
].join("\n");

describe("parseVttStats", () => {
  it("returns zeros for null input", () => {
    const s = vtt.parseVttStats(null);
    expect(s.cueCount).toBe(0);
    expect(s.maxEnd).toBe(0);
    expect(s.ranges).toEqual([]);
  });

  it("returns zeros for empty string", () => {
    const s = vtt.parseVttStats("");
    expect(s.cueCount).toBe(0);
  });

  it("counts cues and captures maxEnd", () => {
    const s = vtt.parseVttStats(SIMPLE_VTT);
    expect(s.cueCount).toBe(2);
    expect(s.maxEnd).toBeCloseTo(10.5);
  });

  it("does NOT update maxEnd when second cue ends earlier (e ≤ maxEnd branch)", () => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:05.000 --> 00:00:10.000",
      "First",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "Second (ends before first)",
      "",
    ].join("\n");
    const s = vtt.parseVttStats(vttText);
    expect(s.maxEnd).toBeCloseTo(10.0);
  });

  it("DOES update maxEnd when second cue ends later (e > maxEnd branch)", () => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "First",
      "",
      "00:00:05.000 --> 00:00:20.000",
      "Second (ends later)",
      "",
    ].join("\n");
    const s = vtt.parseVttStats(vttText);
    expect(s.maxEnd).toBeCloseTo(20.0);
  });

  it("populates ranges array with [start, end] pairs", () => {
    const s = vtt.parseVttStats(SIMPLE_VTT);
    expect(s.ranges).toHaveLength(2);
    expect(s.ranges[0][0]).toBeCloseTo(1);
    expect(s.ranges[0][1]).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
// parseVttBlocks
// ---------------------------------------------------------------------------
describe("parseVttBlocks", () => {
  it("returns empty array for null", () => {
    expect(vtt.parseVttBlocks(null)).toEqual([]);
  });

  it("returns empty array for string without timing lines", () => {
    expect(vtt.parseVttBlocks("WEBVTT\n\nSome text")).toEqual([]);
  });

  it("parses a single cue", () => {
    const blocks = vtt.parseVttBlocks(SIMPLE_VTT);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].time).toBe("00:00:01.000 --> 00:00:03.000");
    expect(blocks[0].text).toBe("Hello world");
  });

  it("handles cue with no text lines (empty text)", () => {
    const vttText = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n";
    const blocks = vtt.parseVttBlocks(vttText);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("");
  });

  it("normalizes CRLF line endings", () => {
    const vttText = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n\r\n";
    const blocks = vtt.parseVttBlocks(vttText);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Hello");
  });

  it("handles cue at EOF (no trailing empty line)", () => {
    const vttText = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello";
    const blocks = vtt.parseVttBlocks(vttText);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Hello");
  });

  it("joins multi-line cue text with newline", () => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Line one",
      "Line two",
      "",
    ].join("\n");
    const blocks = vtt.parseVttBlocks(vttText);
    expect(blocks[0].text).toBe("Line one\nLine two");
  });
});

// ---------------------------------------------------------------------------
// isAlreadyBilingualVtt
// ---------------------------------------------------------------------------
function makeCue(idx, text) {
  return [
    `${idx}`,
    `00:00:0${idx}.000 --> 00:00:0${idx + 1}.000`,
    text,
    "",
  ].join("\n");
}

function makeVttWithCues(cues) {
  return ["WEBVTT", "", ...cues].join("\n");
}

describe("isAlreadyBilingualVtt", () => {
  // Empty-guard branches — kills LogicalOperator || → && survivor
  it("returns false when ONLY translatedVtt has no cues (orig has cues)", () => {
    expect(vtt.isAlreadyBilingualVtt("WEBVTT\n\n", SIMPLE_VTT)).toBe(false);
  });

  it("returns false when ONLY originalVtt has no cues (trans has cues)", () => {
    expect(vtt.isAlreadyBilingualVtt(SIMPLE_VTT, "WEBVTT\n\n")).toBe(false);
  });

  it("returns false when both are empty", () => {
    expect(vtt.isAlreadyBilingualVtt("WEBVTT\n\n", "WEBVTT\n\n")).toBe(false);
  });

  it("returns false when n < 3 (only 2 cues)", () => {
    const two = makeVttWithCues([makeCue(1, "A"), makeCue(2, "B")]);
    expect(vtt.isAlreadyBilingualVtt(two, two)).toBe(false);
  });

  it("returns false when checked < 3 (all cue texts are empty)", () => {
    const emptyCues = [1, 2, 3].map((i) => makeCue(i, "")).join("\n");
    const v = makeVttWithCues([emptyCues]);
    expect(vtt.isAlreadyBilingualVtt(v, v)).toBe(false);
  });

  it("returns false when hit/checked ratio < 0.35 (no overlap)", () => {
    const trans = makeVttWithCues([1, 2, 3, 4, 5].map((i) => makeCue(i, "你好世界")));
    const orig = makeVttWithCues([1, 2, 3, 4, 5].map((i) => makeCue(i, "Hello world")));
    expect(vtt.isAlreadyBilingualVtt(trans, orig)).toBe(false);
  });

  it("returns true when hit/checked ratio ≥ 0.35 (exact threshold: 7/20)", () => {
    const cues = Array.from({ length: 20 }, (_, i) => {
      const orig = `word${i}`;
      const transText = i < 7 ? `${orig} 翻译` : `完全不同的文字${i}`;
      return { orig, transText };
    });
    const t = makeVttWithCues(cues.map((c, i) => makeCue(i + 1, c.transText)));
    const o = makeVttWithCues(cues.map((c, i) => makeCue(i + 1, c.orig)));
    expect(vtt.isAlreadyBilingualVtt(t, o)).toBe(true);
  });

  // !t || !o skip branch — kills LogicalOperator survivor
  it("skips pair when trans cue is empty but orig is not (only orig empty does NOT skip)", () => {
    // trans[0] empty, orig[0] non-empty → skip; only 4 checked pairs remain
    const trans = makeVttWithCues([
      makeCue(1, ""),          // trans empty → skip
      makeCue(2, "hello 你好"),
      makeCue(3, "world 世界"),
      makeCue(4, "foo 翻译"),
      makeCue(5, "bar 测试"),
    ]);
    const orig = makeVttWithCues([
      makeCue(1, "original"),  // orig non-empty → skipped because trans is empty
      makeCue(2, "hello"),
      makeCue(3, "world"),
      makeCue(4, "foo"),
      makeCue(5, "bar"),
    ]);
    // 4 checked, 4 hits → ratio 1.0 → true
    expect(vtt.isAlreadyBilingualVtt(trans, orig)).toBe(true);
  });

  it("skips pair when orig cue is empty but trans is not", () => {
    const trans = makeVttWithCues([
      makeCue(1, "hello 你好"),
      makeCue(2, "world 世界"),
      makeCue(3, "foo 翻译"),
      makeCue(4, "bar 测试"),
      makeCue(5, "baz 测试"),
    ]);
    const orig = makeVttWithCues([
      makeCue(1, "hello"),
      makeCue(2, "world"),
      makeCue(3, "foo"),
      makeCue(4, "bar"),
      makeCue(5, ""),  // orig empty → this pair skipped
    ]);
    // 4 checked, 4 hits → ratio 1.0 → true
    expect(vtt.isAlreadyBilingualVtt(trans, orig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reorderCueTextZhFirst
// ---------------------------------------------------------------------------
describe("reorderCueTextZhFirst (via normalizeBilingualOrderZhFirst)", () => {
  const wrap = (text) => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      text,
      "",
    ].join("\n");
    const result = vtt.normalizeBilingualOrderZhFirst(vttText);
    const blocks = vtt.parseVttBlocks(result);
    return blocks[0]?.text ?? "";
  };

  it("returns single line unchanged (parts.length < 2 branch)", () => {
    expect(wrap("Hello")).toBe("Hello");
  });

  it("leaves text unchanged when zh is already first (zhIdx === 0 branch)", () => {
    expect(wrap("你好世界\nHello world")).toBe("你好世界\nHello world");
  });

  it("reorders when zh is after index 0 (zhIdx > 0 branch)", () => {
    expect(wrap("Hello world\n你好世界")).toBe("你好世界\nHello world");
  });

  it("returns joined text unchanged when no CJK found (zhIdx === -1 branch)", () => {
    expect(wrap("Hello\nWorld")).toBe("Hello\nWorld");
  });
});

// ---------------------------------------------------------------------------
// extractPrimaryTranslatedVtt
// ---------------------------------------------------------------------------
describe("extractPrimaryTranslatedVtt", () => {
  it("returns empty push when cue has no non-empty lines (parts.length === 0)", () => {
    const vttText = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "   ", ""].join("\n");
    const result = vtt.extractPrimaryTranslatedVtt(vttText);
    expect(result).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("selects the CJK line when present (zhLine found branch)", () => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Hello world",
      "你好世界",
      "",
    ].join("\n");
    const result = vtt.extractPrimaryTranslatedVtt(vttText);
    const blocks = vtt.parseVttBlocks(result);
    expect(blocks[0].text).toBe("你好世界");
  });

  it("falls back to first line when no CJK found (zhLine absent branch)", () => {
    const vttText = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Hello world",
      "Another line",
      "",
    ].join("\n");
    const result = vtt.extractPrimaryTranslatedVtt(vttText);
    const blocks = vtt.parseVttBlocks(result);
    expect(blocks[0].text).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// applyCueBottom
// ---------------------------------------------------------------------------
// Helper: extract the timing line from an applyCueBottom result
function timingLineOf(vttStr) {
  return vttStr.split("\n").find((l) => l.includes("-->")) ?? "";
}

describe("applyCueBottom", () => {
  it("passes through non-timing lines unchanged", () => {
    const result = vtt.applyCueBottom("WEBVTT\n\nSome text\n", "medium");
    expect(result).toContain("WEBVTT");
    expect(result).toContain("Some text");
  });

  it("does NOT modify a timing line that already has `line:` (early-return branch)", () => {
    const line = "00:00:01.000 --> 00:00:02.000 line:90%";
    const result = vtt.applyCueBottom(`WEBVTT\n\n${line}\nHello\n`, "medium");
    expect(result).toContain("line:90%");
    expect(result).not.toMatch(/line:97\.2%/);
  });

  it("adds line/position/align to a timing line that lacks `line:`", () => {
    const result = vtt.applyCueBottom(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n",
      "medium"
    );
    expect(result).toContain("line:97.2%");
    expect(result).toContain("position:50%");
    expect(result).toContain("align:middle");
  });

  it("uses CUE_LINE_MAP for known sizes", () => {
    const r = vtt.applyCueBottom("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "small");
    expect(r).toContain("line:97.2%");
  });

  it("falls back to DEFAULT_SUBTITLE_SIZE for unknown size", () => {
    const r = vtt.applyCueBottom("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "giant");
    expect(r).toContain("line:97.2%");
  });

  // Precise attribute-removal tests — kill Regex mutants (wrong quantifier / case)
  it("completely removes old `position:` before appending new one", () => {
    const line = "00:00:01.000 --> 00:00:02.000 position:20% align:start";
    const timing = timingLineOf(vtt.applyCueBottom(`WEBVTT\n\n${line}\nHello\n`, "medium"));
    // Must not appear anywhere in the timing line
    expect(timing).not.toContain("position:20%");
    // Only the appended canonical value should be present
    expect(timing.split("position:").length).toBe(2); // exactly one occurrence
    expect(timing).toContain("position:50%");
  });

  it("completely removes old `align:` before appending new one", () => {
    const line = "00:00:01.000 --> 00:00:02.000 align:start";
    const timing = timingLineOf(vtt.applyCueBottom(`WEBVTT\n\n${line}\nHello\n`, "medium"));
    expect(timing).not.toContain("align:start");
    expect(timing.split("align:").length).toBe(2);
    expect(timing).toContain("align:middle");
  });

  it("completely removes old `line:` when a different line: value existed via replacement path", () => {
    // A timing line with position: but no line: — the replacement regex must remove all position:
    const line = "00:00:01.000 --> 00:00:02.000 position:30% align:end";
    const timing = timingLineOf(vtt.applyCueBottom(`WEBVTT\n\n${line}\nHi\n`, "medium"));
    expect((timing.match(/line:/g) || []).length).toBe(1);
    expect((timing.match(/position:/g) || []).length).toBe(1);
    expect((timing.match(/align:/g) || []).length).toBe(1);
  });

  it("resulting timing line ends with the canonical suffix", () => {
    const timing = timingLineOf(
      vtt.applyCueBottom("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n", "medium")
    );
    expect(timing).toMatch(/line:97\.2% position:50% align:middle$/);
  });
});

describe("buildIncrementalPreviewVtt", () => {
  const ORIG = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
Hello

2
00:00:02.000 --> 00:00:04.000
World

`;

  it("replaces cues that still match the original text with the pending label", () => {
    const partial = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
你好

2
00:00:02.000 --> 00:00:04.000
World

`;
    const preview = vtt.buildIncrementalPreviewVtt(partial, ORIG);
    expect(preview).toContain("你好");
    expect(preview).toContain("正在翻译中...");
    expect(preview).not.toContain("World\n");
  });

  it("supports a custom pending label", () => {
    const preview = vtt.buildIncrementalPreviewVtt(ORIG, ORIG, { placeholder: "Translating..." });
    expect(preview).toContain("Translating...");
  });

  it("marks still-pending cues with a failure label when translation aborts", () => {
    const preview = vtt.buildIncrementalPreviewVtt(ORIG, ORIG, { placeholder: "[翻译失败]" });
    expect(preview).toContain("[翻译失败]");
    expect(preview).not.toContain("正在翻译中...");
  });
});
