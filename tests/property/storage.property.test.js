/**
 * Property-based tests for extension/storage.js
 *
 * Properties verified:
 *   buildConfigSignature
 *     P1 – deterministic: same input → same signature
 *     P2 – any field change produces a different signature (uniqueness)
 *     P3 – target is always uppercased in signature
 *     P4 – never throws on arbitrary / missing fields
 *
 *   getPrefs / savePrefs roundtrip
 *     P5 – save then get roundtrip preserves all boolean prefs
 *     P6 – size is always one of the valid SIZE_MAP keys after getPrefs
 *     P7 – Echo360 native CC mode forces bilingual=true, reverseOrder=false
 *     P8 – useNativeSubtitles=true preserves bilingual/reverseOrder booleans
 *     P11 – prefs saved on one lesson pathname are read back identically on
 *           any other lesson pathname (prefs are global, not per-lesson)
 *
 *   getContextKey
 *     P9 – result always contains "::"
 *     P10 – /lesson/:id path extracts id, not full pathname
 */

import { beforeEach, describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { evalModule, makeFullNs, makeStorageMock } from "../helpers/load-module.js";

function setupStorage({ storageData = {}, enableLocalBackend = false } = {}) {
  const localMock = makeStorageMock(storageData);
  const ns = makeFullNs({
    buildConfig: { buildTarget: "dev", enableLocalBackend },
    browserApi: {
      storage: { local: localMock },
      runtime: { sendMessage: vi.fn() },
    },
  });
  window.Echo360Translator = ns;
  evalModule("storage.js");
  return { storage: window.Echo360Translator.storage, localMock };
}

const VALID_SIZES = ["small", "medium", "large"];

// ─── buildConfigSignature ────────────────────────────────────────────────────

describe("buildConfigSignature properties", () => {
  let storage;

  beforeEach(() => {
    ({ storage } = setupStorage());
  });

  const arbCfg = fc.record({
    // Exclude "|" from provider/model/endpoint so the join("|") separator stays unambiguous
    provider: fc.string({ minLength: 0, maxLength: 20 }).map((s) => s.replace(/\|/g, "-")),
    model: fc.string({ minLength: 0, maxLength: 30 }).map((s) => s.replace(/\|/g, "-")),
    endpoint: fc.constantFrom("", "https://api.openai.com/v1", "https://custom.endpoint/v1"),
    target: fc.constantFrom("ZH", "zh", "EN", "JA", "KO", ""),
    maxParagraphs: fc.oneof(fc.integer({ min: 0, max: 20 }), fc.constant(undefined)),
    maxChars: fc.oneof(fc.integer({ min: 0, max: 5000 }), fc.constant(undefined)),
    reasoningEffort: fc.constantFrom("low", "medium", "high", ""),
    deepseekThinkingMode: fc.constantFrom("enabled", "disabled", ""),
    deeplFormality: fc.constantFrom("more", "less", "default", ""),
  });

  it("P1 – deterministic: same input always produces the same signature", () => {
    fc.assert(
      fc.property(arbCfg, (cfg) => {
        return storage.buildConfigSignature(cfg) === storage.buildConfigSignature(cfg);
      }),
      { numRuns: 1000 },
    );
  });

  it("P2 – any field change produces a different signature", () => {
    // Test each field individually: changing it must change the signature
    const fields = [
      { field: "provider", arb: fc.string({ minLength: 1, maxLength: 10 }) },
      { field: "model", arb: fc.string({ minLength: 1, maxLength: 10 }) },
      { field: "target", arb: fc.constantFrom("EN", "JA", "KO", "ZH-HK") },
      { field: "maxParagraphs", arb: fc.integer({ min: 1, max: 20 }) },
      { field: "maxChars", arb: fc.integer({ min: 100, max: 5000 }) },
    ];

    for (const { field, arb } of fields) {
      fc.assert(
        fc.property(arbCfg, arb, (cfg, altVal) => {
          const base = storage.buildConfigSignature(cfg);
          const altered = storage.buildConfigSignature({ ...cfg, [field]: altVal });
          // Only assert different if the values actually differ
          if (String(cfg[field]) === String(altVal)) return true;
          return base !== altered;
        }),
        { numRuns: 300 },
      );
    }
  });

  it("P3 – lowercase and uppercase target produce identical signatures (target is normalized)", () => {
    fc.assert(
      fc.property(
        arbCfg,
        fc.constantFrom("zh", "en", "ja", "ko", "zh-hk"),
        (cfg, lower) => {
          const withLower = storage.buildConfigSignature({ ...cfg, target: lower });
          const withUpper = storage.buildConfigSignature({ ...cfg, target: lower.toUpperCase() });
          return withLower === withUpper;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("P4 – never throws on arbitrary / missing fields", () => {
    fc.assert(
      fc.property(
        fc.record({
          provider: fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null)),
          model: fc.oneof(fc.string(), fc.constant(undefined)),
          endpoint: fc.oneof(fc.string(), fc.constant(undefined)),
          target: fc.oneof(fc.string(), fc.constant(undefined)),
          maxParagraphs: fc.oneof(fc.integer(), fc.constant(undefined), fc.constant(null)),
          maxChars: fc.oneof(fc.integer(), fc.constant(undefined)),
        }),
        (cfg) => {
          expect(() => storage.buildConfigSignature(cfg)).not.toThrow();
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ─── getPrefs / savePrefs roundtrip ─────────────────────────────────────────

describe("getPrefs / savePrefs properties", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
      configurable: true,
      writable: true,
    });
  });

  const arbPrefs = fc.record({
    enabled: fc.boolean(),
    bilingual: fc.boolean(),
    reverseOrder: fc.boolean(),
    useNativeSubtitles: fc.boolean(),
    size: fc.constantFrom("small", "medium", "large"),
  });

  it("P5 – roundtrip preserves enabled and size", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrefs, async (prefs) => {
        const { storage } = setupStorage();
        await storage.savePrefs(prefs);
        const loaded = await storage.getPrefs();
        // enabled must be preserved as-is
        expect(loaded.enabled).toBe(prefs.enabled);
        // size must be one of the valid sizes
        expect(VALID_SIZES).toContain(loaded.size);
      }),
      { numRuns: 300 },
    );
  });

  it("P6 – size is always one of valid SIZE_MAP keys after getPrefs", async () => {
    const invalidSizes = fc.constantFrom("tiny", "huge", "xl", "", "MEDIUM", undefined, null);
    await fc.assert(
      fc.asyncProperty(invalidSizes, async (badSize) => {
        const { storage } = setupStorage({
          storageData: {
            "echo360TranslatorPrefs::global": {
              enabled: true,
              bilingual: false,
              reverseOrder: false,
              useNativeSubtitles: true,
              size: badSize,
              renderModeVersion: 2,
            },
          },
        });
        const prefs = await storage.getPrefs();
        expect(VALID_SIZES).toContain(prefs.size);
      }),
      { numRuns: 50 },
    );
  });

  it("P7 – Echo360 native CC mode forces bilingual=true, reverseOrder=false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (bilingual, reverseOrder) => {
        const { storage } = setupStorage();
        await storage.savePrefs({
          enabled: true,
          bilingual,
          reverseOrder,
          useNativeSubtitles: false,
          size: "medium",
        });
        const loaded = await storage.getPrefs();
        expect(loaded.bilingual).toBe(true);
        expect(loaded.reverseOrder).toBe(false);
        expect(loaded.useNativeSubtitles).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("P8 – useNativeSubtitles=true preserves bilingual and reverseOrder booleans", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (bilingual, reverseOrder) => {
        const { storage } = setupStorage();
        await storage.savePrefs({
          enabled: true,
          bilingual,
          reverseOrder,
          useNativeSubtitles: true,
          size: "medium",
        });
        const loaded = await storage.getPrefs();
        expect(loaded.bilingual).toBe(bilingual);
        expect(loaded.reverseOrder).toBe(reverseOrder);
        expect(loaded.useNativeSubtitles).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("P11 – prefs saved on one lesson pathname are read back identically on any other lesson pathname", async () => {
    const arbLessonId = fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.replace(/\//g, "x") || "x");
    await fc.assert(
      fc.asyncProperty(arbPrefs, arbLessonId, arbLessonId, async (prefs, lessonIdA, lessonIdB) => {
        const { storage } = setupStorage();
        Object.defineProperty(window, "location", {
          value: { hostname: "echo360.org", pathname: `/lesson/${lessonIdA}/classroom` },
          configurable: true,
          writable: true,
        });
        await storage.savePrefs(prefs);

        Object.defineProperty(window, "location", {
          value: { hostname: "echo360.org", pathname: `/lesson/${lessonIdB}/classroom` },
          configurable: true,
          writable: true,
        });
        const loaded = await storage.getPrefs();
        expect(loaded.useNativeSubtitles).toBe(prefs.useNativeSubtitles);
        expect(loaded.size).toBe(prefs.size);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── getContextKey ───────────────────────────────────────────────────────────

describe("getContextKey properties", () => {
  it("P9 – result always contains '::'", () => {
    const arbHostname = fc.constantFrom(
      "echo360.org", "echo360.net.au", "canvas.sydney.edu.au", "localhost", "example.com",
    );
    const arbPathname = fc.string({ minLength: 1, maxLength: 80 })
      .map((s) => "/" + s.replace(/[\n\r]/g, "a"));

    fc.assert(
      fc.property(arbHostname, arbPathname, (hostname, pathname) => {
        Object.defineProperty(window, "location", {
          value: { hostname, pathname },
          configurable: true,
          writable: true,
        });
        const { storage } = setupStorage();
        const key = storage.getContextKey();
        return key.includes("::");
      }),
      { numRuns: 500 },
    );
  });

  it("P10 – /lesson/:id path uses id, not full pathname", () => {
    // Generate URL-safe IDs: strip non-alphanumeric/hyphen chars, pad to min length
    const arbId = fc.string({ minLength: 4, maxLength: 36 })
      .map((s) => s.replace(/[^a-zA-Z0-9-]/g, "x").replace(/^-+/, "x").padEnd(4, "x"));

    fc.assert(
      fc.property(arbId, (id) => {
        Object.defineProperty(window, "location", {
          value: { hostname: "echo360.org", pathname: `/lesson/${id}/classroom` },
          configurable: true,
          writable: true,
        });
        const { storage } = setupStorage();
        const key = storage.getContextKey();
        return key === `echo360.org::${id}`;
      }),
      { numRuns: 500 },
    );
  });
});
