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
  const KEYLESS_PROVIDERS = new Set(["google-web"]);
  const PREFS_SCHEMA_VERSION = 2;

  function isLocalBackendEnabled() {
    return ns.buildConfig?.enableLocalBackend !== false;
  }

  function getContextKey() {
    const m = location.pathname.match(/\/lesson\/([^/]+)/);
    return `${location.hostname}::${m ? m[1] : location.pathname}`;
  }

  async function getPrefs() {
    const key = `${PREFS_KEY_PREFIX}${getContextKey()}`;
    const obj = await extensionApi.storage.local.get(key);
    const prefs = obj[key] || {
      enabled: true,
      size: DEFAULT_SUBTITLE_SIZE,
      bilingual: false,
      reverseOrder: false,
      useNativeSubtitles: true,
      renderModeVersion: PREFS_SCHEMA_VERSION,
    };
    if (prefs.renderModeVersion !== PREFS_SCHEMA_VERSION) {
      prefs.useNativeSubtitles = true;
      prefs.renderModeVersion = PREFS_SCHEMA_VERSION;
    } else {
      prefs.useNativeSubtitles = prefs.useNativeSubtitles !== false;
    }
    prefs.bilingual = prefs.useNativeSubtitles ? prefs.bilingual === true : true;
    prefs.reverseOrder = prefs.useNativeSubtitles ? prefs.reverseOrder === true : false;
    if (prefs.size === "tiny") prefs.size = "medium";
    else if (!SIZE_MAP[prefs.size]) prefs.size = DEFAULT_SUBTITLE_SIZE;
    return prefs;
  }

  async function savePrefs(prefs) {
    const key = `${PREFS_KEY_PREFIX}${getContextKey()}`;
    const useNativeSubtitles = prefs.useNativeSubtitles !== false;
    const normalizedPrefs = {
      ...prefs,
      renderModeVersion: PREFS_SCHEMA_VERSION,
      useNativeSubtitles,
      bilingual: useNativeSubtitles ? prefs.bilingual === true : true,
      reverseOrder: useNativeSubtitles ? prefs.reverseOrder === true : false,
    };
    await extensionApi.storage.local.set({ [key]: normalizedPrefs });
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
    try {
      await extensionApi.storage.local.set({ [CACHE_KEY]: entryOrNull || null });
    } catch (err) {
      console.warn("[echo360-translator] subtitle cache skipped:", err?.message || String(err));
    }
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
      cfg.deepseekThinkingMode || "",
      cfg.deeplFormality || "",
    ].join("|");
  }

  async function getConfig() {
    const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
    const config = value || {
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
    if (!isLocalBackendEnabled()) {
      return { ...config, useLocalBackend: false };
    }
    return config;
  }

  async function saveConfig(config) {
    await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  }

  async function askApiKeyIfNeeded(config) {
    const provider = String(config.provider || "").toLowerCase();
    const apiKey = String(config.apiKey || "").trim();
    if (KEYLESS_PROVIDERS.has(provider)) {
      return { ...config, apiKey: "" };
    }
    if (apiKey) return config;
    return null;
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
