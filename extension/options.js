const STORAGE_KEY = "echo360TranslatorConfig";
const extensionApi = window.Echo360ExtensionApi;

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
  deeplFormality: ""
};

const providerDefaults = {
  openai: { model: "gpt-5-nano", endpoint: "" },
  deepseek: { model: "deepseek-v4-flash", endpoint: "" },
  gemini: { model: "gemini-2.5-flash-lite", endpoint: "" },
  deepl: { model: "", endpoint: "" }
};

const knownDefaultModels = new Set(Object.values(providerDefaults).map((item) => item.model).filter(Boolean));

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  document.getElementById("useLocalBackend").checked = !!config.useLocalBackend;
  document.getElementById("backendUrl").value = config.backendUrl;
  document.getElementById("apiKey").value = config.apiKey;
  document.getElementById("provider").value = config.provider;
  document.getElementById("model").value = config.model;
  document.getElementById("endpoint").value = config.endpoint || "";
  const targetEl = document.getElementById("target");
  const targetValue = (config.target || "ZH").toUpperCase();
  if ([...targetEl.options].some((o) => o.value === targetValue)) {
    targetEl.value = targetValue;
  } else {
    targetEl.value = "ZH";
  }
  document.getElementById("maxParagraphs").value = String(config.maxParagraphs);
  document.getElementById("maxChars").value = String(config.maxChars);
  document.getElementById("concurrency").value = String(config.concurrency);
  document.getElementById("rps").value = String(config.rps);
  document.getElementById("retries").value = String(config.retries);
  document.getElementById("timeout").value = String(config.timeout);
  document.getElementById("reasoningEffort").value = config.reasoningEffort || "";
  document.getElementById("fallbackMode").value = config.fallbackMode || "immediate";
  document.getElementById("repairConcurrency").value = String(config.repairConcurrency || 1);
  document.getElementById("slowSplitThreshold").value = String(config.slowSplitThreshold || 0);
  document.getElementById("deepseekThinkingMode").value = config.deepseekThinkingMode || "omit";
  document.getElementById("deeplFormality").value = config.deeplFormality || "";
}

function applyProviderDefaults() {
  const provider = document.getElementById("provider").value;
  const defaults = providerDefaults[provider] || providerDefaults.deepseek;
  const modelEl = document.getElementById("model");
  const endpointEl = document.getElementById("endpoint");
  if (!modelEl.value.trim() || knownDefaultModels.has(modelEl.value.trim())) {
    modelEl.value = defaults.model;
  }
  if (!endpointEl.value.trim()) {
    endpointEl.value = defaults.endpoint;
  }
}

function isLocalBackendUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function saveConfig() {
  const useLocalBackend = document.getElementById("useLocalBackend").checked;
  const rawBackendUrl = document.getElementById("backendUrl").value.trim() || defaultConfig.backendUrl;
  if (useLocalBackend && !isLocalBackendUrl(rawBackendUrl)) {
    const status = document.getElementById("status");
    status.textContent = "错误：Backend 地址只允许 localhost 或 127.0.0.1";
    status.style.color = "red";
    setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
    return;
  }
  const config = {
    useLocalBackend,
    backendUrl: rawBackendUrl,
    apiKey: document.getElementById("apiKey").value.trim(),
    provider: document.getElementById("provider").value,
    model: document.getElementById("model").value.trim(),
    endpoint: document.getElementById("endpoint").value.trim(),
    target: (document.getElementById("target").value || "ZH").toUpperCase(),
    maxParagraphs: Math.max(1, Number(document.getElementById("maxParagraphs").value) || 6),
    maxChars: Math.max(100, Number(document.getElementById("maxChars").value) || 1200),
    concurrency: Math.max(1, Number(document.getElementById("concurrency").value) || 96),
    rps: Math.max(0, Number(document.getElementById("rps").value) || 0),
    retries: Math.max(0, Number(document.getElementById("retries").value) || 1),
    timeout: Math.max(1, Number(document.getElementById("timeout").value) || 10),
    reasoningEffort: document.getElementById("reasoningEffort").value || "",
    fallbackMode: document.getElementById("fallbackMode").value || "immediate",
    repairConcurrency: Math.max(1, Number(document.getElementById("repairConcurrency").value) || 1),
    slowSplitThreshold: Math.max(0, Number(document.getElementById("slowSplitThreshold").value) || 0),
    deepseekThinkingMode: document.getElementById("deepseekThinkingMode").value || "omit",
    deeplFormality: document.getElementById("deeplFormality").value || ""
  };
  await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  const status = document.getElementById("status");
  status.textContent = "已保存";
  setTimeout(() => {
    status.textContent = "";
  }, 1200);
}

document.getElementById("provider").addEventListener("change", applyProviderDefaults);
document.getElementById("saveBtn").addEventListener("click", saveConfig);
loadConfig();
