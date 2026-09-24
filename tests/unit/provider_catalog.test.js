import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] || headers[name.toLowerCase()] || null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("provider_catalog", () => {
  let catalog;
  let local;
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete globalThis.Echo360ProviderConfig;
    evalModule("provider_config.js");
    local = { echo360ProviderModelCatalogs: {} };
    globalThis.Echo360ExtensionApi = {
      storage: { local: {
        get: vi.fn(async (key) => ({ [key]: local[key] })),
        set: vi.fn(async (value) => Object.assign(local, value)),
      } },
    };
    globalThis.fetch = vi.fn();
    evalModule("provider_catalog.js");
    catalog = globalThis.Echo360ProviderCatalog;
  });

  it("keeps unknown models as candidates and removes only clear non-text models", () => {
    const models = catalog.normalizeModels("openai", [
      { id: "new-future-model" },
      { id: "text-embedding-latest" },
      { id: "gpt-image-and-text-preview" },
      { id: "gpt-realtime" },
      { id: "gpt-4o-audio-preview" },
      { id: "new-future-model" },
    ]);
    expect(models).toHaveLength(5);
    const byId = Object.fromEntries(models.map((model) => [model.id, model.eligibility]));
    expect(byId).toEqual({ "gpt-4o-audio-preview": "incompatible", "gpt-image-and-text-preview": "unknown", "gpt-realtime": "incompatible", "new-future-model": "unknown", "text-embedding-latest": "incompatible" });
  });

  it.each(["openai", "deepseek", "gemini"])("applies the same task filter to %s, including proxy model IDs", (provider) => {
    const hidden = ["chatgpt-image-latest", "vendor/gpt-image-1", "dall-e-3", "imagen-4", "veo-3", "sora-2", "gpt-realtime", "voice-tts", "rank-reranker", "omni-moderation-latest", "gemini-2.5-flash-image", "gemini-2.5-flash-native-audio-preview"];
    const kept = ["future-model", "vision-language-flash", "audio-text-general", "image-understanding-mini", "gemini-future-image-understanding", "speechwriter", "my-template"];
    const models = catalog.normalizeModels(provider, [...hidden, ...kept].map((id) => ({ id, supportedGenerationMethods: ["generateContent"] })));
    for (const id of hidden) expect(models.find((model) => model.id === id).eligibility, id).toBe("incompatible");
    for (const id of kept) expect(models.find((model) => model.id === id).eligibility, id).not.toBe("incompatible");
    expect(models.filter((model) => model.recommended).every((model) => !hidden.includes(model.id))).toBe(true);
  });

  it("uses capability evidence before ranking and retains multimodal text models", () => {
    const models = catalog.normalizeModels("openai", [
      { id: "future-flash", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
      { id: "new-luna", supported_endpoints: ["/v1/chat/completions"] },
      { id: "unknown-multimodal", architecture: { input_modalities: ["image", "text", "audio"], output_modalities: ["text", "audio"] }, supported_endpoints: ["/v1/responses"] },
      { id: "unlisted-new-model" },
    ]);
    expect(models.find((model) => model.id === "future-flash")).toMatchObject({ eligibility: "incompatible", recommended: false });
    expect(models.find((model) => model.id === "new-luna")).toMatchObject({ eligibility: "incompatible", recommended: false });
    expect(models.find((model) => model.id === "unknown-multimodal").eligibility).toBe("candidate");
    expect(models.find((model) => model.id === "unlisted-new-model").eligibility).toBe("unknown");
    expect(catalog.normalizeModels("gemini", [{ id: "future-flash", supportedGenerationMethods: ["embedContent"] }])[0].eligibility).toBe("incompatible");
    // Empty or absent capability lists do not prove incompatibility.
    expect(catalog.normalizeModels("gemini", [{ id: "new-model", supportedGenerationMethods: [] }])[0].eligibility).toBe("unknown");
  });

  it("filters OpenAI endpoint capability using the protocol inferred from its endpoint", () => {
    const rows = [
      { id: "response-model", supported_endpoints: ["/v1/responses"] },
      { id: "chat-model", supported_endpoints: ["/v1/chat/completions"] },
      { id: "unknown-model" },
    ];
    const responses = Object.fromEntries(catalog.normalizeModels("openai", rows, "https://proxy.example/v1").map((model) => [model.id, model.eligibility]));
    const chat = Object.fromEntries(catalog.normalizeModels("openai", rows, "https://proxy.example/v1/chat/completions").map((model) => [model.id, model.eligibility]));
    expect(responses).toEqual({ "chat-model": "incompatible", "response-model": "candidate", "unknown-model": "unknown" });
    expect(chat).toEqual({ "chat-model": "candidate", "response-model": "incompatible", "unknown-model": "unknown" });
  });

  it.each([
    ["openai", "gpt-6-luna", "gpt-4.1-mini"],
    ["deepseek", "deepseek-flash", "deepseek-v4-pro"],
    ["gemini", "gemini-3.5-flash-lite", "gemini-3.5-flash"],
  ])("ranks only the curated %s model first when the account returns it", (provider, chosen, other) => {
    const rows = [{ id: other }, { id: chosen }];
    const models = catalog.normalizeModels(provider, rows);
    expect(models.map((model) => model.id)).toEqual([chosen, other]);
    expect(models[0]).toMatchObject({ recommended: true, eligibility: "unknown", recommendationSource: expect.stringMatching(/^https:/) });
    expect(models[1].recommended).toBe(false);
    expect(catalog.normalizeModels(provider, rows.reverse())).toEqual(models);
  });

  it("does not guess recommendations from names when the curated model is absent", () => {
    const ids = ["future-mini", "future-mini-preview", "codex-mini", "thinking-flash", "flash-pro", "tts-mini", "future-neutral"];
    const models = catalog.normalizeModels("openai", ids.map((id) => ({ id })));
    expect(models.map((model) => model.id)).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(models.filter((model) => model.recommended)).toEqual([]);
    expect(models.some((model) => model.id === "future-neutral")).toBe(true);
  });

  it("re-evaluates legacy cached models without fetching or changing their timestamp", async () => {
    vi.stubGlobal("chrome", { runtime: { id: "extension-id", getURL: (page) => `chrome-extension://extension-id/${page}` } });
    const payload = { provider: "gemini", apiKey: "key" };
    const id = await catalog.cacheId("gemini", "", "key");
    local.echo360ProviderModelCatalogs[id] = { fetchedAt: 123, models: [
      { id: "chatgpt-image-latest", eligibility: "unknown" },
      { id: "future-flash", supportedMethods: ["generateContent"] },
      { id: "gemini-3.5-flash-lite", supportedMethods: ["generateContent"] },
      { id: "future-pro", supportedMethods: ["embedContent"] },
    ] };
    const result = await catalog.handleMessage({ type: "provider-cache", payload }, { id: "extension-id", url: "chrome-extension://extension-id/popup.html" });
    expect(result.data.fetchedAt).toBe(123);
    expect(result.data.models[0]).toMatchObject({ id: "gemini-3.5-flash-lite", recommended: true, eligibility: "candidate" });
    expect(result.data.models.find((model) => model.id === "future-flash")).toMatchObject({ recommended: false, eligibility: "candidate" });
    expect(result.data.models.find((model) => model.id === "future-pro").eligibility).toBe("incompatible");
    // A new cache roundtrip must retain evidence and reproduce the same policy.
    expect(catalog.normalizeModels("gemini", result.data.models)).toEqual(result.data.models);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("loads every Gemini page, normalizes model IDs, and removes duplicates", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-one-001", baseModelId: "gemini-one", displayName: "Gemini One", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-one" }, { name: "models/gemini-two", supportedGenerationMethods: ["generateContent"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const models = await catalog.listModels("gemini", "", "test-key", new AbortController().signal);
    expect(models.map((item) => item.id)).toEqual(["gemini-one", "gemini-two"]);
    expect(models[0].eligibility).toBe("candidate");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("pageSize=1000");
    expect(fetchMock.mock.calls[1][0]).toContain("pageToken=next");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "x-goog-api-key": "test-key" });
  });

  it("rejects a repeated Gemini page token rather than looping", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ models: [], nextPageToken: "same" })));
    await expect(catalog.listModels("gemini", "", "key", new AbortController().signal)).rejects.toThrow("重复 token");
  });

  it("uses provider-specific model routes and bearer authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "new-model" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await catalog.listModels("openai", "", "openai-secret", new AbortController().signal);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer openai-secret");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
  });

  it.each([
    [401, "invalid_key", "bad credential"],
    [403, "permission_denied", "access forbidden"],
    [429, "rate_limited", "rate limit reached"],
    [429, "quota_exceeded", "insufficient_quota"],
  ])("returns a structured, redacted error for HTTP %i", async (status, category, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: `${message}: secret-key` } }, status, { "Retry-After": "7" })));
    await expect(catalog.listModels("openai", "", "secret-key", new AbortController().signal)).rejects.toMatchObject({
      category,
      httpStatus: status,
      message: expect.not.stringContaining("secret-key"),
      ...(status === 429 ? { retryAfterSeconds: 7 } : {}),
    });
  });

  it("rejects non-JSON model-list responses as invalid responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("<html>not json</html>")));
    await expect(catalog.listModels("openai", "", "key", new AbortController().signal)).rejects.toMatchObject({ category: "invalid_response" });
  });

  it("classifies authorization, quota, rate, timeout and discovery errors separately", () => {
    expect(catalog.classifyError(401)).toBe("invalid_key");
    expect(catalog.classifyError(403, "insufficient balance")).toBe("quota_exceeded");
    expect(catalog.classifyError(403, "not permitted")).toBe("permission_denied");
    expect(catalog.classifyError(429, "rate limit")).toBe("rate_limited");
    expect(catalog.classifyError(429, "insufficient_quota")).toBe("quota_exceeded");
    expect(catalog.classifyError(408)).toBe("timeout");
    expect(catalog.classifyError(404)).toBe("model_unavailable");
  });

  it("isolates cached model directories by provider, endpoint and key without storing the key", async () => {
    const a = await catalog.cacheId("openai", "", "key-a");
    const b = await catalog.cacheId("openai", "", "key-b");
    const c = await catalog.cacheId("openai", "https://proxy.example/v1", "key-a");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(JSON.stringify(local)).not.toContain("key-a");
  });

  it("rejects diagnostics from content scripts and preserves explicit permission failures", async () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "extension-id", getURL: (page) => `chrome-extension://extension-id/${page}` },
      permissions: { contains: (_request, callback) => callback(false) },
    });
    const deniedSender = { id: "extension-id", url: "https://echo360.org/lesson/1", frameId: 0 };
    const denied = await catalog.handleMessage({ type: "provider-discover", payload: { provider: "openai", apiKey: "key" } }, deniedSender);
    expect(denied.error.category).toBe("permission_denied");

    const uiSender = { id: "extension-id", url: "chrome-extension://extension-id/options.html", frameId: 0 };
    const permission = await catalog.handleMessage({ type: "provider-discover", requestId: "r1", payload: { provider: "openai", apiKey: "key" } }, uiSender);
    expect(permission.error.category).toBe("host_permission_required");
    expect(permission.error.message).toContain("刷新模型");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accepts the top-level popup when Chrome omits its optional frameId", async () => {
    vi.stubGlobal("chrome", {
      runtime: { id: "extension-id", getURL: (page) => `chrome-extension://extension-id/${page}` },
      permissions: { contains: (_request, callback) => callback(true) },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "popup-visible-model" }] }));
    const popupSender = {
      id: "extension-id",
      url: "chrome-extension://extension-id/popup.html",
      documentId: "popup-document",
    };
    const result = await catalog.handleMessage({
      type: "provider-discover",
      requestId: "popup-request",
      payload: { provider: "openai", apiKey: "key" },
    }, popupSender);
    expect(result.ok).toBe(true);
    expect(result.data.models).toMatchObject([{ id: "popup-visible-model" }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
