(() => {
  const ns = window.Echo360Translator;
  const {
    STORAGE_KEY,
    CACHE_KEY,
    PREFS_KEY_PREFIX,
    DEFAULT_SUBTITLE_SIZE,
    SIZE_MAP,
  } = ns.constants;
  const extensionApi = ns.browserApi;

  function getContextKey() {
    const m = location.pathname.match(/\/lesson\/([^/]+)/);
    return `${location.hostname}::${m ? m[1] : location.pathname}`;
  }

  async function getPrefs() {
    const key = `${PREFS_KEY_PREFIX}${getContextKey()}`;
    const obj = await extensionApi.storage.local.get(key);
    const prefs = obj[key] || { enabled: true, size: DEFAULT_SUBTITLE_SIZE, bilingual: false, reverseOrder: false };
    if (prefs.size === "tiny") prefs.size = "medium";
    else if (!SIZE_MAP[prefs.size]) prefs.size = DEFAULT_SUBTITLE_SIZE;
    return prefs;
  }

  async function savePrefs(prefs) {
    const key = `${PREFS_KEY_PREFIX}${getContextKey()}`;
    await extensionApi.storage.local.set({ [key]: prefs });
  }

  async function sha256Text(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function getCacheStore() {
    const obj = await extensionApi.storage.local.get(CACHE_KEY);
    return obj[CACHE_KEY] && typeof obj[CACHE_KEY] === "object" ? obj[CACHE_KEY] : null;
  }

  async function setCacheStore(entryOrNull) {
    await extensionApi.storage.local.set({ [CACHE_KEY]: entryOrNull || null });
  }

  function buildConfigSignature(cfg) {
    return [
      cfg.provider,
      cfg.model,
      cfg.endpoint || "",
      String(cfg.target || "").toUpperCase(),
      Number(cfg.maxParagraphs) || 0,
      Number(cfg.maxChars) || 0,
      cfg.reasoningEffort || "",
    ].join("|");
  }

  async function getConfig() {
    const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
    if (value) return value;
    return {
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
      reasoningEffort: "",
    };
  }

  async function saveConfig(config) {
    await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  }

  async function askApiKeyIfNeeded(config) {
    if (config.apiKey && config.apiKey.trim()) return config;
    const apiKey = window.prompt("请输入翻译 API Key（仅存本地浏览器 storage）:");
    if (!apiKey || !apiKey.trim()) return null;
    const next = { ...config, apiKey: apiKey.trim() };
    await saveConfig(next);
    return next;
  }

  ns.storage = {
    getContextKey,
    getPrefs,
    savePrefs,
    sha256Text,
    getCacheStore,
    setCacheStore,
    buildConfigSignature,
    getConfig,
    saveConfig,
    askApiKeyIfNeeded,
  };
})();
