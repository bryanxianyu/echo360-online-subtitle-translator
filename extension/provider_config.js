(() => {
  const root = globalThis;
  const PROVIDERS = ["google-web", "openai", "deepseek", "gemini", "deepl"];
  const KEYLESS_PROVIDERS = new Set(["google-web"]);
  const PROFILE_FIELDS = [
    "model", "modelMode", "catalogModel", "customModel", "endpoint", "reasoningEffort", "deepseekThinkingMode", "deeplFormality",
    "maxParagraphs", "maxChars", "concurrency", "rps", "retries", "timeout",
    "fallbackMode", "repairConcurrency", "slowSplitThreshold",
  ];
  const PERFORMANCE_FIELDS = [
    "maxParagraphs", "maxChars", "concurrency", "rps", "retries", "timeout",
    "fallbackMode", "repairConcurrency", "slowSplitThreshold",
  ];
  const DEFAULT_ENDPOINTS = {
    "google-web": "https://translate.googleapis.com/translate_a/single",
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    deepl: "https://api-free.deepl.com/v2/translate",
  };
  const PROVIDER_ADVANCED_FIELDS = {
    "google-web": [],
    openai: ["reasoningEffort"],
    deepseek: ["deepseekThinkingMode"],
    gemini: [],
    deepl: ["deeplFormality"],
  };
  // Curated defaults reviewed against the providers' current official model
  // documentation. The API-discovered catalog remains the source of choices.
  const MODEL_RECOMMENDATIONS = {
    openai: {
      modelId: "gpt-6-luna",
      reason: "OpenAI 将 GPT-6 Luna 定位为适合高频、大规模任务的高效率模型。",
      source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
      reviewedAt: "2026-09-24",
    },
    gemini: {
      modelId: "gemini-3.5-flash-lite",
      reason: "Google 将 Gemini 3.5 Flash-Lite 定位为低延迟、高吞吐且低成本的模型。",
      source: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite",
      reviewedAt: "2026-09-24",
    },
    deepseek: {
      modelId: "deepseek-flash",
      reason: "DeepSeek 当前 Flash API ID 为 deepseek-flash，V4.1 Flash 面向更高推理速度和吞吐。",
      source: "https://api-docs.deepseek.com/updates/",
      reviewedAt: "2026-09-24",
    },
  };
  const DEFAULTS = {
    "google-web": { model: "", modelMode: "catalog", catalogModel: "", customModel: null, endpoint: "", reasoningEffort: "", deepseekThinkingMode: "disabled", deeplFormality: "", maxParagraphs: 80, maxChars: 4000, concurrency: 8, rps: 0, retries: 1, timeout: 10, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0 },
    openai: { model: MODEL_RECOMMENDATIONS.openai.modelId, modelMode: "catalog", catalogModel: MODEL_RECOMMENDATIONS.openai.modelId, customModel: null, endpoint: "", reasoningEffort: "", deepseekThinkingMode: "disabled", deeplFormality: "", maxParagraphs: 6, maxChars: 1200, concurrency: 96, rps: 0, retries: 1, timeout: 10, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0 },
    deepseek: { model: MODEL_RECOMMENDATIONS.deepseek.modelId, modelMode: "catalog", catalogModel: MODEL_RECOMMENDATIONS.deepseek.modelId, customModel: null, endpoint: "", reasoningEffort: "", deepseekThinkingMode: "disabled", deeplFormality: "", maxParagraphs: 6, maxChars: 1200, concurrency: 96, rps: 0, retries: 1, timeout: 10, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0 },
    gemini: { model: MODEL_RECOMMENDATIONS.gemini.modelId, modelMode: "catalog", catalogModel: MODEL_RECOMMENDATIONS.gemini.modelId, customModel: null, endpoint: "", reasoningEffort: "", deepseekThinkingMode: "disabled", deeplFormality: "", maxParagraphs: 6, maxChars: 1200, concurrency: 96, rps: 0, retries: 1, timeout: 10, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0 },
    deepl: { model: "", modelMode: "catalog", catalogModel: "", customModel: null, endpoint: "", reasoningEffort: "", deepseekThinkingMode: "disabled", deeplFormality: "", maxParagraphs: 80, maxChars: 4000, concurrency: 8, rps: 0, retries: 1, timeout: 30, fallbackMode: "immediate", repairConcurrency: 1, slowSplitThreshold: 0 },
  };
  const LEGACY_FIELDS = [
    "model", "endpoint", "reasoningEffort", "deepseekThinkingMode", "deeplFormality",
    "maxParagraphs", "maxChars", "concurrency", "rps", "retries", "timeout",
    "fallbackMode", "repairConcurrency", "slowSplitThreshold",
  ];
  let configWriteTail = Promise.resolve();

  function openaiEndpointForRoute(rawEndpoint = "", route = "responses") {
    const base = safeEndpoint(rawEndpoint) || new URL(DEFAULT_ENDPOINTS.openai);
    let path = base.pathname.replace(/\/+$/, "");
    const endpointTail = /\/(?:v\d+(?:beta|alpha)?\/)?(?:responses|chat\/completions|models)$/i;
    if (endpointTail.test(path)) {
      const prefix = path.replace(endpointTail, "");
      const version = path.match(/\/(v\d+(?:beta|alpha)?)\/(?:responses|models|chat\/completions)$/i)?.[1] || "";
      path = `${prefix}${version ? `/${version}` : ""}/${route}`;
    } else {
      const hasApiVersion = /(?:^|\/)v\d+(?:beta|alpha)?(?:\/openai)?$/i.test(path)
        || /(?:^|\/)openai\/v\d+(?:beta|alpha)?$/i.test(path);
      path = `${path}${hasApiVersion ? "" : "/v1"}/${route}`;
    }
    base.pathname = path.replace(/\/{2,}/g, "/");
    return base.toString();
  }

  // Extension pages share an origin, so Web Locks serialize their read/merge/write
  // cycle. The local queue keeps test and older-browser fallbacks ordered too.
  function withConfigWriteLock(operation) {
    const run = () => root.navigator?.locks?.request
      ? root.navigator.locks.request("echo360-translator-config-write", { mode: "exclusive" }, operation)
      : operation();
    const result = configWriteTail.then(run, run);
    configWriteTail = result.catch(() => {});
    return result;
  }

  function migrate(rawConfig) {
    const raw = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const previousConfigVersion = Number(raw.configVersion || 0);
    const provider = PROVIDERS.includes(raw.provider) ? raw.provider : "google-web";
    const apiKeys = { ...(raw.apiKeys && typeof raw.apiKeys === "object" ? raw.apiKeys : {}) };
    if (!Object.prototype.hasOwnProperty.call(apiKeys, provider) && raw.apiKey) apiKeys[provider] = raw.apiKey;

    const storedProfiles = raw.providerSettings && typeof raw.providerSettings === "object" ? raw.providerSettings : {};
    const providerSettings = {};
    for (const id of PROVIDERS) {
      const saved = storedProfiles[id] && typeof storedProfiles[id] === "object" ? storedProfiles[id] : {};
      const migrated = {};
      if (id === provider) {
        for (const field of LEGACY_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(saved, field) && Object.prototype.hasOwnProperty.call(raw, field)) migrated[field] = raw[field];
        }
      }
      const hasSavedModel = Object.prototype.hasOwnProperty.call(saved, "model")
        || Object.prototype.hasOwnProperty.call(migrated, "model");
      const previousModel = hasSavedModel ? String(saved.model ?? migrated.model ?? "").trim() : "";
      const merged = { ...DEFAULTS[id], ...migrated, ...saved };
      const previousOpenAiProtocol = id === "openai"
        ? saved.openaiApiProtocol || (provider === "openai" ? raw.openaiApiProtocol : "")
        : "";
      if (id === "openai" && previousConfigVersion < 6 && previousOpenAiProtocol === "chat-completions") {
        merged.endpoint = openaiEndpointForRoute(merged.endpoint, "chat/completions");
      }
      delete merged.openaiApiProtocol;
      if (id === "google-web" && previousConfigVersion < 4) {
        if (Number(merged.maxParagraphs) === 20) merged.maxParagraphs = DEFAULTS[id].maxParagraphs;
        if (Number(merged.maxChars) === 2000) merged.maxChars = DEFAULTS[id].maxChars;
        if (Number(merged.concurrency) === 16) merged.concurrency = DEFAULTS[id].concurrency;
        if (Number(merged.rps) === 12) merged.rps = DEFAULTS[id].rps;
      }
      if (id === "deepl" && previousConfigVersion < 5 && Number(merged.maxChars) === 12000) {
        merged.maxChars = DEFAULTS[id].maxChars;
      }
      const validSavedMode = saved.modelMode === "custom" || saved.modelMode === "catalog";
      const mode = validSavedMode
        ? saved.modelMode
        : previousModel && previousModel !== DEFAULTS[id].model ? "custom" : "catalog";
      const savedCatalogModel = Object.prototype.hasOwnProperty.call(saved, "catalogModel")
        ? saved.catalogModel
        : Object.prototype.hasOwnProperty.call(migrated, "catalogModel") ? migrated.catalogModel : undefined;
      const savedCustomModel = Object.prototype.hasOwnProperty.call(saved, "customModel")
        ? saved.customModel
        : Object.prototype.hasOwnProperty.call(migrated, "customModel") ? migrated.customModel : undefined;
      const catalogModel = savedCatalogModel !== undefined
        ? String(savedCatalogModel || "").trim()
        : previousModel ? previousModel : DEFAULTS[id].catalogModel;
      const customModel = savedCustomModel !== undefined
        ? savedCustomModel === null ? null : String(savedCustomModel || "").trim()
        : mode === "custom" ? previousModel : null;
      const model = mode === "custom" ? customModel : catalogModel;
      providerSettings[id] = { ...merged, modelMode: mode, catalogModel, customModel, model };
    }
    const normalized = { ...raw, configVersion: 6, provider, apiKeys, providerSettings };
    delete normalized.openaiApiProtocol;
    return normalized;
  }

  function resolve(rawConfig, provider = rawConfig?.provider) {
    const config = migrate(rawConfig);
    const id = PROVIDERS.includes(provider) ? provider : config.provider;
    const apiKey = KEYLESS_PROVIDERS.has(id) ? "" : String(config.apiKeys[id] || "");
    return { ...config, ...config.providerSettings[id], provider: id, apiKey };
  }

  function saveActive(rawConfig, provider, profilePatch = {}, globalPatch = {}, apiKeyPatch) {
    const config = migrate(rawConfig);
    const id = PROVIDERS.includes(provider) ? provider : config.provider;
    const providerSettings = { ...config.providerSettings };
    const patch = Object.fromEntries(Object.entries(profilePatch).filter(([field]) => PROFILE_FIELDS.includes(field)));
    const current = providerSettings[id];
    if (Object.prototype.hasOwnProperty.call(patch, "model") && !Object.prototype.hasOwnProperty.call(patch, "modelMode")) {
      if (current.modelMode === "custom") patch.customModel = patch.model;
      else patch.catalogModel = patch.model;
    }
    if (patch.modelMode === "custom") {
      if (Object.prototype.hasOwnProperty.call(patch, "model") && !Object.prototype.hasOwnProperty.call(patch, "customModel")) patch.customModel = patch.model;
      if (Object.prototype.hasOwnProperty.call(patch, "customModel")) patch.model = patch.customModel;
    } else if (patch.modelMode === "catalog") {
      if (Object.prototype.hasOwnProperty.call(patch, "model") && !Object.prototype.hasOwnProperty.call(patch, "catalogModel")) patch.catalogModel = patch.model;
      if (Object.prototype.hasOwnProperty.call(patch, "catalogModel")) patch.model = patch.catalogModel;
    }
    providerSettings[id] = {
      ...providerSettings[id],
      ...patch,
    };
    const apiKeys = { ...config.apiKeys };
    if (typeof apiKeyPatch === "string" && !KEYLESS_PROVIDERS.has(id)) apiKeys[id] = apiKeyPatch.trim();
    const activeProfile = providerSettings[id];
    return {
      ...config,
      ...globalPatch,
      configVersion: 6,
      provider: id,
      providerSettings,
      apiKeys,
      apiKey: KEYLESS_PROVIDERS.has(id) ? "" : String(apiKeys[id] || ""),
      ...activeProfile,
    };
  }

  function safeEndpoint(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) return null;
    let url;
    try { url = new URL(value); } catch (_) { throw new Error("服务地址不是有效 URL"); }
    if (url.protocol !== "https:") throw new Error("服务地址必须使用 HTTPS");
    if (url.username || url.password || url.hash) throw new Error("服务地址不能包含用户名、密码或片段");
    if ([...url.searchParams.keys()].some((key) => /key|token|auth|secret/i.test(key))) throw new Error("请勿把凭据写在服务地址的查询参数中");
    return url;
  }

  function defaultAdvancedPatch(provider, includePerformance = false) {
    const id = PROVIDERS.includes(provider) ? provider : "google-web";
    const fields = ["endpoint", ...(PROVIDER_ADVANCED_FIELDS[id] || [])];
    if (includePerformance) fields.push(...PERFORMANCE_FIELDS);
    return Object.fromEntries(fields.map((field) => [field, DEFAULTS[id][field]]));
  }

  function deeplEndpointFor(rawEndpoint = "", resource = "translate", apiKey = "") {
    const custom = safeEndpoint(rawEndpoint);
    const cleanedApiKey = String(apiKey || "").trim().toLowerCase();
    const defaultHost = !cleanedApiKey || cleanedApiKey.endsWith(":fx")
      ? "https://api-free.deepl.com"
      : "https://api.deepl.com";
    const url = custom || new URL(defaultHost);
    const path = url.pathname.replace(/\/+$/, "");
    const endpointMatch = path.match(/^(.*)\/(v[12])\/([^/]+)$/i);
    const versionMatch = path.match(/^(.*)\/(v[12])$/i);
    if (endpointMatch) url.pathname = `${endpointMatch[1]}/${endpointMatch[2]}/${resource}`;
    else if (versionMatch) url.pathname = `${versionMatch[1]}/${versionMatch[2]}/${resource}`;
    else if (!path) url.pathname = `/v2/${resource}`;
    else url.pathname = `${path}/v2/${resource}`;
    return url.toString();
  }

  function openaiProtocolForEndpoint(rawEndpoint = "") {
    try {
      const path = new URL(String(rawEndpoint || "").trim()).pathname.replace(/\/+$/, "");
      return /\/chat\/completions$/i.test(path) ? "chat-completions" : "responses";
    } catch (_) {
      return "responses";
    }
  }

  function endpointFor(provider, rawEndpoint = "", resource = "translate", model = "") {
    const custom = safeEndpoint(rawEndpoint);
    const defaultUrl = () => new URL(DEFAULT_ENDPOINTS[provider]);
    const suppliedPath = custom?.pathname.replace(/\/+$/, "") || "";
    const incompatibleRoutes = {
      "google-web": /\/(?:v\d+\/)?(?:chat\/completions|responses)$/i,
      deepseek: /\/(?:v\d+\/)?responses$/i,
      gemini: /\/(?:v\d+\/)?(?:chat\/completions|responses)$/i,
      deepl: /\/(?:v\d+\/)?(?:chat\/completions|responses|generateContent)$/i,
    };
    if (incompatibleRoutes[provider]?.test(suppliedPath)) {
      const protocol = {
        "google-web": "Google Translate",
        openai: "OpenAI Responses",
        deepseek: "DeepSeek Chat Completions",
        gemini: "Gemini generateContent",
        deepl: "DeepL Translate",
      }[provider];
      throw new Error(`Endpoint 路径与 ${protocol} 接口不兼容`);
    }
    if (provider === "google-web") {
      const url = custom || defaultUrl();
      return url.toString();
    }
    if (provider === "deepl") {
      return deeplEndpointFor(rawEndpoint, resource);
    }
    if (provider === "gemini") {
      const url = custom || defaultUrl();
      let path = url.pathname.replace(/\/+$/, "");
      path = path.replace(/\/models\/[^/]+(?::generateContent)?$/, "");
      path = path.replace(/\/models$/, "");
      if (resource === "models") {
        url.pathname = `${path}/models`;
        return url.toString();
      }
      const modelId = String(model || "").replace(/^models\//, "").replace(/:generateContent$/, "");
      const methodPath = `/models/${encodeURIComponent(modelId)}:generateContent`;
      url.pathname = `${path}${methodPath}`;
      return url.toString();
    }
    if (provider === "openai" || provider === "deepseek") {
      if (provider === "openai") {
        const protocol = openaiProtocolForEndpoint(rawEndpoint);
        const route = resource === "models" ? "models" : protocol === "chat-completions" ? "chat/completions" : "responses";
        return openaiEndpointForRoute(rawEndpoint, route);
      }
      const base = custom || defaultUrl();
      const leaf = resource === "models" ? "models" : "chat/completions";
      let path = base.pathname.replace(/\/+$/, "");
      const endpointTail = /\/(?:v\d+(?:beta|alpha)?\/)?(?:responses|chat\/completions|models)$/i;
      if (endpointTail.test(path)) {
        const prefix = path.replace(endpointTail, "");
        const version = path.match(/\/(v\d+(?:beta|alpha)?)\/(?:responses|models|chat\/completions)$/i)?.[1] || "";
        path = `${prefix}${version ? `/${version}` : ""}/${leaf}`;
      } else path = `${path}/${leaf}`;
      base.pathname = path.replace(/\/{2,}/g, "/");
      return base.toString();
    }
    throw new Error("不支持的翻译服务");
  }

  root.Echo360ProviderConfig = { PROVIDERS, KEYLESS_PROVIDERS, PROFILE_FIELDS, PERFORMANCE_FIELDS, DEFAULTS, DEFAULT_ENDPOINTS, PROVIDER_ADVANCED_FIELDS, MODEL_RECOMMENDATIONS, migrate, resolve, saveActive, safeEndpoint, defaultAdvancedPatch, deeplEndpointFor, openaiProtocolForEndpoint, endpointFor, withConfigWriteLock };
})();
