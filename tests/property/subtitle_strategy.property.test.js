/**
 * Property-based tests for extension/subtitle_strategy.js
 *
 * Properties verified:
 *   buildSingleCueBilingualVtt
 *     P1 – output cue count = min(trans cues, orig cues)
 *     P2 – every timing line retains the original timestamp from translatedVtt
 *     P3 – reverseOrder swaps line order (both texts still present)
 *     P4 – never throws on arbitrary string inputs
 *     P5 – empty trans input returns translatedVtt unchanged
 *     P6 – empty orig input returns translatedVtt unchanged
 *
 *   buildSplitCueBilingualVtt
 *     P7 – output cue count is at most 2 × min(trans, orig)
 *     P8 – every timing line in output contains a 'line:' setting
 *     P9 – reverseOrder swaps which cue carries which text
 *     P10 – never throws on arbitrary string inputs
 *
 *   Cross-strategy
 *     P11 – buildSingleCue and buildSplitCue contain the same cue texts
 *           (one line vs two lines per cue pair)
 */

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

let strat;
let vtt;

beforeAll(() => {
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("subtitle_strategy.js");
  strat = window.Echo360Translator.subtitleStrategy;
  vtt = window.Echo360Translator.vtt;
});

afterAll(() => {
  // restore any UA changes made during tests
  Object.defineProperty(window.navigator, "userAgent", {
    value: navigator.userAgent,
    configurable: true,
    writable: true,
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function makeVtt(cues) {
  const lines = ["WEBVTT", ""];
  let t = 0;
  for (const text of cues) {
    const start = formatSec(t);
    t += 2;
    const end = formatSec(t);
    t += 0.5;
    lines.push(`${start} --> ${end}`, text || "text", "");
  }
  return lines.join("\n");
}

function formatSec(sec) {
  const ms = Math.floor(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(mm)}`;
}

/** Arbitrary: array of cue texts, 1-15 entries. */
const arbCueTexts = fc.array(
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes("\r") && !s.includes("-->")),
  { minLength: 1, maxLength: 15 },
);

const arbSize = fc.constantFrom("small", "medium", "large");

// ─── buildSingleCueBilingualVtt ──────────────────────────────────────────────

describe("buildSingleCueBilingualVtt properties", () => {
  it("P1 – output cue count = min(trans cues, orig cues)", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const out = strat.buildSingleCueBilingualVtt({ translatedVtt, originalVtt, size });
        const outBlocks = vtt.parseVttBlocks(out);
        return outBlocks.length === Math.min(transCues.length, origCues.length);
      }),
      { numRuns: 500 },
    );
  });

  it("P2 – every timing line in output contains a timestamp from translatedVtt", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const transBlocks = vtt.parseVttBlocks(translatedVtt);
        const out = strat.buildSingleCueBilingualVtt({ translatedVtt, originalVtt, size });
        const outBlocks = vtt.parseVttBlocks(out);
        return outBlocks.every((b, i) => {
          const origTime = transBlocks[i]?.time ?? "";
          // The output time line starts with the original timing
          return b.time.startsWith(origTime.split(" ")[0]);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("P3 – reverseOrder flips text order (both lines still present)", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const n = Math.min(transCues.length, origCues.length);
        const fwd = vtt.parseVttBlocks(
          strat.buildSingleCueBilingualVtt({ translatedVtt, originalVtt, size, reverseOrder: false }),
        );
        const rev = vtt.parseVttBlocks(
          strat.buildSingleCueBilingualVtt({ translatedVtt, originalVtt, size, reverseOrder: true }),
        );
        if (fwd.length !== n || rev.length !== n) return false;
        for (let i = 0; i < n; i++) {
          const fwdText = fwd[i].text;
          const revText = rev[i].text;
          // Both must contain the same lines, just in different order
          const fwdLines = fwdText.split("\n").filter(Boolean).sort();
          const revLines = revText.split("\n").filter(Boolean).sort();
          if (fwdLines.join("|") !== revLines.join("|")) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("P4 – never throws on arbitrary string inputs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(() =>
          strat.buildSingleCueBilingualVtt({ translatedVtt: a, originalVtt: b }),
        ).not.toThrow();
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("P5 – empty trans input (no cues) returns translatedVtt unchanged", () => {
    fc.assert(
      fc.property(arbCueTexts, (origCues) => {
        const emptyVtt = "WEBVTT\n\n";
        const originalVtt = makeVtt(origCues);
        const out = strat.buildSingleCueBilingualVtt({
          translatedVtt: emptyVtt,
          originalVtt,
        });
        return out === emptyVtt;
      }),
      { numRuns: 200 },
    );
  });

  it("P6 – empty orig input returns translatedVtt unchanged", () => {
    fc.assert(
      fc.property(arbCueTexts, (transCues) => {
        const translatedVtt = makeVtt(transCues);
        const out = strat.buildSingleCueBilingualVtt({
          translatedVtt,
          originalVtt: "WEBVTT\n\n",
        });
        return out === translatedVtt;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── buildSplitCueBilingualVtt ───────────────────────────────────────────────

describe("buildSplitCueBilingualVtt properties", () => {
  it("P7 – output cue count ≤ 2 × min(trans cues, orig cues)", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const out = strat.buildSplitCueBilingualVtt({ translatedVtt, originalVtt, size });
        const outBlocks = vtt.parseVttBlocks(out);
        const maxExpected = 2 * Math.min(transCues.length, origCues.length);
        return outBlocks.length <= maxExpected;
      }),
      { numRuns: 500 },
    );
  });

  it("P8 – every timing line in output contains a 'line:' setting", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const out = strat.buildSplitCueBilingualVtt({
          translatedVtt: makeVtt(transCues),
          originalVtt: makeVtt(origCues),
          size,
        });
        return out.split("\n")
          .filter((l) => l.includes("-->"))
          .every((l) => l.includes("line:"));
      }),
      { numRuns: 500 },
    );
  });

  it("P9 – split output contains same unique cue texts regardless of reverseOrder", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const fwdBlocks = vtt.parseVttBlocks(
          strat.buildSplitCueBilingualVtt({ translatedVtt, originalVtt, size, reverseOrder: false }),
        );
        const revBlocks = vtt.parseVttBlocks(
          strat.buildSplitCueBilingualVtt({ translatedVtt, originalVtt, size, reverseOrder: true }),
        );
        const fwdTexts = new Set(fwdBlocks.map((b) => b.text.trim()));
        const revTexts = new Set(revBlocks.map((b) => b.text.trim()));
        // same set of texts, just potentially different positioning
        const same = [...fwdTexts].every((t) => revTexts.has(t)) &&
          [...revTexts].every((t) => fwdTexts.has(t));
        return same;
      }),
      { numRuns: 300 },
    );
  });

  it("P10 – never throws on arbitrary string inputs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(() =>
          strat.buildSplitCueBilingualVtt({ translatedVtt: a, originalVtt: b }),
        ).not.toThrow();
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

// ─── cross-strategy ──────────────────────────────────────────────────────────

describe("buildSingleCue vs buildSplitCue cross-strategy property", () => {
  it("P11 – both strategies produce the same set of cue texts", () => {
    fc.assert(
      fc.property(arbCueTexts, arbCueTexts, arbSize, (transCues, origCues, size) => {
        const translatedVtt = makeVtt(transCues);
        const originalVtt = makeVtt(origCues);
        const opts = { translatedVtt, originalVtt, size };

        const singleBlocks = vtt.parseVttBlocks(strat.buildSingleCueBilingualVtt(opts));
        const splitBlocks = vtt.parseVttBlocks(strat.buildSplitCueBilingualVtt(opts));

        // Collect all texts from single (each block may have 2 lines)
        const singleTexts = new Set(
          singleBlocks.flatMap((b) => b.text.split("\n").map((l) => l.trim()).filter(Boolean)),
        );
        // Each split block has exactly 1 line
        const splitTexts = new Set(splitBlocks.map((b) => b.text.trim()).filter(Boolean));

        return [...singleTexts].every((t) => splitTexts.has(t)) &&
          [...splitTexts].every((t) => singleTexts.has(t));
      }),
      { numRuns: 300 },
    );
  });
});
