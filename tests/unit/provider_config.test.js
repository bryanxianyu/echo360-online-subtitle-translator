import { beforeEach, describe, expect, it } from "vitest";
import { evalModule } from "../helpers/load-module.js";

describe("provider_config migration and endpoint rules", () => {
  let config;
  beforeEach(() => {
    delete globalThis.Echo360ProviderConfig;
    evalModule("provider_config.js");
    config = globalThis.Echo360ProviderConfig;
  });

  it("migrates legacy active-provider values once and is idempotent", () => {
    const legacy = {
      provider: "deepseek",
      apiKey: "legacy-deepseek-key",
      model: "legacy-model",
      endpoint: "https://proxy.example/v1",
      concurrency: 7,
      providerSettings: { deepseek: { concurrency: 4 }, openai: { model: "openai-manual" } },
      unrelated: { keep: true },
    };
    const once = config.migrate(legacy);
    const twice = config.migrate(once);
    expect(twice).toEqual(once);
    expect(once.apiKeys.deepseek).toBe("legacy-deepseek-key");
    expect(once.providerSettings.deepseek).toMatchObject({ model: "legacy-model", endpoint: "https://proxy.example/v1", concurrency: 4 });
    expect(once.providerSettings.openai).toMatchObject({ model: "openai-manual", endpoint: "", concurrency: 96 });
    expect(once.unrelated).toEqual({ keep: true });
  });

  it("does not revive a deliberately cleared per-provider key from the legacy mirror", () => {
    const migrated = config.migrate({ provider: "openai", apiKey: "stale", apiKeys: { openai: "" } });
    expect(config.resolve(migrated).apiKey).toBe("");
  });

  it("saves only the selected provider patch and updates its legacy mirrors", () => {
    const existing = config.migrate({
      provider: "google-web",
      providerSettings: {
        openai: { model: "openai-current", concurrency: 12 },
        deepseek: { model: "deepseek-current", endpoint: "https://proxy.example" },
      },
      apiKeys: { openai: "o-key", deepseek: "d-key" },
    });
    const saved = config.saveActive(existing, "openai", { model: "new-openai-model" }, { target: "JA" }, "o-key-2");
    expect(saved.providerSettings.openai).toMatchObject({ model: "new-openai-model", concurrency: 12 });
    expect(saved.providerSettings.deepseek).toMatchObject({ model: "deepseek-current", endpoint: "https://proxy.example" });
    expect(saved.model).toBe("new-openai-model");
    expect(saved.apiKeys).toMatchObject({ openai: "o-key-2", deepseek: "d-key" });
    expect(saved.target).toBe("JA");
  });

  it("uses the curated model as each AI provider default", () => {
    expect(config.DEFAULTS.openai.model).toBe("gpt-6-luna");
    expect(config.DEFAULTS.deepseek.model).toBe("deepseek-flash");
    expect(config.DEFAULTS.gemini.model).toBe("gemini-3.5-flash-lite");
  });

  it("centralizes default endpoint inputs and advances only the requested reset fields", () => {
    expect(config.DEFAULT_ENDPOINTS).toMatchObject({
      openai: "https://api.openai.com/v1",
      deepseek: "https://api.deepseek.com",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      deepl: "https://api-free.deepl.com/v2/translate",
    });
    expect(config.defaultAdvancedPatch("openai", false)).toEqual({ endpoint: "", openaiApiProtocol: "responses", reasoningEffort: "" });
    expect(config.defaultAdvancedPatch("openai", true)).toMatchObject({ endpoint: "", openaiApiProtocol: "responses", reasoningEffort: "", maxParagraphs: 6, maxChars: 1200, concurrency: 96, rps: 0 });
    expect(config.defaultAdvancedPatch("deepseek", false)).toEqual({ endpoint: "", deepseekThinkingMode: "disabled" });
  });

  it.each([
    ["google-web", "translate", "", "https://translate.googleapis.com/translate_a/single"],
    ["openai", "translate", "", "https://api.openai.com/v1/responses"],
    ["openai", "models", "", "https://api.openai.com/v1/models"],
    ["deepseek", "translate", "", "https://api.deepseek.com/chat/completions"],
    ["deepseek", "models", "", "https://api.deepseek.com/models"],
    ["gemini", "models", "", "https://generativelanguage.googleapis.com/v1beta/models"],
    ["gemini", "translate", "gemini-3.5-flash-lite", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"],
    ["deepl", "translate", "", "https://api-free.deepl.com/v2/translate"],
    ["deepl", "usage", "", "https://api-free.deepl.com/v2/usage"],
  ])("resolves the default %s %s endpoint consistently", (provider, resource, model, expected) => {
    expect(config.endpointFor(provider, "", resource, model)).toBe(expected);
  });

  it("normalizes an OpenAI-compatible chat completions endpoint according to the selected protocol", () => {
    const endpoint = "https://proxy.example/v1/chat/completions";
    expect(config.endpointFor("openai", endpoint, "translate", "", "responses"))
      .toBe("https://proxy.example/v1/responses");
    expect(config.endpointFor("openai", endpoint, "translate", "", "chat-completions"))
      .toBe(endpoint);
  });

  it("rejects a known endpoint path incompatible with DeepSeek", () => {
    const provider = "deepseek";
    const endpoint = "https://proxy.example/v1/responses";
    expect(() => config.endpointFor(provider, endpoint, "translate")).toThrow(/接口/);
  });

  it("normalizes a Gemini model-catalog endpoint before building translation routes", () => {
    expect(config.endpointFor("gemini", "https://generativelanguage.googleapis.com/v1beta/models", "translate", "gemini-x"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  });

  it("upgrades empty models to curated defaults while preserving a saved model", () => {
    const configWithEmptyProfiles = config.migrate({
      provider: "openai",
      providerSettings: { openai: { model: "" }, deepseek: { model: "my-deepseek" } },
    });
    expect(configWithEmptyProfiles.providerSettings.openai.model).toBe("gpt-6-luna");
    expect(configWithEmptyProfiles.providerSettings.deepseek.model).toBe("my-deepseek");
  });

  it.each([
    ["openai", "https://api.openai.com", "models", "https://api.openai.com/v1/models"],
    ["openai", "https://proxy.example/openai/v1/responses", "translate", "https://proxy.example/openai/v1/responses"],
    ["deepseek", "https://api.deepseek.com", "models", "https://api.deepseek.com/models"],
    ["deepseek", "https://proxy.example/deepseek/v1", "translate", "https://proxy.example/deepseek/v1/chat/completions"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent", "models", "https://generativelanguage.googleapis.com/v1beta/models"],
    ["gemini", "", "translate", "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent"],
    ["google-web", "https://translate.example/translate?client=proxy", "translate", "https://translate.example/translate?client=proxy"],
    ["deepl", "https://api.deepl.com/v2/translate", "usage", "https://api.deepl.com/v2/usage"],
    ["deepl", "https://api-free.deepl.com/v2/usage", "translate", "https://api-free.deepl.com/v2/translate"],
  ])("normalizes %s %s %s endpoint", (provider, endpoint, resource, expected) => {
    expect(config.endpointFor(provider, endpoint, resource, "gemini-x")).toBe(expected);
  });

  it("does not duplicate the Gemini models path for manually entered resource names", () => {
    expect(config.endpointFor("gemini", "", "translate", "models/gemini-x"))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  });

  it.each([
    "http://proxy.example/v1",
    "https://user:pass@proxy.example/v1",
    "https://proxy.example/v1?api_key=secret",
    "https://proxy.example/v1#fragment",
  ])("rejects unsafe custom endpoint %s", (endpoint) => {
    expect(() => config.endpointFor("openai", endpoint, "models")).toThrow();
  });
});
