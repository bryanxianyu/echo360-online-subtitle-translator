import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { evalModule } from "../helpers/load-module.js";

function setupDom() {
  document.body.innerHTML = `
    <select id="provider"><option value="google-web">Google</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="gemini">Gemini</option><option value="deepl">DeepL</option></select>
    <input id="apiKey"><div class="provider-model-section"><input id="model" type="hidden"><div id="modelPickerControl"><button id="modelPickerToggle" type="button"><span id="modelPickerValue"></span></button><div id="modelPickerPanel" hidden><input id="modelSearch" type="search"><select id="modelOptions"></select><button id="refreshModels"></button><input id="showIncompatible" type="checkbox"></div></div><input id="customModel" type="text" hidden><input id="customModelEnabled" type="checkbox"></div>
    <input id="endpoint"><select id="target"><option value="ZH">ZH</option><option value="EN">EN</option></select>
    <div id="catalogStatus"></div><div id="verificationStatus"></div><button id="refreshModels"></button><button id="verifyProvider"></button>
  `;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("provider_setup shared controller", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setupDom();
    vi.stubGlobal("crypto", webcrypto);
    delete globalThis.Echo360ProviderConfig;
    delete globalThis.Echo360ProviderSetup;
    globalThis.Echo360ExtensionApi = {
      runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    };
    evalModule("provider_config.js");
    evalModule("provider_setup.js");
  });

  it("deduplicates concurrent refreshes and drops a slow old-Key catalog response", async () => {
    const requests = [];
    const storage = {};
    const runtime = {
      sendMessage: vi.fn((message) => {
        if (message.type === "provider-cache") return Promise.resolve({ ok: true, data: null });
        if (message.type === "provider-discover") {
          const job = deferred();
          requests.push({ message, ...job });
          return job.promise;
        }
        return Promise.resolve({ ok: true });
      }),
    };
    globalThis.Echo360ExtensionApi.runtime = runtime;
    globalThis.Echo360ExtensionApi.storage.local = {
        get: vi.fn(async (key) => ({ [key]: storage[key] })),
        set: vi.fn(async (items) => Object.assign(storage, items)),
    };
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKey: "key-a", apiKeys: { openai: "key-a" }, providerSettings: { openai: { model: "" } } });

    const oldRequest = setup.refresh(true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const duplicate = setup.refresh(true);
    expect(requests).toHaveLength(1);

    const key = document.getElementById("apiKey");
    key.value = "key-b";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    const newRequest = setup.refresh(true);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1].resolve({ ok: true, data: { models: [{ id: "model-b", eligibility: "unknown" }], fetchedAt: Date.now() } });
    await newRequest;
    expect([...document.getElementById("modelOptions").options].map((item) => item.value)).toContain("model-b");

    requests[0].resolve({ ok: true, data: { models: [{ id: "model-a", eligibility: "unknown" }], fetchedAt: Date.now() } });
    await Promise.all([oldRequest, duplicate]);
    expect([...document.getElementById("modelOptions").options].map((item) => item.value)).toContain("model-b");
    expect([...document.getElementById("modelOptions").options].map((item) => item.value)).not.toContain("model-a");
    setup.destroy();
  });

  it("does not issue a translation verification when only refreshing a model list", async () => {
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
        sent.push(message);
        if (message.type === "provider-cache") return { ok: true, data: null };
        if (message.type === "provider-discover") return { ok: true, data: { models: [{ id: "saved-model", eligibility: "unknown" }], fetchedAt: Date.now() } };
        return { ok: true, data: { verifiedAt: Date.now() } };
      });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, apiKey: "key", model: "saved-model" });
    sent.length = 0;
    await setup.refresh(true, { verifyAfter: false });
    expect(sent.map((message) => message.type)).toEqual(["provider-discover"]);
    expect(document.getElementById("catalogStatus").textContent).toContain("不代表所选模型已可翻译");
    expect(document.getElementById("verificationStatus").textContent).toBe("尚未测试此配置");
    setup.destroy();
  });

  it("keeps a saved model missing from the new catalog and skips automatic translation verification", async () => {
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
      sent.push(message);
      if (message.type === "provider-cache") return { ok: true, data: null };
      if (message.type === "provider-discover") return { ok: true, data: { models: [{ id: "deepseek-flash", eligibility: "unknown" }], fetchedAt: Date.now() } };
      return { ok: true, data: { verifiedAt: Date.now() } };
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({
      provider: "openai",
      apiKeys: { openai: "new-provider-key" },
      providerSettings: { openai: { model: "gpt-6-luna", modelMode: "catalog", catalogModel: "gpt-6-luna" } },
    });

    await setup.refresh(true);

    expect(sent.filter((message) => message.type === "provider-verify")).toHaveLength(0);
    expect(setup.getProfiles().openai).toMatchObject({ model: "gpt-6-luna", catalogModel: "gpt-6-luna" });
    expect(document.getElementById("verificationStatus").textContent).toContain("当前模型未在此服务目录中找到");
    expect([...document.getElementById("modelOptions").options].map((option) => option.value)).toContain("deepseek-flash");
    setup.destroy();
  });

  it("leaves a newly selected model untested until the user requests verification", async () => {
    vi.useFakeTimers();
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
      sent.push(message);
      if (message.type === "provider-cache") return { ok: true, data: null };
      if (message.type === "provider-verify") return { ok: true, data: { verifiedAt: Date.now(), execution: "provider_direct" } };
      return { ok: true, data: null };
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, apiKey: "key" });
    const model = document.getElementById("model");
    model.value = "manual-new-model";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(sent.filter((message) => message.type === "provider-verify")).toHaveLength(0);
    expect(document.getElementById("verificationStatus").textContent).toBe("尚未测试此配置");
    document.getElementById("verifyProvider").click();
    await vi.waitFor(() => expect(sent.filter((message) => message.type === "provider-verify")).toHaveLength(1));
    expect(sent.filter((message) => message.type === "provider-discover")).toHaveLength(0);
    expect(sent.find((message) => message.type === "provider-verify").payload.model).toBe("manual-new-model");
    await vi.waitFor(() => expect(document.getElementById("verificationStatus").textContent).toContain("翻译测试通过"));
    setup.destroy();
    vi.useRealTimers();
  });

  it("does not auto-test a new model when the Key discovery request started for the previous model", async () => {
    const discovery = deferred();
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn((message) => {
      sent.push(message);
      if (message.type === "provider-cache") return Promise.resolve({ ok: true, data: null });
      if (message.type === "provider-discover") return discovery.promise;
      if (message.type === "provider-verify") return Promise.resolve({ ok: true, data: { verifiedAt: Date.now() } });
      return Promise.resolve({ ok: true });
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, providerSettings: { openai: { model: "model-one" } } });

    const oldModelDiscovery = setup.refresh(true);
    await vi.waitFor(() => expect(sent.some((message) => message.type === "provider-discover")).toBe(true));
    const model = document.getElementById("model");
    model.value = "model-two";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    discovery.resolve({ ok: true, data: { models: [{ id: "model-one", eligibility: "unknown" }], fetchedAt: Date.now() } });
    await oldModelDiscovery;

    expect(sent.filter((message) => message.type === "provider-verify")).toHaveLength(0);
    expect(document.getElementById("verificationStatus").textContent).toBe("尚未测试此配置");
    setup.destroy();
  });

  it("drops a translation test result after storage loads a different configuration", async () => {
    const verification = deferred();
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn((message) => {
      sent.push(message);
      if (message.type === "provider-cache") return Promise.resolve({ ok: true, data: null });
      if (message.type === "provider-verify") return verification.promise;
      return Promise.resolve({ ok: true });
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, apiKey: "key", providerSettings: { openai: { model: "model-one" } }, target: "ZH" });
    const oldVerification = setup.verify();
    await vi.waitFor(() => expect(sent.some((message) => message.type === "provider-verify")).toBe(true));
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, apiKey: "key", providerSettings: { openai: { model: "model-two" } }, target: "JA" });
    verification.resolve({ ok: true, data: { verifiedAt: Date.now(), execution: "provider_direct" } });
    await oldVerification;
    expect(document.getElementById("verificationStatus").textContent).toBe("尚未测试此配置");
    expect(document.getElementById("model").value).toBe("model-two");
    setup.destroy();
  });

  it("switches between catalog and custom input while retaining both model values", async () => {
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
      sent.push(message);
      if (message.type === "provider-cache") return { ok: true, data: null };
      if (message.type === "provider-verify") return { ok: true, data: { verifiedAt: Date.now(), execution: "provider_direct" } };
      return { ok: true };
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({
      provider: "openai",
      apiKeys: { openai: "key" },
      providerSettings: { openai: { model: "catalog-a", modelMode: "catalog", catalogModel: "catalog-a", customModel: null } },
    });

    const enabled = document.getElementById("customModelEnabled");
    const select = document.getElementById("modelOptions");
    const custom = document.getElementById("customModel");
    const effective = document.getElementById("model");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("modelPickerControl").hidden).toBe(true);
    expect(document.getElementById("modelPickerPanel").hidden).toBe(true);
    expect(custom.hidden).toBe(false);
    expect(custom.value).toBe("catalog-a");

    custom.value = "custom-b";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(effective.value).toBe("custom-b");
    expect(setup.getProfiles().openai).toMatchObject({ modelMode: "custom", catalogModel: "catalog-a", customModel: "custom-b" });
    await setup.verify();
    expect(sent.find((message) => message.type === "provider-verify").payload.model).toBe("custom-b");
    custom.value = "";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(setup.validateModel()).toBe("请输入模型 ID");
    custom.value = "custom-b";
    custom.dispatchEvent(new Event("input", { bubbles: true }));

    enabled.checked = false;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("modelPickerControl").hidden).toBe(false);
    expect(document.getElementById("modelPickerPanel").hidden).toBe(true);
    expect(custom.hidden).toBe(true);
    expect(effective.value).toBe("catalog-a");
    enabled.checked = true;
    enabled.dispatchEvent(new Event("change", { bubbles: true }));
    expect(custom.value).toBe("custom-b");
    setup.destroy();
  });

  it("keeps the catalog dropdown limited to returned models and preserves models outside the catalog", async () => {
    const models = [
      { id: "future-flash", displayName: "Future Flash", recommended: true, eligibility: "unknown", recommendationReason: "轻量系列，优先试用" },
      { id: "future-pro", displayName: "Future Pro", eligibility: "unknown", recommendationReason: "高能力系列" },
      { id: "chatgpt-image-latest", eligibility: "incompatible", reason: "专用图像生成模型" },
    ];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
      if (message.type === "provider-cache" || message.type === "provider-discover") return { ok: true, data: { models, fetchedAt: Date.now() } };
      return { ok: true };
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, providerSettings: { openai: { model: "" } } });
    await setup.refresh(true, { verifyAfter: false });
    const list = document.getElementById("modelOptions");
    expect(list.options[0].textContent).toBe("请选择模型");
    expect([...list.options].map((option) => option.value)).toContain("future-flash");
    expect(document.getElementById("model").value).toBe("gpt-6-luna");
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, providerSettings: { openai: { model: "future-pro" } } });
    await setup.refresh(true, { verifyAfter: false });
    expect(list.value).toBe("future-pro");
    expect(document.getElementById("model").value).toBe("future-pro");
    expect(document.getElementById("customModelEnabled").checked).toBe(true);
    await setup.load({ provider: "openai", apiKeys: { openai: "key" }, providerSettings: { openai: { model: "chatgpt-image-latest" } } });
    await setup.refresh(true, { verifyAfter: false });
    expect(document.getElementById("customModelEnabled").checked).toBe(true);
    expect([...list.options].find((option) => option.value === "chatgpt-image-latest")?.disabled).toBe(true);
    expect(document.getElementById("model").value).toBe("chatgpt-image-latest");
    const show = document.getElementById("showIncompatible");
    show.checked = true;
    show.dispatchEvent(new Event("change"));
    expect(list.value).toBe("chatgpt-image-latest");
    expect(globalThis.Echo360ExtensionApi.runtime.sendMessage.mock.calls.some(([message]) => message.type === "provider-verify")).toBe(false);
    setup.destroy();
  });

  it("filters catalog models without changing configuration until a result is selected", async () => {
    const models = [
      { id: "future-flash", displayName: "Future Flash", eligibility: "unknown" },
      { id: "future-pro", displayName: "Future Pro", eligibility: "unknown" },
      { id: "nova-zh", displayName: "星河模型", eligibility: "unknown" },
    ];
    const sent = [];
    globalThis.Echo360ExtensionApi.runtime.sendMessage = vi.fn(async (message) => {
      sent.push(message);
      if (message.type === "provider-cache" || message.type === "provider-discover") return { ok: true, data: { models, fetchedAt: Date.now() } };
      return { ok: true };
    });
    const setup = globalThis.Echo360ProviderSetup.mount({
      elements: Object.fromEntries(["provider", "apiKey", "model", "modelPickerControl", "modelPickerToggle", "modelPickerPanel", "modelPickerValue", "modelSearch", "modelOptions", "customModelEnabled", "customModel", "endpoint", "target", "catalogStatus", "verificationStatus", "refreshModels", "verifyProvider", "showIncompatible"].map((id) => [id, document.getElementById(id)])),
    });
    await setup.load({
      provider: "openai",
      apiKeys: { openai: "key" },
      providerSettings: { openai: { model: "future-flash", modelMode: "catalog", catalogModel: "future-flash" } },
    });
    await setup.refresh(true, { verifyAfter: false });
    sent.length = 0;

    const toggle = document.getElementById("modelPickerToggle");
    const panel = document.getElementById("modelPickerPanel");
    const search = document.getElementById("modelSearch");
    const list = document.getElementById("modelOptions");
    const effective = document.getElementById("model");
    toggle.click();
    expect(panel.hidden).toBe(false);
    search.value = "future pro";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...list.options].map((option) => option.value)).toContain("future-pro");
    expect([...list.options].map((option) => option.value)).not.toContain("future-flash");
    expect(effective.value).toBe("future-flash");
    expect(setup.getProfiles().openai.catalogModel).toBe("future-flash");
    expect(sent.some((message) => message.type === "provider-verify")).toBe(false);

    search.value = "星河";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...list.options].map((option) => option.value)).toContain("nova-zh");
    expect([...list.options].map((option) => option.value)).not.toContain("future-flash");

    search.value = "future pro";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    list.value = "future-pro";
    list.dispatchEvent(new Event("change", { bubbles: true }));
    expect(effective.value).toBe("future-pro");
    expect(setup.getProfiles().openai.catalogModel).toBe("future-pro");
    expect(panel.hidden).toBe(true);
    setup.destroy();
  });
});
