/**
 * Property-based tests for extension/vtt.js
 *
 * Properties verified:
 *   formatVttTime
 *     P1 – roundtrip: parse(format(t)) ≈ t (lossy only to ms floor)
 *     P2 – output always matches HH:MM:SS.mmm
 *     P3 – monotone: t1 < t2 → format(t1) < format(t2) (lexicographic)
 *     P4 – negative input always returns "00:00:00.000"
 *
 *   parseVttBlocks
 *     P5 – idempotent: parseVttBlocks(rebuild(parseVttBlocks(x))) ≡ same blocks
 *     P6 – cue count never exceeds number of "-->" lines
 *     P7 – never throws on arbitrary string input
 *     P8 – CRLF and LF inputs produce identical blocks
 *
 *   applyCueBottom
 *     P9  – every timing line in the output contains "line:" setting
 *     P10 – non-timing lines are preserved unchanged
 *     P11 – idempotent: applying twice = applying once
 *
 *   cueTextToLine
 *     P12 – result never contains \r
 *     P13 – result is always trimmed
 *
 *   isAlreadyBilingualVtt
 *     P14 – always returns boolean, never throws
 *
 *   reorderCueTextZhFirst / extractPrimaryTranslatedVtt (via normalizeBilingualOrderZhFirst)
 *     P15 – normalizeBilingualOrderZhFirst never throws on arbitrary input
 *     P16 – extractPrimaryTranslatedVtt: output cue count == input cue count
 */

import { beforeAll, describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { evalModule, makeVttNs, makeFullNs } from "../helpers/load-module.js";

let vtt;

beforeAll(() => {
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  vtt = window.Echo360Translator.vtt;
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Re-build a minimal VTT string from parsed blocks. */
function rebuildVtt(blocks) {
  const lines = ["WEBVTT", ""];
  for (const b of blocks) {
    lines.push(b.time, b.text, "");
  }
  return lines.join("\n");
}

/** Arbitrary for valid subtitle seconds (0 .. 99h). */
const arbSeconds = fc.double({ min: 0, max: 359999.999, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for a single VTT timing line. */
function arbTimingLine() {
  return fc.tuple(arbSeconds, arbSeconds).map(([a, b]) => {
    const s = Math.min(a, b);
    const e = Math.max(a, b) + 0.001;
    return `${formatSec(s)} --> ${formatSec(e)}`;
  });
}

function formatSec(sec) {
  const ms = Math.floor(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(mm)}`;
}

/** Arbitrary for cue text (mix of ASCII and CJK samples). */
const arbCueText = fc.oneof(
  fc.string({ minLength: 0, maxLength: 60 }),
  fc.constant("你好世界"),
  fc.constant("Hello World"),
  fc.constant("はいそうです"),
  fc.constant("안녕하세요"),
  fc.constant(""),
);

/** Arbitrary for a well-formed VTT string (1-20 cues). */
const arbVtt = fc
  .array(fc.tuple(arbTimingLine(), arbCueText), { minLength: 1, maxLength: 20 })
  .map((cues) => {
    const lines = ["WEBVTT", ""];
    for (const [time, text] of cues) {
      lines.push(time, text || "text", "");
    }
    return lines.join("\n");
  });

// ─── formatVttTime ───────────────────────────────────────────────────────────

describe("formatVttTime properties", () => {
  it("P1 – roundtrip: parse(format(t)) equals t truncated to ms", () => {
    fc.assert(
      fc.property(arbSeconds, (t) => {
        const formatted = vtt.formatVttTime(t);
        const [hms, ms] = formatted.split(".");
        const [h, m, s] = hms.split(":").map(Number);
        const parsed = h * 3600 + m * 60 + s + Number(ms) / 1000;
        const expected = Math.floor(t * 1000) / 1000;
        return Math.abs(parsed - expected) < 0.0005;
      }),
      { numRuns: 1000 },
    );
  });

  it("P2 – output always matches HH:MM:SS.mmm format", () => {
    fc.assert(
      fc.property(arbSeconds, (t) => {
        const result = vtt.formatVttTime(t);
        return /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(result);
      }),
      { numRuns: 1000 },
    );
  });

  it("P3 – monotone: t1 < t2 → format(t1) <= format(t2) lexicographically", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbSeconds, arbSeconds).filter(([a, b]) => a !== b),
        ([a, b]) => {
          const [t1, t2] = a < b ? [a, b] : [b, a];
          return vtt.formatVttTime(t1) <= vtt.formatVttTime(t2);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("P4 – negative input always returns 00:00:00.000", () => {
    fc.assert(
      fc.property(fc.double({ max: -0.0001, noNaN: true, noDefaultInfinity: true }), (t) => {
        return vtt.formatVttTime(t) === "00:00:00.000";
      }),
      { numRuns: 500 },
    );
  });
});

// ─── parseVttBlocks ──────────────────────────────────────────────────────────

describe("parseVttBlocks properties", () => {
  it("P5 – idempotent: parsing a rebuilt VTT yields same block texts", () => {
    fc.assert(
      fc.property(arbVtt, (vttText) => {
        const first = vtt.parseVttBlocks(vttText);
        const second = vtt.parseVttBlocks(rebuildVtt(first));
        if (first.length !== second.length) return false;
        return first.every((b, i) => b.text.trim() === second[i].text.trim());
      }),
      { numRuns: 500 },
    );
  });

  it("P6 – cue count never exceeds number of '-->' lines", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const arrowCount = (s.match(/-->/g) || []).length;
        const blocks = vtt.parseVttBlocks(s);
        return blocks.length <= arrowCount;
      }),
      { numRuns: 1000 },
    );
  });

  it("P7 – never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => vtt.parseVttBlocks(s)).not.toThrow();
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it("P8 – CRLF and LF inputs produce identical blocks", () => {
    fc.assert(
      fc.property(arbVtt, (vttText) => {
        const crlf = vttText.replace(/\n/g, "\r\n");
        const fromLf = vtt.parseVttBlocks(vttText);
        const fromCrlf = vtt.parseVttBlocks(crlf);
        if (fromLf.length !== fromCrlf.length) return false;
        return fromLf.every((b, i) => b.text === fromCrlf[i].text);
      }),
      { numRuns: 500 },
    );
  });
});

// ─── applyCueBottom ──────────────────────────────────────────────────────────

describe("applyCueBottom properties", () => {
  const sizes = fc.constantFrom("small", "medium", "large", undefined);

  it("P9 – every timing line in output contains a 'line:' setting", () => {
    fc.assert(
      fc.property(arbVtt, sizes, (vttText, size) => {
        const out = vtt.applyCueBottom(vttText, size);
        return out.split("\n")
          .filter((l) => l.includes("-->"))
          .every((l) => l.includes("line:"));
      }),
      { numRuns: 500 },
    );
  });

  it("P10 – non-timing lines are passed through unchanged", () => {
    fc.assert(
      fc.property(arbVtt, sizes, (vttText, size) => {
        const inLines = vttText.split("\n").filter((l) => !l.includes("-->"));
        const outLines = vtt.applyCueBottom(vttText, size).split("\n").filter((l) => !l.includes("-->"));
        return inLines.every((l) => outLines.includes(l));
      }),
      { numRuns: 500 },
    );
  });

  it("P11 – idempotent: applying twice equals applying once", () => {
    fc.assert(
      fc.property(arbVtt, sizes, (vttText, size) => {
        const once = vtt.applyCueBottom(vttText, size);
        const twice = vtt.applyCueBottom(once, size);
        return once === twice;
      }),
      { numRuns: 500 },
    );
  });
});

// ─── cueTextToLine ───────────────────────────────────────────────────────────

describe("cueTextToLine properties", () => {
  it("P12 – result never contains \\r", () => {
    fc.assert(
      fc.property(fc.string(), (s) => !vtt.cueTextToLine(s).includes("\r")),
      { numRuns: 2000 },
    );
  });

  it("P13 – result is always trimmed (no leading/trailing whitespace)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = vtt.cueTextToLine(s);
        return result === result.trim();
      }),
      { numRuns: 2000 },
    );
  });
});

// ─── isAlreadyBilingualVtt ───────────────────────────────────────────────────

describe("isAlreadyBilingualVtt properties", () => {
  it("P14 – always returns boolean, never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const result = vtt.isAlreadyBilingualVtt(a, b);
        return typeof result === "boolean";
      }),
      { numRuns: 1000 },
    );
  });
});

// ─── normalizeBilingualOrderZhFirst / extractPrimaryTranslatedVtt ────────────

describe("normalizeBilingualOrderZhFirst properties", () => {
  it("P15 – never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => vtt.normalizeBilingualOrderZhFirst(s)).not.toThrow();
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

describe("extractPrimaryTranslatedVtt properties", () => {
  it("P16 – output cue count equals input cue count", () => {
    fc.assert(
      fc.property(arbVtt, (vttText) => {
        const inCount = vtt.parseVttBlocks(vttText).length;
        const outCount = vtt.parseVttBlocks(vtt.extractPrimaryTranslatedVtt(vttText)).length;
        return outCount === inCount;
      }),
      { numRuns: 500 },
    );
  });
});
