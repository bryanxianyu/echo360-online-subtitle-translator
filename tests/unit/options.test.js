import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function optionsDom(includePerformanceControls = false) {
  const performance = includePerformanceControls ? `
    <input id="maxParagraphs"><input id="maxChars"><input id="concurrency"><input id="rps"><input id="retries"><input id="timeout">
    <select id="fallbackMode"><option value="immediate">immediate</option><option value="after-repair">after-repair</option><option value="off">off</option></select><input id="repairConcurrency"><input id="slowSplitThreshold">` : "";
  document.body.innerHTML = `
    <div id="status"></div><button id="retrySaveBtn" hidden></button><div id="providerHint"></div><div id="apiKeyHint"></div>
    <select id="provider"><option value="google-web">Google</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="gemini">Gemini</option><option value="deepl">DeepL</option></select>
    <input id="apiKey"><input id="model"><input id="endpoint"><div id="endpointHint"></div><select id="openaiApiProtocol"><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></select><input id="modelSearch"><select id="modelOptions"></select><input id="showIncompatible" type="checkbox">
    <select id="target"><option value="ZH">ZH</option><option value="JA">JA</option></select>
    <div id="catalogStatus"></div><div id="verificationStatus"></div><button id="refreshModels"></button><button id="verifyProvider"></button>
    <input id="useLocalBackend" type="checkbox"><div id="localBackendSection"><input id="backendUrl"></div>
    <select id="appearance"><option value="auto">auto</option><option value="dark">dark</option><option value="light">light</option></select>
    <div class="provider-model-section"><span></span></div><div data-provider-advanced="openai"></div><div data-provider-advanced="deepseek"></div><div data-provider-advanced="deepl"></div><div id="advancedEmptyHint"></div>
    <input id="reasoningEffort"><input id="deepseekThinkingMode"><input id="deeplFormality">${performance}<button id="resetAdvancedBtn" disabled></button><div id="resetAdvancedStatus"></div><button id="undoAdvancedResetBtn" hidden></button>
  `;
}

describe("options configuration persistence", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    delete globalThis.Echo360ProviderConfig;
    delete globalThis.Echo360ProviderSetup;
  });

  it("keeps stored per-provider performance values when store UI omits those controls", async () => {
    optionsDom(false);
    const initial = {
      configVersion: 2,
      provider: "openai",
      apiKeys: { openai: "openai-key", deepseek: "deepseek-key" },
      providerSettings: {
        openai: { model: "openai-manual", endpoint: "https://proxy.example/openai/v1", reasoningEffort: "high", concurrency: 37, rps: 2.5, maxParagraphs: 9, maxChars: 900, retries: 2, timeout: 27, fallbackMode: "after-repair", repairConcurrency: 3, slowSplitThreshold: 1.5 },
        deepseek: { model: "deepseek-manual", endpoint: "https://proxy.example/deepseek/v1", concurrency: 81, rps: 0.5, maxParagraphs: 5, maxChars: 700, retries: 1, timeout: 19 },
      },
      target: "JA",
      apiKey: "openai-key",
      useLocalBackend: false,
    };
    const data = { echo360TranslatorConfig: initial };
    const listeners = [];
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => Object.assign(data, items)),
        },
        onChanged: { addListener: (listener) => listeners.push(listener) },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "store", enableLocalBackend: false };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("openai-manual"));
    expect(document.getElementById("saveBtn")).toBeNull();
    expect(document.getElementById("concurrency")).toBeNull();
    expect(document.getElementById("endpoint").placeholder).toBe("https://api.openai.com/v1");
    expect(document.getElementById("openaiApiProtocol").value).toBe("responses");
    expect(document.getElementById("resetAdvancedBtn").disabled).toBe(false);
    document.getElementById("endpoint").value = "https://proxy.example/v1/chat/completions";
    document.getElementById("endpoint").dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.getElementById("endpointHint").classList.contains("error")).toBe(false);
    document.getElementById("openaiApiProtocol").value = "chat-completions";
    document.getElementById("openaiApiProtocol").dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("resetAdvancedBtn").click();
    expect(document.getElementById("endpoint").value).toBe("");
    expect(document.getElementById("openaiApiProtocol").value).toBe("responses");
    expect(document.getElementById("reasoningEffort").value).toBe("");
    expect(document.getElementById("resetAdvancedBtn").disabled).toBe(true);
    expect(document.getElementById("resetAdvancedStatus").textContent).toContain("高级参数已恢复默认");
    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai.endpoint).toBe(""));
    const saved = data.echo360TranslatorConfig;
    expect(saved.providerSettings.openai).toMatchObject({ model: "openai-manual", endpoint: "", openaiApiProtocol: "responses", reasoningEffort: "", concurrency: 37, rps: 2.5, maxParagraphs: 9, maxChars: 900, retries: 2, timeout: 27, fallbackMode: "after-repair", repairConcurrency: 3, slowSplitThreshold: 1.5 });
    expect(saved.apiKeys.openai).toBe("openai-key");
    expect(api.runtime.sendMessage.mock.calls.some(([message]) => ["provider-discover", "provider-verify"].includes(message.type))).toBe(false);
    expect(saved.providerSettings.deepseek).toMatchObject({ model: "deepseek-manual", endpoint: "https://proxy.example/deepseek/v1", concurrency: 81, rps: 0.5, maxParagraphs: 5, maxChars: 700, retries: 1, timeout: 19 });
    expect(saved.target).toBe("JA");
    window.dispatchEvent(new Event("pagehide"));
  });

  it("restores all advanced values in a dev build while keeping the model and key", async () => {
    optionsDom(true);
    const data = { echo360TranslatorConfig: {
      provider: "openai",
      apiKeys: { openai: "keep-this-key" },
      providerSettings: { openai: {
        model: "custom-model-id", modelMode: "custom", customModel: "custom-model-id", catalogModel: "gpt-6-luna",
        endpoint: "https://proxy.example/openai/v1", reasoningEffort: "high",
        maxParagraphs: 12, maxChars: 750, concurrency: 23, rps: 3, retries: 4, timeout: 28,
        fallbackMode: "after-repair", repairConcurrency: 5, slowSplitThreshold: 1.5,
      } },
    } };
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => Object.assign(data, items)),
        },
        onChanged: { addListener: vi.fn() },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "dev", enableLocalBackend: true };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("custom-model-id"));
    document.getElementById("resetAdvancedBtn").click();
    expect(document.getElementById("endpoint").value).toBe("");
    expect(document.getElementById("reasoningEffort").value).toBe("");
    expect(document.getElementById("maxParagraphs").value).toBe("6");
    expect(document.getElementById("maxChars").value).toBe("1200");
    expect(document.getElementById("concurrency").value).toBe("96");
    expect(document.getElementById("rps").value).toBe("0");
    expect(document.getElementById("retries").value).toBe("1");
    expect(document.getElementById("timeout").value).toBe("10");
    expect(document.getElementById("fallbackMode").value).toBe("immediate");
    expect(document.getElementById("repairConcurrency").value).toBe("1");
    expect(document.getElementById("slowSplitThreshold").value).toBe("0");
    expect(api.runtime.sendMessage.mock.calls.some(([message]) => ["provider-discover", "provider-verify"].includes(message.type))).toBe(false);

    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai.concurrency).toBe(96));
    expect(data.echo360TranslatorConfig.apiKeys.openai).toBe("keep-this-key");
    expect(data.echo360TranslatorConfig.providerSettings.openai).toMatchObject({
      model: "custom-model-id", modelMode: "custom", customModel: "custom-model-id", catalogModel: "gpt-6-luna",
      endpoint: "", reasoningEffort: "", maxParagraphs: 6, maxChars: 1200, concurrency: 96,
      rps: 0, retries: 1, timeout: 10, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0,
    });
    expect(document.getElementById("undoAdvancedResetBtn").hidden).toBe(false);
    document.getElementById("undoAdvancedResetBtn").click();
    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai).toMatchObject({
      endpoint: "https://proxy.example/openai/v1", reasoningEffort: "high", maxParagraphs: 12, maxChars: 750, concurrency: 23,
      rps: 3, retries: 4, timeout: 28, fallbackMode: "after-repair", repairConcurrency: 5, slowSplitThreshold: 1.5,
    }), { timeout: 3000 });
    window.dispatchEvent(new Event("pagehide"));
  });

  it("captures the old profile before the shared setup controller switches fields", async () => {
    optionsDom(true);
    const data = {
      echo360TranslatorConfig: {
        configVersion: 2,
        provider: "openai",
        apiKey: "openai-key",
        apiKeys: { openai: "openai-key", deepseek: "deepseek-key" },
        providerSettings: {
          openai: { model: "openai-original", endpoint: "https://proxy.example/openai/v1", concurrency: 31, rps: 2 },
          deepseek: { model: "deepseek-saved", endpoint: "https://proxy.example/deepseek/v1", concurrency: 77, rps: 0.5 },
        },
        target: "ZH",
      },
    };
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => Object.assign(data, items)),
        },
        onChanged: { addListener: vi.fn() },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "dev", enableLocalBackend: true };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("openai-original"));
    document.getElementById("model").value = "openai-edited";
    document.getElementById("model").dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("endpoint").value = "https://proxy.example/openai-custom/v1";
    document.getElementById("endpoint").dispatchEvent(new Event("input", { bubbles: true }));

    const provider = document.getElementById("provider");
    provider.value = "deepseek";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("model").value).toBe("deepseek-saved");
    expect(document.getElementById("endpoint").value).toBe("https://proxy.example/deepseek/v1");

    await vi.waitFor(() => expect(data.echo360TranslatorConfig.provider).toBe("deepseek"));
    expect(data.echo360TranslatorConfig.providerSettings.openai).toMatchObject({ model: "openai-edited", endpoint: "https://proxy.example/openai-custom/v1", concurrency: 31, rps: 2 });
    expect(data.echo360TranslatorConfig.providerSettings.deepseek).toMatchObject({ model: "deepseek-saved", endpoint: "https://proxy.example/deepseek/v1", concurrency: 77, rps: 0.5 });
    window.dispatchEvent(new Event("pagehide"));
  });

  it("auto-saves edits made during an in-flight write without reverting the newer value", async () => {
    optionsDom(false);
    const data = { echo360TranslatorConfig: {
      configVersion: 3,
      provider: "openai",
      apiKeys: { openai: "key" },
      providerSettings: { openai: { model: "gpt-6-luna", endpoint: "" } },
    } };
    let releaseFirstWrite;
    let firstWriteStarted;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const started = new Promise((resolve) => { firstWriteStarted = resolve; });
    let writes = 0;
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => {
            writes += 1;
            if (writes === 1) {
              firstWriteStarted();
              await firstWriteGate;
            }
            Object.assign(data, items);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "dev", enableLocalBackend: true };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("gpt-6-luna"));
    const endpoint = document.getElementById("endpoint");
    endpoint.value = "https://first.example/v1";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    await started;

    endpoint.value = "https://second.example/v1";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    releaseFirstWrite();
    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai.endpoint).toBe("https://second.example/v1"), { timeout: 4000 });
    expect(writes).toBe(2);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("shows a retry action after an automatic save fails", async () => {
    optionsDom(false);
    const data = { echo360TranslatorConfig: {
      configVersion: 3,
      provider: "openai",
      apiKeys: { openai: "key" },
      providerSettings: { openai: { model: "gpt-6-luna", endpoint: "" } },
    } };
    let failWrites = true;
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => {
            if (failWrites) throw new Error("storage unavailable");
            Object.assign(data, items);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "dev", enableLocalBackend: true };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("gpt-6-luna"));
    const endpoint = document.getElementById("endpoint");
    endpoint.value = "https://proxy.example/v1";
    endpoint.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(document.getElementById("retrySaveBtn").hidden).toBe(false), { timeout: 3000 });
    expect(document.getElementById("status").textContent).toContain("storage unavailable");

    failWrites = false;
    document.getElementById("retrySaveBtn").click();
    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai.endpoint).toBe("https://proxy.example/v1"));
    expect(document.getElementById("retrySaveBtn").hidden).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
  });

  it("auto-verifies once after Key entry, but model changes only save and keep the untested status", async () => {
    optionsDom(false);
    const data = { echo360TranslatorConfig: {
      configVersion: 3,
      provider: "openai",
      apiKeys: { openai: "" },
      providerSettings: { openai: { model: "gpt-6-luna", endpoint: "" } },
      target: "ZH",
      useLocalBackend: false,
    } };
    const listeners = [];
    const requests = [];
    const api = {
      runtime: { sendMessage: vi.fn(async (message) => {
        requests.push(message);
        if (message.type === "provider-cache") return { ok: true, data: null };
        if (message.type === "provider-discover") return { ok: true, data: { models: [
          { id: "gpt-6-luna", eligibility: "unknown" },
          { id: "second-model", eligibility: "unknown" },
        ], fetchedAt: Date.now() } };
        if (message.type === "provider-verify") return { ok: true, data: { verifiedAt: Date.now(), execution: "provider_direct" } };
        return { ok: true };
      }), getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => {
            await new Promise((resolve) => setTimeout(resolve, 900));
            const changes = {};
            for (const [key, value] of Object.entries(items)) {
              changes[key] = { oldValue: data[key], newValue: value };
              data[key] = value;
            }
            listeners.forEach((listener) => listener(changes, "local"));
          }),
        },
        onChanged: { addListener: (listener) => listeners.push(listener) },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    window.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { buildTarget: "dev", enableLocalBackend: true };
    window.Echo360BuildConfig = globalThis.Echo360BuildConfig;
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("options.js");

    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("gpt-6-luna"));
    const apiKey = document.getElementById("apiKey");
    apiKey.focus();
    apiKey.value = "mock-key";
    apiKey.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(requests.filter((message) => message.type === "provider-verify")).toHaveLength(1), { timeout: 4000 });
    expect(document.getElementById("verificationStatus").textContent).toContain("翻译测试通过");

    const modelOptions = document.getElementById("modelOptions");
    modelOptions.value = "second-model";
    modelOptions.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(data.echo360TranslatorConfig.providerSettings.openai.model).toBe("second-model"), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(requests.filter((message) => message.type === "provider-verify")).toHaveLength(1);
    expect(document.getElementById("verificationStatus").textContent).toBe("尚未测试此配置");

    document.getElementById("verifyProvider").click();
    await vi.waitFor(() => expect(requests.filter((message) => message.type === "provider-verify")).toHaveLength(2));
    await vi.waitFor(() => expect(document.getElementById("verificationStatus").textContent).toContain("翻译测试通过"));
    window.dispatchEvent(new Event("pagehide"));
  });
});
