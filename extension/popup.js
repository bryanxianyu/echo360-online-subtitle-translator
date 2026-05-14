const STORAGE_KEY = "echo360TranslatorConfig";

const defaultConfig = {
  apiKey: "",
  useLocalBackend: false,
  backendUrl: "http://127.0.0.1:8765",
  provider: "deepseek",
  model: "deepseek-v4-flash",
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
  deepseekThinkingMode: "omit",
  deeplFormality: "",
};

const modelPresets = [
  { provider: "deepseek", model: "deepseek-v4-flash", endpoint: "", label: "DeepSeek - deepseek-v4-flash" },
  { provider: "gemini", model: "gemini-2.5-flash-lite", endpoint: "", label: "Gemini - gemini-2.5-flash-lite" },
  { provider: "openai", model: "gpt-5-nano", endpoint: "", label: "OpenAI - gpt-5-nano" },
  { provider: "deepl", model: "", endpoint: "", label: "DeepL" },
];

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

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  const selectedPreset = ensurePresetOption(config);
  renderModelOptions(selectedPreset);
  document.getElementById("apiKey").value = config.apiKey || "";
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
      apiKey: document.getElementById("apiKey").value.trim(),
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
loadConfig().catch((err) => {
  const status = document.getElementById("status");
  status.textContent = `加载失败：${err?.message || String(err)}`;
  status.style.color = "#a22";
});
