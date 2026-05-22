const STORAGE_KEY = "echo360TranslatorConfig";
const buildConfig = globalThis.Echo360BuildConfig || {};
const enableLocalBackend = buildConfig.enableLocalBackend !== false;

const defaultConfig = {
  apiKey: "",
  useLocalBackend: false,
  backendUrl: "http://127.0.0.1:8765",
  provider: "google-web",
  model: "",
  endpoint: "",
  target: "ZH",
  maxParagraphs: 6,
  maxChars: 1200,
  concurrency: 96,
  rps: 0,
  retries: 1,
  timeout: 10,
  reasoningEffort: "",
  fallbackMode: "immediate",
  repairConcurrency: 1,
  slowSplitThreshold: 0,
  deepseekThinkingMode: "disabled",
  deeplFormality: "",
};

const modelPresets = [
  { provider: "google-web", model: "", endpoint: "", label: "Google Translate" },
  { provider: "deepseek", model: "deepseek-v4-flash", endpoint: "", label: "DeepSeek - deepseek-v4-flash" },
  { provider: "gemini", model: "gemini-2.5-flash-lite", endpoint: "", label: "Gemini - gemini-2.5-flash-lite" },
  { provider: "openai", model: "gpt-5-nano", endpoint: "", label: "OpenAI - gpt-5-nano" },
  { provider: "deepl", model: "", endpoint: "", label: "DeepL" },
];
const keylessProviders = new Set(["google-web"]);
const providerHints = {
  "google-web": "免费、无需 API Key，适合先试用；质量通常不如 AI/API 模型。",
  deepseek: "需要 DeepSeek API Key，适合更高质量字幕翻译；Thinking 默认关闭。",
  gemini: "需要 Gemini API Key，适合更高质量字幕翻译。",
  openai: "需要 OpenAI API Key，适合更高质量字幕翻译。",
  deepl: "需要 DeepL API Key，适合常规机器翻译。"
};

const extensionApi = globalThis.browser || globalThis.chrome;
const usesPromiseApi = !!globalThis.browser && extensionApi === globalThis.browser;

function storageGet(key) {
  if (usesPromiseApi) return extensionApi.storage.local.get(key);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(key, (result) => {
      const err = extensionApi.runtime?.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve(result);
    });
  });
}

function storageSet(items) {
  if (usesPromiseApi) return extensionApi.storage.local.set(items);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.set(items, () => {
      const err = extensionApi.runtime?.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve();
    });
  });
}

function presetValue(preset) {
  return `${preset.provider}|${preset.model}|${preset.endpoint}`;
}

function findPreset(config) {
  return modelPresets.find((preset) =>
    preset.provider === config.provider &&
    preset.model === (config.model || "") &&
    preset.endpoint === (config.endpoint || "")
  );
}

function ensurePresetOption(config) {
  if (keylessProviders.has(config.provider)) {
    config.model = "";
    config.endpoint = "";
  }
  const existing = findPreset(config);
  if (existing) return existing;
  const provider = config.provider || defaultConfig.provider;
  const model = config.model || "";
  const endpoint = config.endpoint || "";
  const label = model ? `${provider} - ${model}` : provider;
  const custom = { provider, model, endpoint, label };
  modelPresets.push(custom);
  return custom;
}

function renderModelOptions(selectedPreset) {
  const select = document.getElementById("modelPreset");
  select.innerHTML = "";
  for (const preset of modelPresets) {
    const option = document.createElement("option");
    option.value = presetValue(preset);
    option.textContent = preset.label;
    select.appendChild(option);
  }
  select.value = presetValue(selectedPreset);
}

function selectedProvider() {
  return document.getElementById("modelPreset").value.split("|")[0] || defaultConfig.provider;
}

function refreshProviderUi() {
  const provider = selectedProvider();
  const isKeyless = keylessProviders.has(provider);
  const apiKeyEl = document.getElementById("apiKey");
  document.getElementById("providerHint").textContent = providerHints[provider] || "";
  document.getElementById("apiKeyHint").textContent = isKeyless
    ? "Google Translate 不需要 API Key；如果翻译质量不理想，请切换到 AI/API 模型。"
    : "API Key 只保存在 Chrome 本地 storage。";
  apiKeyEl.disabled = isKeyless;
  apiKeyEl.placeholder = isKeyless ? "Google Translate 不需要 API Key" : "请输入你的 API Key";
  if (isKeyless) apiKeyEl.value = "";
}

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  const selectedPreset = ensurePresetOption(config);
  renderModelOptions(selectedPreset);
  document.getElementById("apiKey").value = config.apiKey || "";
  refreshProviderUi();
}

function openOptionsPage() {
  if (extensionApi.runtime?.openOptionsPage) {
    const result = extensionApi.runtime.openOptionsPage();
    if (result && typeof result.catch === "function") result.catch(() => {});
    return;
  }
  extensionApi.tabs?.create?.({ url: extensionApi.runtime.getURL("options.html") });
}

async function saveConfig() {
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");
  saveBtn.disabled = true;
  status.textContent = "";
  status.style.color = "";

  try {
    const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
    const [provider, model, endpoint] = document.getElementById("modelPreset").value.split("|");
    const config = {
      ...defaultConfig,
      ...(value || {}),
      provider,
      model,
      endpoint,
      apiKey: keylessProviders.has(provider) ? "" : document.getElementById("apiKey").value.trim(),
      useLocalBackend: enableLocalBackend && !!(value || {}).useLocalBackend,
    };
    await storageSet({ [STORAGE_KEY]: config });
    status.textContent = "已保存";
    status.style.color = "";
  } catch (err) {
    status.textContent = `保存失败：${err?.message || String(err)}`;
    status.style.color = "#a22";
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById("saveBtn").addEventListener("click", saveConfig);
document.getElementById("optionsBtn").addEventListener("click", openOptionsPage);
document.getElementById("modelPreset").addEventListener("change", refreshProviderUi);
loadConfig().catch((err) => {
  const status = document.getElementById("status");
  status.textContent = `加载失败：${err?.message || String(err)}`;
  status.style.color = "#a22";
});
