(() => {
  const root = globalThis;
  const config = root.Echo360ProviderConfig;
  const CACHE_KEY = "echo360ProviderModelCatalogs";
  const MAX_CATALOGS = 20;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const active = new Map();

  function classifyError(status, body = "", fallback = "invalid_response") {
    const text = String(body || "").slice(0, 1200).toLowerCase();
    if (/api[_ ]key.{0,30}(invalid|not valid)|invalid.{0,20}api[_ ]key/.test(text)) return "invalid_key";
    if (status === 401) return "invalid_key";
    if (status === 403) return /quota|billing|credit|exhausted|limit reached|insufficient balance|insufficient_quota/.test(text) ? "quota_exceeded" : "permission_denied";
    if (status === 429) return /quota|billing|credit|exhausted|insufficient balance|insufficient_quota/.test(text) ? "quota_exceeded" : "rate_limited";
    if (status === 404) return "model_unavailable";
    if (status === 400) return "invalid_configuration";
    if (status === 408) return "timeout";
    if (status === 0) return fallback;
    return status >= 500 ? "network_error" : fallback;
  }

  function safeMessage(body, apiKey) {
    const withoutKey = apiKey ? String(body || "").split(apiKey).join("[redacted]") : String(body || "");
    try {
      const json = JSON.parse(withoutKey);
      const message = json?.error?.message || json?.message || json?.error || "";
      return String(message || "服务返回错误").slice(0, 300);
    } catch (_) {
      return withoutKey.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 300) || "服务返回错误";
    }
  }

  function providerHeaders(provider, apiKey) {
    if (provider === "gemini") return { "x-goog-api-key": apiKey };
    if (provider === "deepl") return { Authorization: `DeepL-Auth-Key ${apiKey}` };
    return { Authorization: `Bearer ${apiKey}` };
  }

  async function requestJson(url, provider, apiKey, signal, timeoutMs = 10000) {
    if (signal.aborted) throw new Error("request cancelled");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, Math.max(1, timeoutMs));
    try {
      const response = await fetch(url, { method: "GET", headers: providerHeaders(provider, apiKey), signal: controller.signal, redirect: "error", cache: "no-store" });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(safeMessage(text, apiKey));
        error.category = classifyError(response.status, text);
        error.httpStatus = response.status;
        try {
          const body = JSON.parse(text);
          error.providerCode = body?.error?.code || body?.error?.status || body?.code || "";
        } catch (_) { /* Plain-text providers have no structured code. */ }
        const retryHeader = response.headers.get("Retry-After");
        const retry = Number(retryHeader);
        if (Number.isFinite(retry) && retry > 0) error.retryAfterSeconds = retry;
        else if (retryHeader) {
          const dateDelay = Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000);
          if (Number.isFinite(dateDelay) && dateDelay > 0) error.retryAfterSeconds = dateDelay;
        }
        throw error;
      }
      try { return JSON.parse(text); } catch (_) {
        const error = new Error("服务返回了无法识别的 JSON");
        error.category = "invalid_response";
        throw error;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        if (signal.aborted) throw new Error("request cancelled");
        const timeout = new Error("服务请求超时");
        timeout.category = "timeout";
        throw timeout;
      }
      if (error instanceof TypeError) {
        const network = new Error("无法连接服务，请检查网络和扩展站点权限");
        network.category = "network_error";
        throw network;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.toLowerCase()) : [];
  }

  // One policy for every catalog. Adapters supply evidence, never a whitelist
  // of allowed model IDs. Absent metadata means unknown, not incompatible.
  function modelPolicy(provider, id, evidence, endpoint = "") {
    const incompatible = (reason) => ({ eligibility: "incompatible", reason });
    const { inputs, outputs, endpoints, methods } = evidence;
    if ((inputs.length && !inputs.includes("text")) || (outputs.length && !outputs.includes("text"))) {
      return incompatible("服务声明的输入/输出类型不支持文本到文本翻译");
    }
    const openaiProtocol = config.openaiProtocolForEndpoint(endpoint);
    const route = provider === "openai"
      ? (openaiProtocol === "chat-completions" ? "chat/completions" : "responses")
      : { deepseek: "chat/completions", gemini: "generatecontent" }[provider];
    if (route && endpoints.length && !endpoints.includes(route)) return incompatible("服务声明的接口与当前翻译协议不兼容");
    if (provider === "gemini" && methods.length && !methods.includes("generatecontent")) return incompatible("服务未声明 generateContent 支持");

    // Match task/family boundaries, not arbitrary substrings such as image or
    // audio: a multimodal text model remains useful for subtitle translation.
    if (/(^|[-_/.:])(embeddings?|rerank(?:er)?|moderation|whisper|transcrib(?:e|ing)|transcription|tts|realtime)([-_/.:]|$)/i.test(id)) {
      return incompatible("专用向量、排序、审核、语音或实时模型，不适用于当前字幕翻译接口");
    }
    if (/(^|\/)(chatgpt-image(?:-|$)|gpt-image-(?:\d|latest)|dall-e(?:-|$)|imagen(?:-|$)|veo(?:[.-]|$)|sora(?:-|$))/i.test(id)
      || /(^|[-_/.:])(image|video|speech)-(generation|generate)([-_/.:]|$)/i.test(id)
      || /(^|\/)gemini-.*-(image|native-audio)(?:-(?:preview|exp|latest|\d+))*$/i.test(id)) {
      return incompatible("专用图像、视频或音频生成模型，不适用于字幕翻译");
    }
    if (provider === "openai" && /(^|\/)gpt-(?:audio(?:-|$)|4o(?:-mini)?-audio(?:-|$)|live(?:-|$))/i.test(id)) {
      return incompatible(`此音频/实时模型不适用于当前 ${openaiProtocol === "chat-completions" ? "Chat Completions" : "Responses"} 翻译接口`);
    }
    const hasEvidence = (inputs.includes("text") && outputs.includes("text"))
      || endpoints.includes(route) || (provider === "gemini" && methods.includes("generatecontent"));
    return { eligibility: hasEvidence ? "candidate" : "unknown", reason: hasEvidence ? "目录能力符合候选条件，仍需验证服务" : "目录未提供完整能力信息，保留供验证" };
  }

  function applyCuratedRecommendation(provider, models) {
    const recommendation = config.MODEL_RECOMMENDATIONS?.[provider];
    const chosen = recommendation && models.find((model) => model.id === recommendation.modelId && model.eligibility !== "incompatible");
    return models.map((model) => ({
      ...model,
      recommended: !!chosen && model.id === chosen.id,
      recommendationReason: chosen && model.id === chosen.id ? recommendation.reason : "",
      recommendationReviewedAt: chosen && model.id === chosen.id ? recommendation.reviewedAt : "",
      recommendationSource: chosen && model.id === chosen.id ? recommendation.source : "",
    })).sort((a, b) => Number(b.recommended) - Number(a.recommended)
      || Number(a.eligibility === "incompatible") - Number(b.eligibility === "incompatible")
      || a.id.localeCompare(b.id));
  }

  function normalizeModels(provider, rows, endpoint = "") {
    const byId = new Map();
    for (const row of rows) {
      // Gemini's model resource name identifies the listed variant, while
      // baseModelId is the documented identifier to pass to generateContent.
      // Use the call-ready ID so discovery, saved selection, and translation
      // all refer to the same model.
      const rawId = provider === "gemini"
        ? (row?.baseModelId || row?.name || row?.id)
        : (row?.id || row?.name);
      const id = String(rawId || "").replace(/^models\//, "").trim();
      if (!id || byId.has(id)) continue;
      // Preserve only capability data, including optional proxy metadata, so
      // cached catalogs can be re-evaluated when the policy changes.
      const old = row.catalogCapabilities;
      const evidence = {
        inputs: stringList(old?.inputs ?? row.input_modalities ?? row.architecture?.input_modalities),
        outputs: stringList(old?.outputs ?? row.output_modalities ?? row.architecture?.output_modalities),
        endpoints: stringList(old?.endpoints ?? row.supported_endpoints).map((path) => path.replace(/^\/?v\d+\//, "").replace(/^\//, "")),
        methods: stringList(old?.methods ?? row.supportedGenerationMethods ?? row.supportedMethods),
      };
      byId.set(id, {
        id,
        displayName: String(row.displayName || row.name || id).replace(/^models\//, "").slice(0, 160),
        ...modelPolicy(provider, id, evidence, endpoint),
        catalogCapabilities: evidence,
      });
    }
    return applyCuratedRecommendation(provider, [...byId.values()]);
  }

  async function listModels(provider, endpoint, apiKey, signal) {
    if (!["openai", "deepseek", "gemini"].includes(provider)) return [];
    if (provider !== "gemini") {
      const data = await requestJson(config.endpointFor(provider, endpoint, "models"), provider, apiKey, signal);
      if (!Array.isArray(data?.data)) throw Object.assign(new Error("模型列表响应缺少 data 数组"), { category: "invalid_response" });
      return normalizeModels(provider, data.data, endpoint);
    }
    const seenTokens = new Set();
    const rows = [];
    let pageToken = "";
    const deadline = Date.now() + 30000;
    do {
      if (Date.now() > deadline) throw Object.assign(new Error("获取模型列表超过 30 秒"), { category: "timeout" });
      const url = new URL(config.endpointFor(provider, endpoint, "models"));
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const remainingMs = Math.max(1, Math.min(10000, deadline - Date.now()));
      const data = await requestJson(url.toString(), provider, apiKey, signal, remainingMs);
      if (!Array.isArray(data?.models)) throw Object.assign(new Error("Gemini 模型列表响应缺少 models 数组"), { category: "invalid_response" });
      rows.push(...data.models);
      pageToken = String(data.nextPageToken || "");
      if (pageToken && seenTokens.has(pageToken)) throw Object.assign(new Error("Gemini 模型分页返回重复 token"), { category: "invalid_response" });
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return normalizeModels(provider, rows, endpoint);
  }

  async function cacheId(provider, endpoint, apiKey) {
    let effectiveEndpoint = endpoint || "";
    try {
      effectiveEndpoint = provider === "deepl"
        ? config.deeplEndpointFor(endpoint, "usage", apiKey)
        : config.endpointFor(provider, endpoint, "models");
    }
    catch (_) { /* Invalid drafts are never used for a request; hash their exact value without normalizing. */ }
    const protocol = provider === "openai" ? config.openaiProtocolForEndpoint(endpoint) : "";
    const raw = new TextEncoder().encode(JSON.stringify([provider, effectiveEndpoint, protocol, apiKey || ""]));
    const digest = await crypto.subtle.digest("SHA-256", raw);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function readCache(id, provider, endpoint = "") {
    const values = await root.Echo360ExtensionApi.storage.local.get(CACHE_KEY);
    const cached = values[CACHE_KEY]?.[id];
    return cached ? { ...cached, models: normalizeModels(provider, Array.isArray(cached.models) ? cached.models : [], endpoint) } : null;
  }

  async function writeCache(id, catalog) {
    const values = await root.Echo360ExtensionApi.storage.local.get(CACHE_KEY);
    const entries = { ...(values[CACHE_KEY] || {}), [id]: catalog };
    const recent = Object.entries(entries).sort((a, b) => Number(b[1]?.fetchedAt || 0) - Number(a[1]?.fetchedAt || 0)).slice(0, MAX_CATALOGS);
    await root.Echo360ExtensionApi.storage.local.set({ [CACHE_KEY]: Object.fromEntries(recent) });
  }

  async function hasOriginPermission(url) {
    const permissions = root.chrome?.permissions;
    if (!permissions?.contains) return true;
    const origin = `${new URL(url).origin}/*`;
    return new Promise((resolve) => {
      permissions.contains({ origins: [origin] }, (granted) => resolve(!!granted));
    });
  }

  function isSetupUiSender(sender) {
    const expectedId = root.chrome?.runtime?.id;
    // Chrome omits frameId for some extension-owned views that are not tied
    // to a tab (notably the action popup). If it is supplied, only accept the
    // top-level frame; the exact extension URL check below remains mandatory.
    if (!sender?.id || sender.id !== expectedId || (sender.frameId != null && sender.frameId !== 0)) return false;
    const url = String(sender.url || "");
    const optionsUrl = root.chrome.runtime.getURL("options.html");
    const popupUrl = root.chrome.runtime.getURL("popup.html");
    return [optionsUrl, popupUrl].some((expected) => url === expected || url.startsWith(`${expected}?`));
  }

  function errorResult(error, apiKey) {
    const raw = String(error?.message || "服务请求失败");
    return {
      category: error?.category || (error?.httpStatus ? classifyError(error.httpStatus, raw) : error?.name === "AbortError" ? "timeout" : "network_error"),
      httpStatus: error?.httpStatus || 0,
      providerCode: String(error?.providerCode || "").slice(0, 100),
      retryAfterSeconds: error?.retryAfterSeconds || 0,
      message: apiKey ? raw.split(apiKey).join("[redacted]").slice(0, 300) : raw.slice(0, 300),
    };
  }

  async function handleMessage(message, sender) {
    if (!isSetupUiSender(sender)) return { ok: false, error: { category: "permission_denied", message: "不允许此页面执行服务诊断" } };
    const owner = sender.documentId || `${sender.url}|${sender.frameId}`;
    if (message.type === "provider-cancel") {
      const entry = active.get(message.requestId);
      if (entry?.owner === owner) entry.controller.abort();
      return { ok: true };
    }
    if (!["provider-discover", "provider-verify", "provider-cache"].includes(message.type)) return null;
    const input = message.payload || {};
    const provider = String(input.provider || "");
    if (!config.PROVIDERS.includes(provider)) return { ok: false, error: { category: "invalid_configuration", message: "不支持的翻译服务" } };
    const endpoint = String(input.endpoint || "").trim();
    const apiKey = config.KEYLESS_PROVIDERS.has(provider) ? "" : String(input.apiKey || "").trim();
    if (!config.KEYLESS_PROVIDERS.has(provider) && !apiKey) return { ok: false, error: { category: "invalid_key", message: "请先填写 API Key" } };
    const id = provider === "google-web" ? "" : await cacheId(provider, endpoint, apiKey);
    if (message.type === "provider-cache") return { ok: true, data: id ? await readCache(id, provider, endpoint) : null };

    const requestId = String(message.requestId || "");
    if (!requestId) return { ok: false, error: { category: "invalid_configuration", message: "缺少诊断请求编号" } };
    const controller = new AbortController();
    active.set(requestId, { owner, controller });
    try {
      if (message.type === "provider-discover") {
        if (provider === "google-web") return { ok: true, data: { models: [], credentialStatus: "not_required", fetchedAt: Date.now() } };
        const catalogUrl = provider === "deepl"
          ? config.deeplEndpointFor(endpoint, "usage", apiKey)
          : config.endpointFor(provider, endpoint, "models");
        if (!await hasOriginPermission(catalogUrl)) return { ok: false, error: { category: "host_permission_required", message: "请点击“刷新模型”或“点此验证服务”并允许访问此服务地址" } };
        let data;
        let models;
        try {
          data = provider === "deepl" ? await requestJson(catalogUrl, provider, apiKey, controller.signal) : null;
          models = data ? [] : await listModels(provider, endpoint, apiKey, controller.signal);
        } catch (error) {
          if (error.httpStatus === 404) error.category = provider === "deepl" ? "invalid_configuration" : "discovery_unavailable";
          throw error;
        }
        const result = { models, usage: data ? { characterCount: data.character_count, characterLimit: data.character_limit } : null, credentialStatus: "accepted_by_discovery", fetchedAt: Date.now() };
        if (id) await writeCache(id, result);
        return { ok: true, data: result };
      }
      if (provider !== "google-web" && provider !== "deepl" && !String(input.model || "").trim()) {
        return { ok: false, error: { category: "invalid_configuration", message: "请先选择或输入模型" } };
      }
      const translationUrl = provider === "deepl"
        ? config.deeplEndpointFor(endpoint, "translate", apiKey)
        : config.endpointFor(provider, endpoint, "translate", input.model || "");
      if (!await hasOriginPermission(translationUrl)) return { ok: false, error: { category: "host_permission_required", message: "请点击“点此验证服务”并允许访问此服务地址" } };
      const data = await root.Echo360DirectTranslator.probeTranslation({ ...input, provider, endpoint, api_key: apiKey, abortSignal: controller.signal });
      return { ok: true, data: { translation: data.translation, verifiedAt: Date.now(), execution: input.useLocalBackend ? "provider_direct" : "provider_direct" } };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: { category: "cancelled", message: "已取消" } };
      if (!error.category && /服务地址|凭据写在|用户名、密码|协议/.test(String(error.message || ""))) error.category = "invalid_configuration";
      return { ok: false, error: errorResult(error, apiKey) };
    } finally {
      if (active.get(requestId)?.controller === controller) active.delete(requestId);
    }
  }

  root.Echo360ProviderCatalog = { CACHE_KEY, CACHE_TTL_MS, classifyError, normalizeModels, listModels, cacheId, handleMessage };
})();
