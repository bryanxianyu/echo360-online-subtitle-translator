import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { evalModule } from "../helpers/load-module.js";

function popupDom() {
  document.body.innerHTML = `
    <select id="provider"><option value="google-web">Google</option><option value="deepseek">DeepSeek</option><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="deepl">DeepL</option></select>
    <div id="providerHint"></div><input id="apiKey"><div id="apiKeyHint"></div><div id="catalogStatus"></div>
    <div class="provider-model-section"><input id="model" type="hidden"><div id="modelPickerControl"><button id="modelPickerToggle" type="button"><span id="modelPickerValue"></span></button><div id="modelPickerPanel" hidden><input id="modelSearch" type="search"><select id="modelOptions"></select><button id="refreshModels"></button><input id="showIncompatible" type="checkbox"></div></div><input id="customModel" type="text" hidden><input id="customModelEnabled" type="checkbox"></div>
    <div id="testHelp"></div><button id="refreshModels"></button><button id="verifyProvider"></button><div id="verificationStatus"></div>
    <button id="optionsBtn"></button><div id="status"></div><button id="retrySaveBtn" hidden></button>
  `;
}

describe("popup provider and model selection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("crypto", webcrypto);
    popupDom();
    delete globalThis.Echo360ProviderConfig;
    delete globalThis.Echo360ProviderSetup;
    delete globalThis.Echo360ExtensionApi;
  });

  it("switches providers without mixing their keys, models, endpoints or performance profiles", async () => {
    const data = {
      echo360TranslatorConfig: {
        configVersion: 2,
        provider: "openai",
        apiKey: "openai-key",
        apiKeys: { openai: "openai-key", deepseek: "deepseek-key" },
        providerSettings: {
          openai: { model: "openai-old", endpoint: "https://proxy.example/openai/v1", concurrency: 31, rps: 2 },
          deepseek: { model: "deepseek-saved", endpoint: "https://proxy.example/deepseek/v1", concurrency: 77, rps: 0.5 },
        },
        target: "ZH",
        useLocalBackend: false,
      },
    };
    const listeners = [];
    const api = {
      raw: { runtime: { openOptionsPage: vi.fn() } },
      runtime: {
        sendMessage: vi.fn(async (message) => message.type === "provider-cache" ? { ok: true, data: null } : { ok: true }),
      },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: data[key] })),
          set: vi.fn(async (items) => Object.assign(data, items)),
        },
        onChanged: { addListener: (listener) => listeners.push(listener) },
      },
    };
    globalThis.Echo360ExtensionApi = api;
    globalThis.Echo360BuildConfig = { enableLocalBackend: true };
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("popup.js");

    expect(document.getElementById("saveBtn")).toBeNull();
    await vi.waitFor(() => expect(document.getElementById("model").value).toBe("openai-old"));
    expect(document.getElementById("apiKey").value).toBe("openai-key");
    const model = document.getElementById("model");
    model.value = "openai-new-manual";
    model.dispatchEvent(new Event("input", { bubbles: true }));

    const provider = document.getElementById("provider");
    provider.value = "deepseek";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(model.value).toBe("deepseek-saved"));
    expect(document.getElementById("apiKey").value).toBe("deepseek-key");

    await vi.waitFor(() => expect(data.echo360TranslatorConfig.provider).toBe("deepseek"));
    const saved = data.echo360TranslatorConfig;
    expect(saved.apiKeys).toMatchObject({ openai: "openai-key", deepseek: "deepseek-key" });
    expect(saved.providerSettings.openai).toMatchObject({ model: "openai-new-manual", endpoint: "https://proxy.example/openai/v1", concurrency: 31, rps: 2 });
    expect(saved.providerSettings.deepseek).toMatchObject({ model: "deepseek-saved", endpoint: "https://proxy.example/deepseek/v1", concurrency: 77, rps: 0.5 });
    expect(saved.model).toBe("deepseek-saved");
    expect(saved.endpoint).toBe("https://proxy.example/deepseek/v1");
    window.dispatchEvent(new Event("pagehide"));
  });

  it("keeps automatic Key verification but waits for an explicit test after a model change", async () => {
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
      raw: { runtime: { openOptionsPage: vi.fn() } },
      runtime: { sendMessage: vi.fn(async (message) => {
        requests.push(message);
        if (message.type === "provider-cache") return { ok: true, data: null };
        if (message.type === "provider-discover") return { ok: true, data: { models: [
          { id: "gpt-6-luna", eligibility: "unknown" },
          { id: "second-model", eligibility: "unknown" },
        ], fetchedAt: Date.now() } };
        if (message.type === "provider-verify") return { ok: true, data: { verifiedAt: Date.now(), execution: "provider_direct" } };
        return { ok: true };
      }) },
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
    globalThis.Echo360BuildConfig = { enableLocalBackend: true };
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
    evalModule("popup.js");

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
