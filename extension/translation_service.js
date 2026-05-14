(() => {
  const ns = window.Echo360Translator;

  async function resolveSourceVtt(initialVideo) {
    let vttText = "";
    let sourceId = "";
    let sourceMeta = null;

    const trackEl = ns.sourceFinder.findBestTrackElement(initialVideo);
    if (trackEl?.getAttribute("src")) {
      const vttUrl = new URL(trackEl.getAttribute("src"), location.href).toString();
      const resp = await fetch(vttUrl, { credentials: "include" });
      if (!resp.ok) throw new Error(`拉取 VTT 失败: HTTP ${resp.status}`);
      vttText = await resp.text();
      sourceId = vttUrl;
      sourceMeta = ns.sourceFinder.buildSourceMeta(sourceId, vttText);
    }

    if (!vttText) {
      vttText = await ns.sourceFinder.exportVttFromTextTracks(initialVideo, 8000);
      if (vttText) sourceMeta = ns.sourceFinder.buildSourceMeta("", vttText);
    }

    if (!vttText) {
      const started = Date.now();
      while (!vttText && Date.now() - started < 12000) {
        const cand = await ns.sourceFinder.fetchBestVttFromCandidates(ns.video.getPrimaryVideo() || initialVideo);
        if (cand.text) {
          vttText = cand.text;
          sourceId = cand.sourceId;
          sourceMeta = cand.sourceMeta || ns.sourceFinder.buildSourceMeta(sourceId, vttText);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!vttText) {
      const cands = ns.sourceFinder.collectCandidateSubtitleUrls();
      console.warn("[echo360-translator] no usable VTT; candidates=", cands.map((c) => c.url));
      throw new Error("未找到可用字幕源（没有抓到有效 VTT）");
    }

    return {
      vttText,
      sourceId,
      sourceMeta: sourceMeta || ns.sourceFinder.buildSourceMeta(sourceId, vttText),
    };
  }

  function buildTranslatePayload(cfg, vttText, forceRefresh) {
    return {
      vtt_text: vttText,
      api_key: cfg.apiKey,
      provider: cfg.provider,
      model: cfg.model,
      endpoint: cfg.endpoint || "",
      target: cfg.target,
      max_paragraphs: Number(cfg.maxParagraphs) || 6,
      max_chars: Number(cfg.maxChars) || 1200,
      concurrency: Number(cfg.concurrency) || 96,
      rps: Number(cfg.rps) || 0,
      retries: Number(cfg.retries) || 1,
      bilingual: false,
      timeout: Number(cfg.timeout) || null,
      reasoning_effort: cfg.reasoningEffort || null,
      fallback_mode: cfg.fallbackMode || "immediate",
      repair_concurrency: Number(cfg.repairConcurrency) || 1,
      slow_split_threshold: Number(cfg.slowSplitThreshold) || 0,
      deepseek_thinking_mode: cfg.deepseekThinkingMode || "omit",
      deepl_formality: cfg.deeplFormality || "",
      force_refresh: !!forceRefresh,
    };
  }

  async function translateWithBackend(backendUrl, payload, options = {}) {
    try {
      const create = await ns.backendClient.proxyRequest(backendUrl, "/translate-async", "POST", payload);
      return await ns.backendClient.waitJob(backendUrl, create.job_id, {
        isActive: options.isActive || (() => true),
        onProgress: options.onProgress || (() => {}),
      });
    } catch (asyncErr) {
      const msg = String(asyncErr?.message || asyncErr || "");
      if (!msg.includes("HTTP 404")) throw asyncErr;
      if (options.onSyncFallback) options.onSyncFallback();
      return await ns.backendClient.proxyTranslateSync(backendUrl, payload);
    }
  }

  async function translateInExtension(payload, options = {}) {
    const create = await ns.backendClient.createDirectTranslateJob(payload);
    return await ns.backendClient.waitDirectJob(create.job_id, {
      isActive: options.isActive || (() => true),
      onProgress: options.onProgress || (() => {}),
    });
  }

  async function translateWithConfig(cfg, backendUrl, payload, options = {}) {
    if (cfg.useLocalBackend) {
      return await translateWithBackend(backendUrl, payload, options);
    }
    return await translateInExtension(payload, options);
  }

  async function buildCacheKey(cfg, sourceId, vttText) {
    const vttHash = await ns.storage.sha256Text(vttText);
    const sourceKey = sourceId || `${location.href}#${vttHash}`;
    const configSig = ns.storage.buildConfigSignature(cfg);
    return {
      sourceKey,
      configSig,
      cacheKey: `${sourceKey}::${configSig}`,
    };
  }

  ns.translationService = {
    resolveSourceVtt,
    buildTranslatePayload,
    translateWithBackend,
    translateInExtension,
    translateWithConfig,
    buildCacheKey,
  };
})();
