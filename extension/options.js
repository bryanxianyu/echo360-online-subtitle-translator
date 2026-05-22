const STORAGE_KEY = "echo360TranslatorConfig";
const extensionApi = window.Echo360ExtensionApi;
const buildConfig = window.Echo360BuildConfig || {};
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
  deeplFormality: ""
};

const providerDefaults = {
  "google-web": { model: "", endpoint: "" },
  openai: { model: "gpt-5-nano", endpoint: "" },
  deepseek: { model: "deepseek-v4-flash", endpoint: "" },
  gemini: { model: "gemini-2.5-flash-lite", endpoint: "" },
  deepl: { model: "", endpoint: "" }
};
const keylessProviders = new Set(["google-web"]);

const knownDefaultModels = new Set(Object.values(providerDefaults).map((item) => item.model).filter(Boolean));
const providerHints = {
  "google-web": "免费且无需 API Key，适合首次试用和低门槛使用；翻译质量通常不如专用 AI/API 模型。",
  deepseek: "需要你自己的 DeepSeek API Key。更适合追求课程字幕翻译质量的长期使用；为了更丝滑的翻译体验，DeepSeek Thinking 默认为关闭。",
  gemini: "需要你自己的 Gemini API Key。适合追求更好翻译质量；请确认所在地区和账号可用。",
  openai: "需要你自己的 OpenAI API Key。适合追求更好翻译质量；Reasoning Effort 仅对支持模型生效。",
  deepl: "需要你自己的 DeepL API Key。适合常规机器翻译质量需求；不支持 YUE 目标语言。"
};

function setStatus(text, isError = false) {
  const status = document.getElementById("status");
  status.textContent = text;
  status.classList.toggle("error", !!isError);
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getInputValue(id, fallback = "") {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}

function getNumberValue(id, fallback, min) {
  const raw = getInputValue(id, "");
  const parsed = raw === "" ? Number(fallback) : Number(raw);
  const fallbackNumber = Number(fallback);
  const value = Number.isFinite(parsed) ? parsed : fallbackNumber;
  return Math.max(min, Number.isFinite(value) ? value : min);
}

function refreshAdvancedUi(provider) {
  const advancedRows = [...document.querySelectorAll("[data-provider-advanced]")];
  const hasDevAdvanced = document.querySelector("[data-dev-advanced]") !== null;
  let visibleCount = 0;
  for (const row of advancedRows) {
    const visible = row.dataset.providerAdvanced === provider;
    row.hidden = !visible;
    if (visible) visibleCount += 1;
  }
  const emptyHint = document.getElementById("advancedEmptyHint");
  if (emptyHint) emptyHint.hidden = visibleCount > 0 || hasDevAdvanced;
}

function refreshProviderUi() {
  const provider = document.getElementById("provider").value;
  const isKeyless = keylessProviders.has(provider);
  const apiKeyEl = document.getElementById("apiKey");
  const modelEl = document.getElementById("model");
  const providerHint = document.getElementById("providerHint");
  const apiKeyHint = document.getElementById("apiKeyHint");

  providerHint.textContent = providerHints[provider] || "";
  apiKeyHint.textContent = isKeyless
    ? "Google Translate 不需要 API Key；保存时会自动清空本地 API Key 字段。若翻译质量不理想，请切换到 AI/API 模型。"
    : "API Key 仅保存在 Chrome 本地 storage，用于请求你选择的翻译服务。";
  apiKeyEl.disabled = isKeyless;
  apiKeyEl.placeholder = isKeyless ? "Google Translate 不需要 API Key" : "请输入你的 API Key";
  if (isKeyless) apiKeyEl.value = "";
  modelEl.disabled = isKeyless;
  if (isKeyless) modelEl.value = "";
  refreshAdvancedUi(provider);
}

function refreshBuildUi() {
  const section = document.getElementById("localBackendSection");
  const checkbox = document.getElementById("useLocalBackend");
  if (!enableLocalBackend) {
    if (section) section.hidden = true;
    if (checkbox) checkbox.checked = false;
  }
}

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  const useLocalBackendEl = document.getElementById("useLocalBackend");
  const backendUrlEl = document.getElementById("backendUrl");
  if (useLocalBackendEl) useLocalBackendEl.checked = enableLocalBackend && !!config.useLocalBackend;
  if (backendUrlEl) backendUrlEl.value = config.backendUrl;
  document.getElementById("apiKey").value = config.apiKey;
  document.getElementById("provider").value = providerDefaults[config.provider] ? config.provider : defaultConfig.provider;
  document.getElementById("model").value = config.model;
  document.getElementById("endpoint").value = config.endpoint || "";
  const targetEl = document.getElementById("target");
  const targetValue = (config.target || "ZH").toUpperCase();
  if ([...targetEl.options].some((o) => o.value === targetValue)) {
    targetEl.value = targetValue;
  } else {
    targetEl.value = "ZH";
  }
  setInputValue("maxParagraphs", String(config.maxParagraphs));
  setInputValue("maxChars", String(config.maxChars));
  setInputValue("concurrency", String(config.concurrency));
  setInputValue("rps", String(config.rps));
  setInputValue("retries", String(config.retries));
  setInputValue("timeout", String(config.timeout));
  setInputValue("fallbackMode", config.fallbackMode || defaultConfig.fallbackMode);
  setInputValue("repairConcurrency", String(config.repairConcurrency));
  setInputValue("slowSplitThreshold", String(config.slowSplitThreshold));
  setInputValue("reasoningEffort", config.reasoningEffort || "");
  setInputValue("deepseekThinkingMode", config.deepseekThinkingMode || defaultConfig.deepseekThinkingMode);
  setInputValue("deeplFormality", config.deeplFormality || "");
  refreshProviderUi();
  refreshBuildUi();
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
  refreshProviderUi();
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
  const provider = document.getElementById("provider").value;
  const { [STORAGE_KEY]: existingValue } = await extensionApi.storage.local.get(STORAGE_KEY);
  const existing = { ...defaultConfig, ...(existingValue || {}) };
  const useLocalBackendEl = document.getElementById("useLocalBackend");
  const backendUrlEl = document.getElementById("backendUrl");
  const useLocalBackend = enableLocalBackend && !!useLocalBackendEl?.checked;
  const rawBackendUrl = backendUrlEl?.value.trim() || defaultConfig.backendUrl;
  if (useLocalBackend && !isLocalBackendUrl(rawBackendUrl)) {
    setStatus("错误：Backend 地址只允许 localhost、127.0.0.1 或 ::1", true);
    setTimeout(() => setStatus(""), 3000);
    return;
  }
  const config = {
    useLocalBackend,
    backendUrl: rawBackendUrl,
    apiKey: keylessProviders.has(provider) ? "" : document.getElementById("apiKey").value.trim(),
    provider,
    model: keylessProviders.has(provider) ? "" : document.getElementById("model").value.trim(),
    endpoint: document.getElementById("endpoint").value.trim(),
    target: (document.getElementById("target").value || "ZH").toUpperCase(),
    maxParagraphs: getNumberValue("maxParagraphs", existing.maxParagraphs ?? defaultConfig.maxParagraphs, 1),
    maxChars: getNumberValue("maxChars", existing.maxChars ?? defaultConfig.maxChars, 100),
    concurrency: getNumberValue("concurrency", existing.concurrency ?? defaultConfig.concurrency, 1),
    rps: getNumberValue("rps", existing.rps ?? defaultConfig.rps, 0),
    retries: getNumberValue("retries", existing.retries ?? defaultConfig.retries, 0),
    timeout: getNumberValue("timeout", existing.timeout ?? defaultConfig.timeout, 1),
    reasoningEffort: provider === "openai" ? getInputValue("reasoningEffort", "") : "",
    fallbackMode: getInputValue("fallbackMode", existing.fallbackMode || defaultConfig.fallbackMode) || defaultConfig.fallbackMode,
    repairConcurrency: getNumberValue("repairConcurrency", existing.repairConcurrency ?? defaultConfig.repairConcurrency, 1),
    slowSplitThreshold: getNumberValue("slowSplitThreshold", existing.slowSplitThreshold ?? defaultConfig.slowSplitThreshold, 0),
    deepseekThinkingMode: provider === "deepseek"
      ? getInputValue("deepseekThinkingMode", defaultConfig.deepseekThinkingMode)
      : defaultConfig.deepseekThinkingMode,
    deeplFormality: provider === "deepl" ? getInputValue("deeplFormality", "") : ""
  };
  await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  setStatus("已保存。请回到 Echo360 页面，点击“加载翻译字幕”。");
  setTimeout(() => {
    setStatus("");
  }, 1200);
}

document.getElementById("provider").addEventListener("change", applyProviderDefaults);
document.getElementById("saveBtn").addEventListener("click", saveConfig);
refreshBuildUi();
loadConfig().catch((err) => {
  setStatus(`加载失败：${err?.message || String(err)}`, true);
});
