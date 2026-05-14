const STORAGE_KEY = "echo360TranslatorConfig";
const extensionApi = window.Echo360ExtensionApi;

const defaultConfig = {
  apiKey: "",
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
  reasoningEffort: ""
};

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
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
  const rawBackendUrl = document.getElementById("backendUrl").value.trim() || defaultConfig.backendUrl;
  if (!isLocalBackendUrl(rawBackendUrl)) {
    const status = document.getElementById("status");
    status.textContent = "错误：Backend 地址只允许 localhost 或 127.0.0.1";
    status.style.color = "red";
    setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
    return;
  }
  const config = {
    backendUrl: rawBackendUrl,
    apiKey: document.getElementById("apiKey").value.trim(),
    provider: document.getElementById("provider").value,
    model: document.getElementById("model").value.trim() || defaultConfig.model,
    endpoint: document.getElementById("endpoint").value.trim(),
    target: (document.getElementById("target").value || "ZH").toUpperCase(),
    maxParagraphs: Math.max(1, Number(document.getElementById("maxParagraphs").value) || 6),
    maxChars: Math.max(100, Number(document.getElementById("maxChars").value) || 1200),
    concurrency: Math.max(1, Number(document.getElementById("concurrency").value) || 96),
    rps: Math.max(0, Number(document.getElementById("rps").value) || 0),
    retries: Math.max(0, Number(document.getElementById("retries").value) || 1),
    timeout: Math.max(1, Number(document.getElementById("timeout").value) || 10),
    reasoningEffort: document.getElementById("reasoningEffort").value || ""
  };
  await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  const status = document.getElementById("status");
  status.textContent = "已保存";
  setTimeout(() => {
    status.textContent = "";
  }, 1200);
}

document.getElementById("saveBtn").addEventListener("click", saveConfig);
loadConfig();
