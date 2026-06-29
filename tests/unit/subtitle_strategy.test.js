/**
 * Branch-coverage tests for extension/subtitle_strategy.js
 *
 * Branch map:
 *   detectBrowser      – Edg/, Chrome/, Chromium/, CriOS/, Safari/, unknown
 *   getStrategy        – safari → single cue, others → split cue
 *   buildSingleCueBilingualVtt – empty trans, empty orig, reverseOrder=false/true, sizes
 *   buildSplitCueBilingualVtt  – empty trans, empty orig, reverseOrder, empty first/second filter
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

let strat;

// ---- helpers ---------------------------------------------------------------

function setUA(ua) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
    writable: true,
  });
}

function makeVtt(cues) {
  return [
    "WEBVTT",
    "",
    ...cues.flatMap(({ time, text }) => [time, text, ""]),
  ].join("\n");
}

const TRANS_VTT = makeVtt([
  { time: "00:00:01.000 --> 00:00:02.000", text: "翻译文字" },
  { time: "00:00:03.000 --> 00:00:04.000", text: "第二行翻译" },
  { time: "00:00:05.000 --> 00:00:06.000", text: "第三行翻译" },
]);

const ORIG_VTT = makeVtt([
  { time: "00:00:01.000 --> 00:00:02.000", text: "Original text" },
  { time: "00:00:03.000 --> 00:00:04.000", text: "Second original" },
  { time: "00:00:05.000 --> 00:00:06.000", text: "Third original" },
]);

// ---- setup -----------------------------------------------------------------

beforeAll(() => {
  const ns = makeFullNs();
  window.Echo360Translator = ns;
  evalModule("vtt.js");
  // subtitle_strategy.js depends on ns.vtt being populated
  evalModule("subtitle_strategy.js");
  strat = window.Echo360Translator.subtitleStrategy;
});

afterAll(() => {
  setUA(navigator.userAgent); // restore to whatever jsdom had
});

// ---------------------------------------------------------------------------
// detectBrowser
// ---------------------------------------------------------------------------
describe("detectBrowser", () => {
  it("detects Edge (Edg/ wins before Chrome/)", () => {
    setUA("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Edg/120.0");
    expect(strat.detectBrowser()).toBe("edge");
  });

  it("detects Chrome from Chrome/ token", () => {
    setUA("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    expect(strat.detectBrowser()).toBe("chrome");
  });

  it("detects Chrome from Chromium/ token", () => {
    setUA("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chromium/120.0 Safari/537.36");
    expect(strat.detectBrowser()).toBe("chrome");
  });

  it("detects Chrome from CriOS/ token (Chrome on iOS)", () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0) AppleWebKit/605.1.15 CriOS/120.0 Mobile");
    expect(strat.detectBrowser()).toBe("chrome");
  });

  it("detects Safari (no Chrome/ / Chromium/ / CriOS/ token)", () => {
    setUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15");
    expect(strat.detectBrowser()).toBe("safari");
  });

  it("returns unknown for unrecognised UA", () => {
    setUA("CustomBrowserAgent/1.0");
    expect(strat.detectBrowser()).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// getStrategy
// ---------------------------------------------------------------------------
describe("getStrategy", () => {
  it("returns single-cue mode for Safari", () => {
    setUA("Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15");
    const s = strat.getStrategy();
    expect(s.browser).toBe("safari");
    expect(s.cueMode).toBe("single");
    expect(typeof s.buildBilingualVtt).toBe("function");
  });

  it("returns split-cue mode for Chrome", () => {
    setUA("Mozilla/5.0 Chrome/120.0 Safari/537.36");
    const s = strat.getStrategy();
    expect(s.cueMode).toBe("split");
    expect(typeof s.buildBilingualVtt).toBe("function");
  });

  it("returns split-cue mode for Edge", () => {
    setUA("Mozilla/5.0 Chrome/120.0 Edg/120.0");
    const s = strat.getStrategy();
    expect(s.cueMode).toBe("split");
  });

  it("returns split-cue mode for unknown browser", () => {
    setUA("MyWeirdUA/1.0");
    const s = strat.getStrategy();
    expect(s.cueMode).toBe("split");
  });
});

// ---------------------------------------------------------------------------
// buildSingleCueBilingualVtt
// ---------------------------------------------------------------------------
describe("buildSingleCueBilingualVtt", () => {
  it("returns translatedVtt unchanged when trans has 0 cues", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: "WEBVTT\n\n",
      originalVtt: ORIG_VTT,
    });
    expect(result).toBe("WEBVTT\n\n");
  });

  it("returns translatedVtt unchanged when orig has 0 cues", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: "WEBVTT\n\n",
    });
    expect(result).toBe(TRANS_VTT);
  });

  it("puts translated text before original when reverseOrder=false (default)", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      reverseOrder: false,
    });
    // First cue should contain both, translated first
    const lines = result.split("\n");
    const transIdx = lines.findIndex((l) => l === "翻译文字");
    const origIdx = lines.findIndex((l) => l === "Original text");
    expect(transIdx).toBeGreaterThanOrEqual(0);
    expect(origIdx).toBeGreaterThan(transIdx);
  });

  it("puts original text before translated when reverseOrder=true", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      reverseOrder: true,
    });
    const lines = result.split("\n");
    const origIdx = lines.findIndex((l) => l === "Original text");
    const transIdx = lines.findIndex((l) => l === "翻译文字");
    expect(origIdx).toBeGreaterThanOrEqual(0);
    expect(transIdx).toBeGreaterThan(origIdx);
  });

  it("uses timing from translated VTT", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
    });
    expect(result).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("injects line/position/align cue settings", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      size: "medium",
    });
    expect(result).toContain("line:97.2%");
    expect(result).toContain("position:50%");
    expect(result).toContain("align:middle");
  });

  it("uses CUE_LINE_MAP value for non-default size", () => {
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      size: "small",
    });
    expect(result).toContain("line:97.2%");
  });

  it("limits output to min(trans.length, orig.length) cues", () => {
    const shortOrig = makeVtt([
      { time: "00:00:01.000 --> 00:00:02.000", text: "Only one" },
    ]);
    const result = strat.buildSingleCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: shortOrig,
    });
    // Should only have 1 numbered cue block
    const numbered = result.split("\n").filter((l) => /^\d+$/.test(l));
    expect(numbered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildSplitCueBilingualVtt
// ---------------------------------------------------------------------------
describe("buildSplitCueBilingualVtt", () => {
  it("returns translatedVtt unchanged when trans is empty", () => {
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: "WEBVTT\n\n",
      originalVtt: ORIG_VTT,
    });
    expect(result).toBe("WEBVTT\n\n");
  });

  it("returns translatedVtt unchanged when orig is empty", () => {
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: "WEBVTT\n\n",
    });
    expect(result).toBe(TRANS_VTT);
  });

  it("emits `a` cue above and `b` cue below (reverseOrder=false)", () => {
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      reverseOrder: false,
    });
    expect(result).toContain("1a");
    expect(result).toContain("1b");
    const lines = result.split("\n");
    const aIdx = lines.indexOf("1a");
    const bIdx = lines.indexOf("1b");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it("swaps a/b content when reverseOrder=true", () => {
    const normal = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      reverseOrder: false,
    });
    const reversed = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      reverseOrder: true,
    });
    const normalLines = normal.split("\n");
    const reversedLines = reversed.split("\n");
    // In normal: `1a` block contains translated text
    const normalALine = normalLines[normalLines.indexOf("1a") + 2];
    // In reversed: `1a` block should contain original text
    const reversedALine = reversedLines[reversedLines.indexOf("1a") + 2];
    expect(normalALine).not.toBe(reversedALine);
  });

  it("omits `a` sub-cue when first text is empty (filter branch)", () => {
    const emptyTrans = makeVtt([
      { time: "00:00:01.000 --> 00:00:02.000", text: "" },
    ]);
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: emptyTrans,
      originalVtt: ORIG_VTT,
    });
    expect(result).not.toContain("1a");
    expect(result).toContain("1b"); // original is non-empty → b cue present
  });

  it("omits `b` sub-cue when second text is empty (filter branch)", () => {
    const emptyOrig = makeVtt([
      { time: "00:00:01.000 --> 00:00:02.000", text: "" },
    ]);
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: emptyOrig,
    });
    expect(result).toContain("1a"); // translated non-empty → a cue present
    expect(result).not.toContain("1b");
  });

  it("positions upper cue above lower cue (gap subtraction)", () => {
    const result = strat.buildSplitCueBilingualVtt({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      size: "medium",
    });
    const lines = result.split("\n");
    const aTimeLine = lines[lines.indexOf("1a") + 1];
    const bTimeLine = lines[lines.indexOf("1b") + 1];
    const upperMatch = aTimeLine.match(/line:([\d.]+)%/);
    const lowerMatch = bTimeLine.match(/line:([\d.]+)%/);
    expect(Number(upperMatch[1])).toBeLessThan(Number(lowerMatch[1]));
  });
});
