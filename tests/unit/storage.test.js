/**
 * Branch-coverage tests for extension/storage.js (pure / mockable logic)
 *
 * Branch map:
 *   getContextKey      – /lesson/:id path vs other pathname
 *   buildConfigSignature – all fields contribute to signature
 *   askApiKeyIfNeeded  – keyless provider, provider+key, provider+no key
 *   getConfig          – enableLocalBackend false → force useLocalBackend=false
 *   getPrefs           – useNativeSubtitles true/false, size "tiny", unknown size
 *   savePrefs          – bilingual/reverseOrder normalization
 *   getCacheStore      – valid object vs null/non-object
 *   sha256Text         – deterministic hash
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// getContextKey
// ---------------------------------------------------------------------------
describe("getContextKey", () => {
  it("extracts lesson id from /lesson/:id path", () => {
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/abc-123/classroom" },
      configurable: true,
      writable: true,
    });
    const { storage } = setupStorage();
    expect(storage.getContextKey()).toBe("echo360.org::abc-123");
  });

  it("uses full pathname when no /lesson/:id segment", () => {
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/section/home" },
      configurable: true,
      writable: true,
    });
    const { storage } = setupStorage();
    expect(storage.getContextKey()).toBe("echo360.org::/section/home");
  });
});

// ---------------------------------------------------------------------------
// buildConfigSignature
// ---------------------------------------------------------------------------
describe("buildConfigSignature", () => {
  let storage;
  beforeEach(() => {
    ({ storage } = setupStorage());
  });

  const base = () => ({
    provider: "openai",
    model: "gpt-5-nano",
    endpoint: "https://api.openai.com/v1",
    target: "ZH",
    maxParagraphs: 6,
    maxChars: 1200,
    reasoningEffort: "medium",
    deepseekThinkingMode: "disabled",
    deeplFormality: "default",
  });

  it("is deterministic", () => {
    const sig = storage.buildConfigSignature(base());
    expect(storage.buildConfigSignature(base())).toBe(sig);
  });

  it("uppercases target", () => {
    const sig = storage.buildConfigSignature({ ...base(), target: "zh" });
    expect(sig).toContain("ZH");
    expect(sig).not.toContain('"zh"');
  });

  // Each field individually changes the signature — kills StringLiteral / LogicalOperator survivors
  it.each([
    ["provider",             { provider: "deepseek" }],
    ["model",                { model: "gpt-4o" }],
    ["endpoint",             { endpoint: "https://custom.endpoint/v1" }],
    ["target",               { target: "JA" }],
    ["maxParagraphs",        { maxParagraphs: 10 }],
    ["maxChars",             { maxChars: 800 }],
    ["reasoningEffort",      { reasoningEffort: "high" }],
    ["deepseekThinkingMode", { deepseekThinkingMode: "enabled" }],
    ["deeplFormality",       { deeplFormality: "more" }],
  ])("changing %s produces a different signature", (_field, override) => {
    const s1 = storage.buildConfigSignature(base());
    const s2 = storage.buildConfigSignature({ ...base(), ...override });
    expect(s1).not.toBe(s2);
  });

  it("uses empty string for missing endpoint (not undefined)", () => {
    const withEmpty   = storage.buildConfigSignature({ ...base(), endpoint: "" });
    const withMissing = storage.buildConfigSignature({ ...base(), endpoint: undefined });
    expect(withEmpty).toBe(withMissing);
  });

  it("treats missing optional fields without throwing", () => {
    expect(() => storage.buildConfigSignature({ provider: "openai", model: "", target: "ZH" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// askApiKeyIfNeeded
// ---------------------------------------------------------------------------
describe("askApiKeyIfNeeded", () => {
  let storage;
  beforeEach(() => {
    ({ storage } = setupStorage());
  });

  it("returns config with empty apiKey for keyless provider (google-web)", async () => {
    const cfg = { provider: "google-web", apiKey: "some-key" };
    const result = await storage.askApiKeyIfNeeded(cfg);
    expect(result.apiKey).toBe("");
  });

  it("returns config unchanged when provider has apiKey", async () => {
    const cfg = { provider: "deepseek", apiKey: "sk-abc123" };
    const result = await storage.askApiKeyIfNeeded(cfg);
    expect(result).toBe(cfg); // same reference
  });

  it("returns null when provider needs key but none provided", async () => {
    const cfg = { provider: "openai", apiKey: "" };
    const result = await storage.askApiKeyIfNeeded(cfg);
    expect(result).toBeNull();
  });

  it("returns null when apiKey is only whitespace", async () => {
    const cfg = { provider: "deepseek", apiKey: "   " };
    const result = await storage.askApiKeyIfNeeded(cfg);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getConfig (store build — extension-only, no local backend)
// ---------------------------------------------------------------------------
describe("getConfig", () => {
  it("forces useLocalBackend=false on store build even if stored as true", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: { provider: "deepseek", useLocalBackend: true },
      },
      enableLocalBackend: false,
    });
    const cfg = await storage.getConfig();
    expect(cfg.useLocalBackend).toBe(false);
  });

  it("returns default config when nothing is stored", async () => {
    const { storage } = setupStorage({ storageData: {} });
    const cfg = await storage.getConfig();
    expect(cfg.provider).toBe("google-web");
    expect(cfg.target).toBe("ZH");
  });

  it("resolves apiKey from apiKeys[provider] map (per-provider key storage)", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: {
          provider: "deepseek",
          apiKey: "legacy-key",
          apiKeys: { deepseek: "sk-deepseek-new", openai: "sk-openai" },
        },
      },
    });
    const cfg = await storage.getConfig();
    expect(cfg.apiKey).toBe("sk-deepseek-new");
  });

  it("falls back to legacy apiKey when apiKeys map has no entry for provider", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: {
          provider: "gemini",
          apiKey: "legacy-gemini-key",
          apiKeys: { deepseek: "sk-deepseek" },
        },
      },
    });
    const cfg = await storage.getConfig();
    expect(cfg.apiKey).toBe("legacy-gemini-key");
  });

  it("returns empty apiKey for keyless provider regardless of stored keys", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: {
          provider: "google-web",
          apiKey: "should-be-cleared",
          apiKeys: { "google-web": "should-also-be-cleared" },
        },
      },
    });
    const cfg = await storage.getConfig();
    expect(cfg.apiKey).toBe("");
  });

  it("preserves apiKeys map from storage", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: {
          provider: "openai",
          apiKeys: { openai: "sk-openai", deepseek: "sk-deepseek" },
        },
      },
    });
    const cfg = await storage.getConfig();
    expect(cfg.apiKeys.openai).toBe("sk-openai");
    expect(cfg.apiKeys.deepseek).toBe("sk-deepseek");
  });
});

// ---------------------------------------------------------------------------
// getPrefs normalization
// ---------------------------------------------------------------------------
describe("getPrefs normalization", () => {
  // Display/render prefs are global (not scoped per lesson) since 1.4.x - see
  // GLOBAL_PREFS_KEY in storage.js.
  const prefsKey = () => "echo360TranslatorPrefs::global";

  it("forces bilingual=true and reverseOrder=false in Echo360 native CC mode (schema v3)", async () => {
    const { storage } = setupStorage({
      storageData: {
        [prefsKey()]: {
          enabled: true,
          size: "medium",
          bilingual: false,
          reverseOrder: true,
          useNativeSubtitles: false,
          renderModeVersion: 3,
        },
      },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.bilingual).toBe(true);
    expect(prefs.reverseOrder).toBe(false);
  });

  it("respects stored bilingual/reverseOrder when useNativeSubtitles=true", async () => {
    const { storage } = setupStorage({
      storageData: {
        [prefsKey()]: {
          enabled: true,
          size: "medium",
          bilingual: false,
          reverseOrder: true,
          useNativeSubtitles: true,
          renderModeVersion: 3,
        },
      },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.bilingual).toBe(false);
    expect(prefs.reverseOrder).toBe(true);
  });

  it('upgrades legacy size "tiny" to "medium"', async () => {
    const { storage } = setupStorage({
      storageData: { [prefsKey()]: { size: "tiny", useNativeSubtitles: false, renderModeVersion: 3 } },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.size).toBe("medium");
  });

  it("falls back to DEFAULT_SUBTITLE_SIZE for unknown size", async () => {
    const { storage } = setupStorage({
      storageData: { [prefsKey()]: { size: "extrasmall", useNativeSubtitles: false, renderModeVersion: 3 } },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.size).toBe("medium");
  });

  it("returns defaults when nothing is stored (browser track preferred)", async () => {
    const { storage } = setupStorage({ storageData: {} });
    const prefs = await storage.getPrefs();
    expect(prefs.enabled).toBe(true);
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.bilingual).toBe(false);
  });

  it("migrates legacy prefs without schema version to prefer the browser track", async () => {
    const { storage } = setupStorage({
      storageData: {
        [prefsKey()]: {
          enabled: true,
          size: "medium",
          bilingual: false,
          reverseOrder: false,
          useNativeSubtitles: false,
        },
      },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.renderModeVersion).toBe(3);
  });

  it("migrates schema v2 native-CC-default prefs onto the browser track", async () => {
    const { storage } = setupStorage({
      storageData: {
        [prefsKey()]: {
          enabled: true,
          size: "medium",
          bilingual: true,
          reverseOrder: false,
          useNativeSubtitles: false,
          renderModeVersion: 2,
        },
      },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.renderModeVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Prefs persist globally across lessons (not scoped per lesson/pathname)
// ---------------------------------------------------------------------------
describe("prefs persistence across lessons", () => {
  it("savePrefs on one lesson is read back by getPrefs on a different lesson", async () => {
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/course-a/classroom" },
      configurable: true,
      writable: true,
    });
    const { storage } = setupStorage();
    await storage.savePrefs({
      enabled: true,
      bilingual: true,
      reverseOrder: false,
      useNativeSubtitles: false,
      size: "large",
    });

    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/course-b/classroom" },
      configurable: true,
      writable: true,
    });
    const prefs = await storage.getPrefs();
    expect(prefs.useNativeSubtitles).toBe(false);
    expect(prefs.size).toBe("large");
  });

  it("adopts a legacy per-lesson pref entry the first time getPrefs runs after upgrading", async () => {
    const { storage, localMock } = setupStorage({
      storageData: {
        "echo360TranslatorPrefs::echo360.org::old-lesson-id": {
          enabled: true,
          size: "small",
          bilingual: false,
          reverseOrder: false,
          browserBilingual: false,
          browserReverseOrder: false,
          useNativeSubtitles: true,
          renderModeVersion: 2,
        },
      },
    });
    const prefs = await storage.getPrefs();
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.size).toBe("small");
    // The migrated value is persisted under the new global key so subsequent
    // reads don't need to re-scan legacy entries.
    expect(localMock._store["echo360TranslatorPrefs::global"]).toBeTruthy();
  });

  it("ignores non-prefs keys when scanning for a legacy entry to migrate", async () => {
    const { storage } = setupStorage({
      storageData: {
        echo360TranslatorConfig: { provider: "openai" },
        echo360TranslatedVttCache: { cacheKey: "x" },
      },
    });
    const prefs = await storage.getPrefs();
    // Falls through to hardcoded defaults since no legacy prefs entry exists.
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.bilingual).toBe(false);
  });

  it("does not re-migrate once a global prefs entry already exists", async () => {
    const { storage } = setupStorage({
      storageData: {
        "echo360TranslatorPrefs::global": {
          enabled: true,
          size: "medium",
          useNativeSubtitles: false,
          renderModeVersion: 2,
        },
        "echo360TranslatorPrefs::echo360.org::stale-lesson": {
          enabled: true,
          size: "small",
          useNativeSubtitles: true,
          renderModeVersion: 2,
        },
      },
    });
    const prefs = await storage.getPrefs();
    // Reads the global entry (not the stale legacy one). Schema v2 is also
    // migrated onto the browser-track default in the same getPrefs() pass.
    expect(prefs.size).toBe("medium");
    expect(prefs.useNativeSubtitles).toBe(true);
    expect(prefs.renderModeVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// savePrefs (P1 — previously NoCoverage)
// ---------------------------------------------------------------------------
describe("savePrefs", () => {
  const prefsKey = () => "echo360TranslatorPrefs::global";

  it("persists prefs so getPrefs can read them back", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({
      enabled: true,
      size: "large",
      bilingual: true,
      reverseOrder: false,
      useNativeSubtitles: true,
    });
    expect(localMock.set).toHaveBeenCalledOnce();
    const saved = localMock._store[prefsKey()];
    expect(saved.size).toBe("large");
    expect(saved.renderModeVersion).toBe(3);
  });

  it("normalizes bilingual=true when useNativeSubtitles=true", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({ useNativeSubtitles: true, bilingual: true, reverseOrder: true });
    const saved = localMock._store[prefsKey()];
    expect(saved.bilingual).toBe(true);
    expect(saved.reverseOrder).toBe(true);
  });

  it("normalizes bilingual=false when useNativeSubtitles=true and bilingual=false", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({ useNativeSubtitles: true, bilingual: false, reverseOrder: false });
    const saved = localMock._store[prefsKey()];
    expect(saved.bilingual).toBe(false);
    expect(saved.reverseOrder).toBe(false);
  });

  it("forces bilingual=true and reverseOrder=false in Echo360 native CC mode", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({
      useNativeSubtitles: false,
      bilingual: true,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: true,
    });
    const saved = localMock._store[prefsKey()];
    expect(saved.bilingual).toBe(true);
    expect(saved.reverseOrder).toBe(false);
    expect(saved.browserBilingual).toBe(false);
    expect(saved.browserReverseOrder).toBe(true);
  });

  it("preserves previous browser subtitle prefs when entering Echo360 native CC mode", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({
      useNativeSubtitles: true,
      bilingual: false,
      reverseOrder: true,
      size: "medium",
    });

    await storage.savePrefs({
      useNativeSubtitles: false,
      bilingual: true,
      reverseOrder: false,
      size: "medium",
    });

    const saved = localMock._store[prefsKey()];
    expect(saved.bilingual).toBe(true);
    expect(saved.reverseOrder).toBe(false);
    expect(saved.browserBilingual).toBe(false);
    expect(saved.browserReverseOrder).toBe(true);
  });

  it("restores browser subtitle prefs after leaving Echo360 native CC mode", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({
      useNativeSubtitles: false,
      bilingual: true,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: true,
      size: "medium",
    });

    await storage.savePrefs({
      useNativeSubtitles: true,
      bilingual: false,
      reverseOrder: true,
      size: "medium",
    });

    const saved = localMock._store[prefsKey()];
    expect(saved.bilingual).toBe(false);
    expect(saved.reverseOrder).toBe(true);
    expect(saved.browserBilingual).toBe(false);
    expect(saved.browserReverseOrder).toBe(true);
  });

  it("treats missing useNativeSubtitles as true (browser track preferred)", async () => {
    const { storage, localMock } = setupStorage();
    await storage.savePrefs({ bilingual: false, reverseOrder: true });
    const saved = localMock._store[prefsKey()];
    expect(saved.useNativeSubtitles).toBe(true);
  });

  it("round-trips: savePrefs then getPrefs returns the same values", async () => {
    const original = {
      enabled: false,
      size: "small",
      bilingual: true,
      reverseOrder: false,
      useNativeSubtitles: true,
    };
    const { storage, localMock } = setupStorage();
    await storage.savePrefs(original);
    // Feed stored value back into get mock
    localMock.get.mockImplementation(async (key) => ({ [key]: localMock._store[key] }));
    const loaded = await storage.getPrefs();
    expect(loaded.enabled).toBe(false);
    expect(loaded.size).toBe("small");
    expect(loaded.bilingual).toBe(true);
    expect(loaded.useNativeSubtitles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setCacheStore (error handling path)
// ---------------------------------------------------------------------------
describe("setCacheStore", () => {
  it("writes entry to cache key", async () => {
    const { storage, localMock } = setupStorage();
    const entry = { translatedVtt: "WEBVTT\n\n", cacheKey: "abc" };
    await storage.setCacheStore(entry);
    expect(localMock.set).toHaveBeenCalledWith({ echo360TranslatedVttCache: entry });
  });

  it("writes null when called with null", async () => {
    const { storage, localMock } = setupStorage();
    await storage.setCacheStore(null);
    expect(localMock.set).toHaveBeenCalledWith({ echo360TranslatedVttCache: null });
  });

  it("does not throw when storage.set rejects (error is swallowed)", async () => {
    const { storage, localMock } = setupStorage();
    localMock.set.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(storage.setCacheStore({ x: 1 })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getCacheStore
// ---------------------------------------------------------------------------
describe("getCacheStore", () => {
  it("returns null when cache storage is empty", async () => {
    const { storage } = setupStorage({ storageData: {} });
    expect(await storage.getCacheStore()).toBeNull();
  });

  it("returns null when stored value is not an object", async () => {
    const { storage } = setupStorage({
      storageData: { echo360TranslatedVttCache: "not-an-object" },
    });
    expect(await storage.getCacheStore()).toBeNull();
  });

  it("returns the stored object when it is valid", async () => {
    const entry = { cacheKey: "abc", translatedVtt: "WEBVTT\n\n" };
    const { storage } = setupStorage({
      storageData: { echo360TranslatedVttCache: entry },
    });
    expect(await storage.getCacheStore()).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// sha256Text
// ---------------------------------------------------------------------------
describe("sha256Text", () => {
  it("produces a 64-char hex string", async () => {
    const { storage } = setupStorage();
    const hash = await storage.sha256Text("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", async () => {
    const { storage } = setupStorage();
    const h1 = await storage.sha256Text("echo360");
    const h2 = await storage.sha256Text("echo360");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different inputs", async () => {
    const { storage } = setupStorage();
    const h1 = await storage.sha256Text("hello");
    const h2 = await storage.sha256Text("world");
    expect(h1).not.toBe(h2);
  });
});
