(() => {
  const ns = window.Echo360Translator;
  const {
    STORAGE_KEY,
    CACHE_KEY,
    PREFS_KEY_PREFIX,
    ONBOARDING_KEY,
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
      browserBilingual: false,
      browserReverseOrder: false,
      // Default: prefer Echo360 native CC injection. It renders with
      // the platform's own caption look and now matches same-frame latency;
      // bilingual_dom_renderer.js auto-falls back to the browser <track>
      // renderer for lessons that have no native CC track at all, so this
      // is safe as the out-of-the-box behavior rather than an opt-in.
      useNativeSubtitles: false,
      renderModeVersion: PREFS_SCHEMA_VERSION,
    };
    if (prefs.renderModeVersion !== PREFS_SCHEMA_VERSION) {
      prefs.useNativeSubtitles = false;
      prefs.renderModeVersion = PREFS_SCHEMA_VERSION;
    } else {
      prefs.useNativeSubtitles = prefs.useNativeSubtitles === true;
    }
    prefs.browserBilingual = typeof prefs.browserBilingual === "boolean" ? prefs.browserBilingual : prefs.bilingual === true;
    prefs.browserReverseOrder = typeof prefs.browserReverseOrder === "boolean" ? prefs.browserReverseOrder : prefs.reverseOrder === true;
    prefs.bilingual = prefs.useNativeSubtitles ? prefs.browserBilingual : true;
    prefs.reverseOrder = prefs.useNativeSubtitles ? prefs.browserReverseOrder : false;
    if (prefs.size === "tiny") prefs.size = "medium";
    else if (!SIZE_MAP[prefs.size]) prefs.size = DEFAULT_SUBTITLE_SIZE;
    return prefs;
  }

  async function savePrefs(prefs) {
    const key = `${PREFS_KEY_PREFIX}${getContextKey()}`;
    const obj = await extensionApi.storage.local.get(key);
    const existing = obj[key] && typeof obj[key] === "object" ? obj[key] : {};
    const useNativeSubtitles = prefs.useNativeSubtitles === true;
    const browserBilingual = useNativeSubtitles
      ? prefs.bilingual === true
      : typeof prefs.browserBilingual === "boolean"
        ? prefs.browserBilingual
        : existing.browserBilingual === true;
    const browserReverseOrder = useNativeSubtitles
      ? prefs.reverseOrder === true
      : typeof prefs.browserReverseOrder === "boolean"
        ? prefs.browserReverseOrder
        : existing.browserReverseOrder === true;
    const normalizedPrefs = {
      ...prefs,
      renderModeVersion: PREFS_SCHEMA_VERSION,
      useNativeSubtitles,
      browserBilingual,
      browserReverseOrder,
      bilingual: useNativeSubtitles ? browserBilingual : true,
      reverseOrder: useNativeSubtitles ? browserReverseOrder : false,
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
    return JSON.stringify([
      cfg.provider,
      cfg.model,
      cfg.endpoint || "",
      String(cfg.target || "").toUpperCase(),
      Number(cfg.maxParagraphs) || 0,
      Number(cfg.maxChars) || 0,
      cfg.reasoningEffort || "",
      cfg.deepseekThinkingMode || "",
      cfg.deeplFormality || "",
    ]);
  }

  async function getConfig() {
    const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
    const config = value || {
      apiKey: "",
      apiKeys: {},
      appearance: "auto",
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
    // Resolve the effective API key for the current provider from the per-provider
    // map, falling back to the legacy single apiKey field for migration.
    const provider = config.provider || "google-web";
    const effectiveApiKey = KEYLESS_PROVIDERS.has(provider)
      ? ""
      : (config.apiKeys?.[provider] ?? config.apiKey ?? "");
    const resolved = { ...config, apiKey: effectiveApiKey, apiKeys: config.apiKeys || {} };
    if (!isLocalBackendEnabled()) {
      return { ...resolved, useLocalBackend: false };
    }
    return resolved;
  }

  async function saveConfig(config) {
    await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  }

  async function getOnboardingSeen() {
    const obj = await extensionApi.storage.local.get(ONBOARDING_KEY);
    return !!obj[ONBOARDING_KEY];
  }

  async function setOnboardingSeen() {
    await extensionApi.storage.local.set({ [ONBOARDING_KEY]: true });
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
    getOnboardingSeen,
    setOnboardingSeen,
  };
})();
