globalThis.Echo360DirectTranslator = (() => {
  const AI_LINE_SEPARATOR = "\n<<<VTT_TRANSLATOR_LINE_BREAK_8F3B>>>\n";
  const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  const PROVIDER_ADAPTERS = {
    openai: {
      id: "openai",
      protocol: "openai-responses",
      defaultModel: "",
      defaultEndpoint: "https://api.openai.com",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "Authorization": `Bearer ${apiKey}` };
      },
    },
    deepseek: {
      id: "deepseek",
      protocol: "chat-completions",
      defaultModel: "",
      defaultEndpoint: "https://api.deepseek.com",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "Authorization": `Bearer ${apiKey}` };
      },
      buildExtraBody(cfg) {
        const mode = String(cfg.deepseek_thinking_mode || cfg.deepseekThinkingMode || "disabled").toLowerCase();
        if (mode === "disabled") return { thinking: { type: "disabled" } };
        if (mode === "enabled" || mode === "with-thinking") return { thinking: { type: "enabled" } };
        return {};
      },
    },
    gemini: {
      id: "gemini",
      protocol: "gemini-generate-content",
      defaultModel: "",
      defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "x-goog-api-key": apiKey };
      },
    },
    deepl: {
      id: "deepl",
      protocol: "deepl-translate",
      defaultModel: "",
      defaultEndpoint: "https://api-free.deepl.com/v2/translate",
      authHeaders(apiKey) {
        return { "Authorization": `DeepL-Auth-Key ${apiKey}` };
      },
    },
    "google-web": {
      id: "google-web",
      protocol: "google-web",
      defaultModel: "",
      defaultEndpoint: "https://translate.googleapis.com/translate_a/single",
      keyless: true,
      supportsRecursiveFallback: true,
      concurrencyCap: 96,
      authHeaders() {
        return {};
      },
    },
  };
  const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

  function isTimecode(line) {
    return /^\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/.test(line);
  }

  function shouldTranslate(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return false;
    if (/^WEBVTT/i.test(trimmed) || /^\d+$/.test(trimmed) || isTimecode(trimmed)) return false;
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) return false;
    return true;
  }

  function splitVoiceTag(line) {
    const match = String(line || "").match(/^(\s*<v\b[^>]*>)(.*?)(<\/v>\s*)?$/);
    if (!match) return ["", String(line || "").trim(), ""];
    return [match[1] || "", (match[2] || "").trim(), match[3] || ""];
  }

  function formatTargetLanguage(target) {
    const code = String(target || "ZH").trim().toUpperCase();
    if (code === "YUE" || code === "CANTONESE") {
      return "Traditional Cantonese (Yue Chinese), using Traditional Chinese characters and natural spoken Cantonese phrasing";
    }
    if (code === "ZH-HK") {
      return "Traditional Chinese, using native Traditional Chinese wording, punctuation, and style";
    }
    if (code === "ZH") return "Simplified Chinese";
    return code;
  }

  function normalizeProvider(provider) {
    const name = String(provider || "google-web").trim().toLowerCase();
    if (!PROVIDER_ADAPTERS[name]) throw new Error(`Unsupported provider: ${name}`);
    return name;
  }

  function getProviderAdapter(provider) {
    return PROVIDER_ADAPTERS[normalizeProvider(provider)];
  }

  function providerDefault(provider, key) {
    const adapter = getProviderAdapter(provider);
    if (key === "model") return adapter.defaultModel;
    if (key === "endpoint") return root.Echo360ProviderConfig?.DEFAULT_ENDPOINTS?.[provider] || adapter.defaultEndpoint;
    return "";
  }

  function providerConcurrencyCap(provider) {
    return getProviderAdapter(provider).concurrencyCap || 96;
  }

  function resolveModel(cfg) {
    const model = String(cfg.model || "").trim() || providerDefault(cfg.provider, "model");
    if (["openai", "deepseek", "gemini"].includes(normalizeProvider(cfg.provider)) && !model) {
      throw new Error("请先获取并选择一个模型，或手动输入模型 ID");
    }
    return model;
  }

  function resolveOpenAiReasoningEffort(model, rawEffort) {
    const requested = String(rawEffort || "").trim().toLowerCase();
    if (!requested) return "";
    if (!OPENAI_REASONING_EFFORTS.has(requested)) throw new Error(`reasoning_effort '${requested}' is unsupported`);
    return requested;
  }

  function buildTextBatches(items, maxParagraphs, maxChars) {
    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const item of items) {
      const textLen = item.text.length;
      const wouldExceedChars = maxChars > 0 && current.length > 0 && currentChars + textLen > maxChars;
      const wouldExceedParagraphs = maxParagraphs > 0 && current.length >= maxParagraphs;
      if (wouldExceedChars || wouldExceedParagraphs) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += textLen;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  function stripCodeFence(rawText) {
    let text = String(rawText || "").trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    }
    return text.trim();
  }

  function buildDelimitedPrompt(texts, target) {
    const targetText = formatTargetLanguage(target);
    return {
      system: [
        `You are a professional ${targetText} native translator.`,
        "Output only translated content, with no explanations or extra text.",
        "Keep exactly the same number of paragraphs/items as input.",
        "Keep non-translatable content unchanged, including proper nouns, code, URLs, and course codes.",
        "Do not merge, split, drop, or reorder any item.",
        `For multi-item input, use '${AI_LINE_SEPARATOR.trim()}' as the separator between translated items.`,
      ].join("\n"),
      user: [
        `Translate to ${targetText}. Return only translation text with exact item count and order.`,
        "Input:",
        texts.join(AI_LINE_SEPARATOR),
      ].join("\n"),
    };
  }

  function buildIndexedJsonPrompt(texts, target) {
    const targetText = formatTargetLanguage(target);
    const payload = texts.map((text, i) => ({ i, text }));
    return {
      system: "You are a subtitle translation engine. Output ONLY a JSON array. Each item must be an object with keys i and text. Do not drop, merge, reorder, or add items.",
      user: [
        `Translate each text to ${targetText}. Keep indexes unchanged.`,
        `Input JSON:\n${JSON.stringify(payload)}`,
        "Return JSON array only.",
      ].join("\n"),
    };
  }

  function parseDelimitedOutput(rawText, expectedLen) {
    const text = stripCodeFence(rawText);
    let parts = text.split(AI_LINE_SEPARATOR).map((part) => part.trim());
    if (parts.length !== expectedLen) {
      parts = text.split(AI_LINE_SEPARATOR.trim()).map((part) => part.trim());
    }
    if (parts.length !== expectedLen) {
      throw new Error(`AI output length mismatch: expected ${expectedLen}, got ${parts.length}`);
    }
    return parts;
  }

  function parseIndexedJsonOutput(rawText, expectedLen) {
    const parsed = JSON.parse(stripCodeFence(rawText));
    if (!Array.isArray(parsed)) throw new Error("Model output is not a JSON array");
    const out = new Map();
    for (const item of parsed) {
      if (item && Number.isInteger(item.i) && typeof item.text === "string") {
        out.set(item.i, item.text.trim());
      }
    }
    if (out.size !== expectedLen) {
      throw new Error(`AI output length mismatch: expected ${expectedLen}, got ${out.size}`);
    }
    return Array.from({ length: expectedLen }, (_, i) => out.get(i) || "");
  }

  function normalizeOpenAiEndpoint(endpoint, adapter) {
    return globalThis.Echo360ProviderConfig.endpointFor("openai", endpoint || adapter.defaultEndpoint, "translate");
  }

  function normalizeChatCompletionsEndpoint(endpoint, adapter) {
    return globalThis.Echo360ProviderConfig.endpointFor(adapter.id, endpoint || adapter.defaultEndpoint, "translate");
  }

  function normalizeGeminiEndpoint(endpoint, model, adapter) {
    return globalThis.Echo360ProviderConfig.endpointFor("gemini", endpoint || adapter.defaultEndpoint, "translate", model);
  }

  function normalizeGoogleWebEndpoint(endpoint) {
    return String(endpoint || providerDefault("google-web", "endpoint")).trim().replace(/\?+$/, "");
  }

  function resolveWebTargetLang(target) {
    const code = String(target || "ZH").trim().toUpperCase();
    const map = {
      ZH: "zh-CN",
      "ZH-HK": "zh-TW",
      YUE: "yue",
      EN: "en",
      JA: "ja",
      KO: "ko",
      FR: "fr",
      DE: "de",
      ES: "es",
      IT: "it",
      PT: "pt",
      RU: "ru",
      AR: "ar",
      HI: "hi",
    };
    return map[code] || code.toLowerCase();
  }

  function normalizeFallbackMode(mode) {
    const value = String(mode || "immediate").trim().toLowerCase();
    return ["immediate", "deferred", "deferred-fastpath"].includes(value) ? value : "immediate";
  }

  function sleep(ms, isCancelled = () => false) {
    if (isCancelled()) return Promise.reject(new Error("translation cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (isCancelled()) reject(new Error("translation cancelled"));
        else resolve();
      }, ms);
      if (isCancelled()) {
        clearTimeout(timer);
        reject(new Error("translation cancelled"));
      }
    });
  }

  function createRateLimiter(rps, isCancelled = () => false) {
    const rate = Number(rps) || 0;
    if (rate <= 0) return async () => {};

    const gapMs = 1000 / rate;
    let nextAt = 0;
    let chain = Promise.resolve();

    return () => {
      const run = chain.then(async () => {
        const now = Date.now();
        const waitMs = Math.max(0, nextAt - now);
        nextAt = Math.max(now, nextAt) + gapMs;
        if (isCancelled()) throw new Error("translation cancelled");
        if (waitMs > 0) await sleep(waitMs, isCancelled);
      });
      chain = run.catch(() => {});
      return run;
    };
  }

  async function fetchJson(url, init, timeoutSeconds, waitForRequest = async () => {}, isCancelled = () => false, abortSignal = null) {
    if (isCancelled()) throw new Error("translation cancelled");
    await waitForRequest();
    if (isCancelled()) throw new Error("translation cancelled");
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutSeconds) || 30) * 1000);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
      const text = await resp.text();
      if (!resp.ok) {
        let details = text;
        try {
          const parsed = JSON.parse(text);
          details = parsed?.error?.message || parsed?.message || text;
        } catch (_) { details = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "); }
        const headerEntries = typeof Headers !== "undefined" && init.headers instanceof Headers
          ? Array.from(init.headers.entries())
          : Object.entries(init.headers || {});
        const credential = headerEntries.find(([name]) => /^(authorization|x-goog-api-key)$/i.test(name))?.[1];
        const secret = String(credential || "").replace(/^(?:Bearer|DeepL-Auth-Key)\s+/i, "");
        const redacted = secret ? String(details || "").split(secret).join("[redacted]") : String(details || "");
        const message = String(redacted || `HTTP ${resp.status}`).replace(/\s+/g, " ").slice(0, 300);
        const err = new Error(`HTTP ${resp.status}: ${message}`);
        err.httpStatus = resp.status;
        const normalized = message.toLowerCase();
        err.category = resp.status === 401 ? "invalid_key"
          : resp.status === 403 ? (/quota|billing|credit/.test(normalized) ? "quota_exceeded" : "permission_denied")
            : resp.status === 429 ? (/quota|billing|credit/.test(normalized) ? "quota_exceeded" : "rate_limited")
              : resp.status === 404 ? "model_unavailable"
                : resp.status === 400 ? "invalid_configuration" : resp.status >= 500 ? "network_error" : "invalid_response";
        const retryAfter = Number(resp.headers?.get?.("Retry-After"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error("Provider returned non-JSON response");
      }
    } finally {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortHandler);
    }
  }

  function extractOpenAiText(data) {
    if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
    const chunks = [];
    for (const item of data.output || []) {
      for (const content of item.content || []) {
        if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
      }
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
    throw new Error("OpenAI response missing output text");
  }

  function extractChatText(data) {
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text;
    throw new Error("Chat response missing choices[0].message.content");
  }

  function extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((part) => part?.thought !== true).map((part) => part?.text || "").join("").trim();
    if (text) return text;
    throw new Error("Gemini response missing candidates[0].content.parts text");
  }

  function extractGoogleWebLines(data, expectedCount) {
    const chunks = Array.isArray(data?.[0]) ? data[0] : [];
    const text = chunks.map((item) => Array.isArray(item) ? item[0] || "" : "").join("").trim();
    if (!text) throw new Error("Google Translate response missing translated text");
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length !== expectedCount) {
      throw new Error(`Google Translate returned ${lines.length} lines for ${expectedCount} inputs`);
    }
    return lines;
  }

  async function callOpenAi(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const model = resolveModel(cfg);
    const effort = resolveOpenAiReasoningEffort(model, cfg.reasoning_effort || cfg.reasoningEffort);
    const body = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt.system }] },
        { role: "user", content: [{ type: "input_text", text: prompt.user }] },
      ],
      ...(effort ? { reasoning: { effort } } : {}),
    };
    const data = await fetchJson(normalizeOpenAiEndpoint(cfg.endpoint, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, cfg.timeout, cfg.waitForRequest, cfg.isCancelled, cfg.abortSignal);
    return extractOpenAiText(data);
  }

  async function callChatCompletions(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const openAiEffort = adapter.id === "openai"
      ? resolveOpenAiReasoningEffort(resolveModel(cfg), cfg.reasoning_effort || cfg.reasoningEffort)
      : "";
    const body = {
      model: resolveModel(cfg),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      ...(adapter.id === "openai" ? {} : { temperature: 0 }),
      ...(openAiEffort ? { reasoning_effort: openAiEffort } : {}),
      ...(adapter.buildExtraBody ? adapter.buildExtraBody(cfg) : {}),
    };
    const data = await fetchJson(normalizeChatCompletionsEndpoint(cfg.endpoint, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, cfg.timeout, cfg.waitForRequest, cfg.isCancelled, cfg.abortSignal);
    return extractChatText(data);
  }

  async function callGemini(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const model = resolveModel(cfg);
    const data = await fetchJson(normalizeGeminiEndpoint(cfg.endpoint, model, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: { temperature: 0 },
      }),
    }, cfg.timeout, cfg.waitForRequest, cfg.isCancelled, cfg.abortSignal);
    return extractGeminiText(data);
  }

  async function callDeepL(texts, cfg, adapter) {
    const endpoint = globalThis.Echo360ProviderConfig.deeplEndpointFor(cfg.endpoint || "", "translate", cfg.api_key);
    const body = new URLSearchParams();
    for (const text of texts) body.append("text", text);
    body.set("target_lang", String(cfg.target || "ZH").toUpperCase() === "ZH-HK" ? "ZH-HANT" : (cfg.target || "ZH"));
    body.set("preserve_formatting", "1");
    body.set("split_sentences", "1");
    const formality = String(cfg.deepl_formality || cfg.deeplFormality || "").trim();
    if (formality) body.set("formality", formality);
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }, cfg.timeout, cfg.waitForRequest, cfg.isCancelled, cfg.abortSignal);
    return (data.translations || []).map((item) => item.text || "");
  }

  async function callGoogleWeb(texts, cfg, adapter) {
    const endpoint = normalizeGoogleWebEndpoint(cfg.endpoint || adapter.defaultEndpoint);
    const target = resolveWebTargetLang(cfg.target);
    const requestText = texts.join("\n");
    const url = new URL(endpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", target);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", requestText);
    const data = await fetchJson(url, {
      method: "GET",
      headers: { "Accept": "application/json,text/plain,*/*" },
    }, cfg.timeout, cfg.waitForRequest, cfg.isCancelled, cfg.abortSignal);
    return extractGoogleWebLines(data, texts.length);
  }

  async function translateBatch(texts, cfg, options = {}) {
    const adapter = getProviderAdapter(cfg.provider);
    if (adapter.protocol === "deepl-translate") return callDeepL(texts, cfg, adapter);
    if (adapter.protocol === "google-web") return callGoogleWeb(texts, cfg, adapter);
    const protocolCalls = {
      "openai-responses": callOpenAi,
      "chat-completions": callChatCompletions,
      "gemini-generate-content": callGemini,
    };
    const selectedProtocol = adapter.id === "openai" && globalThis.Echo360ProviderConfig.openaiProtocolForEndpoint(cfg.endpoint || adapter.defaultEndpoint) === "chat-completions"
      ? "chat-completions"
      : adapter.protocol;
    const call = protocolCalls[selectedProtocol];
    if (!call) throw new Error(`Unsupported provider protocol: ${adapter.protocol}`);
    const raw = await call(texts, cfg, adapter, false);
    try {
      return parseDelimitedOutput(raw, texts.length);
    } catch (_) {
      if (options.jsonFallback === false) throw _;
      const jsonRaw = await call(texts, cfg, adapter, true);
      return parseIndexedJsonOutput(jsonRaw, texts.length);
    }
  }

  function supportsRecursiveFallback(provider) {
    return !!getProviderAdapter(provider).supportsRecursiveFallback;
  }

  function isNonRecoverableError(message) {
    const msg = String(message || "");
    return (
      /HTTP (400|401|403|404|422)\b/.test(msg) ||
      msg.includes("reasoning_effort")
    );
  }

  function isCancellationError(message) {
    return String(message || "").toLowerCase().includes("translation cancelled");
  }

  async function translateBatchChecked(texts, cfg, options = {}) {
    const started = Date.now();
    const translated = await translateBatch(texts, cfg, options);
    const elapsedSeconds = (Date.now() - started) / 1000;
    const threshold = Math.max(0, Number(cfg.slow_split_threshold ?? cfg.slowSplitThreshold) || 0);
    if (
      threshold > 0 &&
      texts.length > 1 &&
      supportsRecursiveFallback(cfg.provider) &&
      elapsedSeconds > threshold
    ) {
      throw new Error(`slow batch ${elapsedSeconds.toFixed(3)}s>${threshold.toFixed(3)}s, split retry`);
    }
    return translated;
  }

  async function translateBatchRecursive(texts, cfg, retries, warnings, label) {
    try {
      return await withRetries(() => translateBatchChecked(texts, cfg, { jsonFallback: true }), retries, cfg.isCancelled);
    } catch (err) {
      const message = err?.message || String(err);
      if (cfg.isCancelled() || isCancellationError(message)) throw new Error("translation cancelled");
      if (isNonRecoverableError(message)) throw err;
      if (supportsRecursiveFallback(cfg.provider) && texts.length > 1) {
        const mid = Math.floor(texts.length / 2);
        const left = await translateBatchRecursive(texts.slice(0, mid), cfg, retries, warnings, `${label} left`);
        const right = await translateBatchRecursive(texts.slice(mid), cfg, retries, warnings, `${label} right`);
        warnings.push(`${label} split fallback: ${message}`);
        return [...left, ...right];
      }
      if (supportsRecursiveFallback(cfg.provider) && texts.length === 1) {
        warnings.push(`${label} single item failed, kept original: ${message}`);
        return [texts[0]];
      }
      throw err;
    }
  }

  async function withRetries(fn, retries, isCancelled = () => false) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (isCancelled()) throw new Error("translation cancelled");
        if (attempt < retries) await sleep(700 * (attempt + 1), isCancelled);
      }
    }
    throw lastErr;
  }

  async function translateVtt(payload, progressHandler = {}) {
    const handlers = typeof progressHandler === "function"
      ? { onProgress: progressHandler }
      : (progressHandler || {});
    const onProgress = handlers.onProgress || (() => {});
    const onPartialVtt = handlers.onPartialVtt || (() => {});
    const partialEmitIntervalMs = Math.max(0, Number(handlers.partialEmitIntervalMs) || 400);
    let lastPartialEmitAt = 0;

    function emitPartialVtt(force = false) {
      if (!onPartialVtt) return;
      const now = Date.now();
      if (!force && partialEmitIntervalMs > 0 && now - lastPartialEmitAt < partialEmitIntervalMs) return;
      lastPartialEmitAt = now;
      onPartialVtt(translatedLines.join("\n"), {
        completed,
        total: items.length,
        done: !!force,
      });
    }

    const cfg = {
      ...payload,
      provider: normalizeProvider(payload.provider),
      isCancelled: handlers.isCancelled || (() => false),
      abortSignal: handlers.abortSignal || null,
    };
    if (["openai", "deepseek", "gemini"].includes(cfg.provider) && !String(payload.model || "").trim()) {
      throw new Error("请先获取并选择一个模型，或手动输入模型 ID");
    }
    cfg.waitForRequest = createRateLimiter(Number(payload.rps) || 0, cfg.isCancelled);
    const lines = String(payload.vtt_text || "").replace(/\r/g, "").split("\n");
    const items = [];
    const lineParts = new Map();
    lines.forEach((line, index) => {
      if (!shouldTranslate(line)) return;
      const [prefix, body, suffix] = splitVoiceTag(line);
      lineParts.set(index, { prefix, suffix });
      items.push({ index, text: body });
    });
    if (items.length === 0) throw new Error("VTT 中没有可翻译文本");

    const maxParagraphs = Number(payload.max_paragraphs) || 6;
    const maxChars = Number(payload.max_chars) || 1200;
    const batches = buildTextBatches(items, maxParagraphs, maxChars);
    const translatedLines = [...lines];
    const warnings = [];
    const deferredFailures = [];
    let completed = 0;
    let nextBatch = 0;
    const fallbackMode = normalizeFallbackMode(cfg.fallback_mode || cfg.fallbackMode);
    const workers = Math.max(1, Math.min(Number(cfg.concurrency) || 3, providerConcurrencyCap(cfg.provider), batches.length));
    const retries = Math.max(0, Number(cfg.retries) || 0);
    const repairConcurrency = Math.max(1, Math.min(Number(cfg.repair_concurrency ?? cfg.repairConcurrency) || 1, 96));

    function reportProgress() {
      onProgress(completed, items.length, `[${completed}/${items.length}] Translating...`);
    }

    function applyBatchResult(batch, translated) {
      if (translated.length !== batch.length) {
        throw new Error(`Provider returned ${translated.length} items for ${batch.length} inputs`);
      }
      translated.forEach((text, i) => {
        const item = batch[i];
        const parts = lineParts.get(item.index) || { prefix: "", suffix: "" };
        translatedLines[item.index] = `${parts.prefix}${text}${parts.suffix}`;
      });
      completed += batch.length;
      reportProgress();
      emitPartialVtt(false);
    }

    function keepOriginalBatch(batch) {
      batch.forEach((item) => {
        translatedLines[item.index] = item.text;
      });
      completed += batch.length;
      reportProgress();
      emitPartialVtt(false);
    }

    async function worker() {
      while (nextBatch < batches.length) {
        if (cfg.isCancelled()) throw new Error("translation cancelled");
        const batchNo = nextBatch;
        nextBatch += 1;
        const batch = batches[batchNo];
        const texts = batch.map((item) => item.text);
        try {
          if (fallbackMode === "immediate") {
            const translated = await translateBatchRecursive(
              texts,
              cfg,
              retries,
              warnings,
              `batch ${batchNo + 1}/${batches.length}`
            );
            applyBatchResult(batch, translated);
          } else {
            const translated = await withRetries(
              () => translateBatchChecked(texts, cfg, { jsonFallback: fallbackMode !== "deferred-fastpath" }),
              retries,
              cfg.isCancelled
            );
            applyBatchResult(batch, translated);
          }
        } catch (err) {
          const message = err?.message || String(err);
          if (cfg.isCancelled() || isCancellationError(message)) throw new Error("translation cancelled");
          if (isNonRecoverableError(message)) throw err;
          if (fallbackMode === "immediate") {
            warnings.push(`batch ${batchNo + 1}/${batches.length} failed: ${message}`);
            keepOriginalBatch(batch);
          } else {
            deferredFailures.push({ batchNo, batch, texts, error: message });
          }
        }
      }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (fallbackMode !== "immediate" && deferredFailures.length > 0) {
      warnings.push(`${fallbackMode} repair phase: ${deferredFailures.length} failed batch(es)`);
      let nextRepair = 0;
      const repairWorkers = Math.min(repairConcurrency, deferredFailures.length);

      async function repairWorker() {
        while (nextRepair < deferredFailures.length) {
          if (cfg.isCancelled()) throw new Error("translation cancelled");
          const item = deferredFailures[nextRepair];
          nextRepair += 1;
          try {
            let translated;
            if (fallbackMode === "deferred-fastpath") {
              translated = await withRetries(
                () => translateBatchChecked(item.texts, cfg, { jsonFallback: true }),
                retries,
                cfg.isCancelled
              );
            } else {
              translated = await translateBatchRecursive(
                item.texts,
                cfg,
                retries,
                warnings,
                `repair batch ${item.batchNo + 1}/${batches.length}`
              );
            }
            applyBatchResult(item.batch, translated);
          } catch (err) {
            const message = err?.message || String(err);
            if (cfg.isCancelled() || isCancellationError(message)) throw new Error("translation cancelled");
            if (isNonRecoverableError(message)) throw err;
            warnings.push(`repair batch ${item.batchNo + 1}/${batches.length} failed: ${message}`);
            keepOriginalBatch(item.batch);
          }
        }
      }

      await Promise.all(Array.from({ length: repairWorkers }, () => repairWorker()));
    }
    const translatedVtt = translatedLines.join("\n");
    const target = String(payload.target || "").toUpperCase();
    if ((target === "ZH" || target === "ZH-HK" || target === "YUE") && !CJK_RE.test(translatedVtt)) {
      const firstWarning = warnings[0] ? `; first warning: ${warnings[0]}` : "";
      throw new Error(`Provider did not return Chinese subtitles${firstWarning}`);
    }
    emitPartialVtt(true);
    return { translated_vtt: translatedVtt, warnings, cache_hit: false };
  }

  async function probeTranslation(payload) {
    const provider = normalizeProvider(payload.provider);
    const text = String(payload.target || "").toUpperCase() === "EN"
      ? "La lección comienza a las nueve."
      : "The lecture begins at nine.";
    const cfg = {
      ...payload,
      provider,
      timeout: Math.min(30, Math.max(1, Number(payload.timeout) || 30)),
      isCancelled: () => !!payload.abortSignal?.aborted,
      waitForRequest: async () => {},
    };
    if (["openai", "deepseek", "gemini"].includes(provider) && !String(payload.model || "").trim()) {
      throw Object.assign(new Error("请先选择或输入模型 ID"), { category: "invalid_configuration" });
    }
    const translated = await translateBatch([text], cfg, { jsonFallback: false });
    const result = String(translated?.[0] || "").trim();
    if (!result || result.toLowerCase() === text.toLowerCase()) {
      throw Object.assign(new Error("服务返回了空文本或未翻译的原文"), { category: "invalid_response" });
    }
    const target = String(payload.target || "").toUpperCase();
    if (["ZH", "ZH-HK", "YUE"].includes(target) && !CJK_RE.test(result)) {
      throw Object.assign(new Error("返回内容不符合所选目标语言"), { category: "invalid_response" });
    }
    return { translation: result };
  }

  return { translateVtt, probeTranslation, getProviderAdapter };
})();
