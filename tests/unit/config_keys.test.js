import { describe, it, expect, beforeEach } from "vitest";
import { evalModule } from "../helpers/load-module.js";

describe("config_keys (shared per-provider API key logic)", () => {
  beforeEach(() => {
    delete globalThis.Echo360ConfigKeys;
    evalModule("config_keys.js");
  });

  it("treats google-web as keyless and other providers as needing a key", () => {
    const api = globalThis.Echo360ConfigKeys;
    expect(api.isKeylessProvider("google-web")).toBe(true);
    expect(api.isKeylessProvider("deepseek")).toBe(false);
    expect(api.isKeylessProvider("")).toBe(false);
  });

  it("buildKeyMap returns the apiKeys map untouched when present", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = api.buildKeyMap({ provider: "deepseek", apiKeys: { deepseek: "abc", openai: "xyz" }, apiKey: "legacy" });
    expect(map).toEqual({ deepseek: "abc", openai: "xyz" });
  });

  it("buildKeyMap migrates the legacy apiKey onto the current provider when missing from apiKeys", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = api.buildKeyMap({ provider: "deepseek", apiKeys: {}, apiKey: "legacy-key" });
    expect(map).toEqual({ deepseek: "legacy-key" });
  });

  it("buildKeyMap does not overwrite an existing per-provider key with the legacy field", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = api.buildKeyMap({ provider: "deepseek", apiKeys: { deepseek: "fresh" }, apiKey: "stale" });
    expect(map).toEqual({ deepseek: "fresh" });
  });

  it("buildKeyMap handles a missing config gracefully", () => {
    const api = globalThis.Echo360ConfigKeys;
    expect(api.buildKeyMap(undefined)).toEqual({});
    expect(api.buildKeyMap({})).toEqual({});
  });

  it("stashKey trims and records the key for a non-keyless provider", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = {};
    api.stashKey(map, "deepseek", "  my-key  ");
    expect(map).toEqual({ deepseek: "my-key" });
  });

  it("stashKey is a no-op for keyless providers", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = { "google-web": "should-not-happen" };
    api.stashKey(map, "google-web", "typed-value");
    expect(map).toEqual({ "google-web": "should-not-happen" });
  });

  it("stashKey is a no-op when provider is falsy", () => {
    const api = globalThis.Echo360ConfigKeys;
    const map = {};
    api.stashKey(map, "", "typed-value");
    expect(map).toEqual({});
  });

  it("resolveForSave mirrors the current provider's key into apiKey", () => {
    const api = globalThis.Echo360ConfigKeys;
    const result = api.resolveForSave({ deepseek: "d-key", openai: "o-key" }, "openai");
    expect(result).toEqual({ apiKeys: { deepseek: "d-key", openai: "o-key" }, apiKey: "o-key" });
  });

  it("resolveForSave clears apiKey for keyless providers even if a stale value exists in the map", () => {
    const api = globalThis.Echo360ConfigKeys;
    const result = api.resolveForSave({ "google-web": "stale" }, "google-web");
    expect(result).toEqual({ apiKeys: { "google-web": "stale" }, apiKey: "" });
  });
});
