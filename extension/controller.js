(() => {
  const ns = window.Echo360Translator;
  const { DEFAULT_SUBTITLE_SIZE } = ns.constants;

  let activeRunId = null;
  let isTranslating = false;
  let loadedCacheKey = "";
  let trackSyncTimer = null;

  async function onTargetChanged(event) {
    const cfg = await ns.storage.getConfig();
    cfg.target = (event.target.value || "ZH").toUpperCase();
    await ns.storage.saveConfig(cfg);
    ns.ui.setStatusText(`目标语言已改为 ${cfg.target}`);
  }

  async function onPrefsChanged() {
    const oldPrefs = await ns.storage.getPrefs();
    const prefs = ns.ui.readPanelPrefs();
    await ns.storage.savePrefs(prefs);
    ns.renderer.applySubtitleSize(prefs.size);

    const renderState = ns.renderer.getRenderState();
    if (
      renderState.lastRenderedVtt &&
      (
        oldPrefs.bilingual !== prefs.bilingual ||
        oldPrefs.reverseOrder !== prefs.reverseOrder ||
        oldPrefs.size !== prefs.size
      )
    ) {
      ns.renderer.renderTranslatedTrack(
        renderState.lastRenderedVtt,
        renderState.lastOriginalVtt,
        prefs.bilingual,
        prefs.size,
        prefs.reverseOrder,
        renderState.lastRenderSourceMeta
      );
    }
    ns.renderer.applySubtitleVisibility(prefs.enabled);
  }

  async function onClickTranslate(forceRefresh = false) {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (isTranslating) {
      ns.ui.setStatusText("已有翻译任务在进行中，请稍候...");
      return;
    }
    isTranslating = true;
    activeRunId = runId;

    try {
      ns.ui.updateActionButtons(forceRefresh ? "重新翻译中..." : "处理中...", true);
      ns.ui.setStatusText(forceRefresh ? "强制重新翻译..." : "准备翻译...");

      const video = await ns.video.waitForVideo(15000);
      if (!video) throw new Error("未找到播放器 video 元素（15s 超时）");
      if (forceRefresh) ns.renderer.cleanupTranslatedTracks();

      if (!forceRefresh && ns.renderer.hasRenderedTranslatedTrack()) {
        ns.renderer.applySubtitleVisibility(true);
        ns.ui.updateActionButtons("翻译字幕已加载");
        ns.ui.setStatusText("当前翻译字幕已在页面中");
        return;
      }

      const { vttText, sourceId, sourceMeta } = await ns.translationService.resolveSourceVtt(video);
      let cfg = await ns.storage.getConfig();
      cfg = await ns.storage.askApiKeyIfNeeded(cfg);
      if (!cfg) throw new Error("未提供 API Key");

      const prefs = await ns.storage.getPrefs();
      ns.renderer.applySubtitleSize(prefs.size);

      const { sourceKey, configSig, cacheKey } = await ns.translationService.buildCacheKey(cfg, sourceId, vttText);
      const cacheEntry = await ns.storage.getCacheStore();

      if (forceRefresh) {
        if (cacheEntry) {
          await ns.storage.setCacheStore(null);
          console.log("[echo360-translator] cache cleared");
        }
        loadedCacheKey = "";
      }

      const renderState = ns.renderer.getRenderState();
      if (!forceRefresh && loadedCacheKey === cacheKey && renderState.lastTranslatedTrack) {
        ns.renderer.applySubtitleVisibility(true);
        ns.ui.updateActionButtons("翻译字幕已加载");
        ns.ui.setStatusText("已加载当前翻译字幕");
        return;
      }

      if (!forceRefresh && loadedCacheKey === cacheKey) {
        const existing = video.querySelector('track[data-echo360-translated="1"]');
        if (existing) {
          ns.renderer.applySubtitleVisibility(true);
          ns.ui.updateActionButtons("翻译字幕已加载");
          ns.ui.setStatusText("已加载当前翻译字幕");
          return;
        }
        loadedCacheKey = "";
      }

      if (!forceRefresh && cacheEntry?.translatedVtt && cacheEntry.cacheKey === cacheKey) {
        const mounted = ns.renderer.renderTranslatedTrack(
          cacheEntry.translatedVtt,
          vttText,
          prefs.bilingual,
          prefs.size,
          prefs.reverseOrder,
          sourceMeta
        );
        loadedCacheKey = cacheEntry.cacheKey || "";
        if (mounted) {
          ns.ui.updateActionButtons("翻译字幕已加载 (缓存)");
          ns.ui.setStatusText("命中本地缓存");
        } else {
          ns.ui.updateActionButtons("翻译已就绪");
          ns.ui.setStatusText("字幕已就绪，等待匹配的视频加载");
        }
        return;
      }

      const backendUrl = (cfg.backendUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
      const payload = ns.translationService.buildTranslatePayload(cfg, vttText, forceRefresh);
      const result = await ns.translationService.translateWithBackend(backendUrl, payload, {
        isActive: () => activeRunId === runId,
        onProgress: (current, total) => {
          const tip = `翻译中 ${current}/${total}`;
          ns.ui.updateActionButtons(tip, true);
          ns.ui.setStatusText(tip);
        },
        onSyncFallback: () => {
          ns.ui.setStatusText("后端不支持异步进度接口，回退到同步翻译...");
        },
      });
      if (activeRunId !== runId) return;
      if (!result?.translated_vtt) throw new Error("后端未返回 translated_vtt");

      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        console.warn("translator warnings:", result.warnings);
        ns.ui.setStatusText(`告警: ${result.warnings[0]}`);
      } else {
        ns.ui.setStatusText(result.cache_hit ? "后端缓存命中" : "翻译完成");
      }

      const mounted = ns.renderer.renderTranslatedTrack(
        result.translated_vtt,
        vttText,
        prefs.bilingual,
        prefs.size,
        prefs.reverseOrder,
        sourceMeta
      );
      loadedCacheKey = cacheKey;
      await ns.storage.setCacheStore({
        cacheKey,
        sourceKey,
        configSig,
        translatedVtt: result.translated_vtt,
        createdAt: Date.now(),
      });

      if (mounted) {
        ns.ui.updateActionButtons("翻译字幕已加载");
        ns.renderer.applySubtitleVisibility(prefs.enabled);
      } else {
        ns.ui.updateActionButtons("翻译已就绪");
        ns.ui.setStatusText("翻译完成，等待匹配的视频加载");
      }
    } catch (err) {
      console.error(err);
      const msg = ns.backendClient.friendlyErrorMessage(err?.message || String(err));
      ns.ui.setStatusText(`失败: ${msg}`);
      ns.ui.updateActionButtons("加载翻译字幕");
      alert(`字幕翻译失败：${msg}`);
    } finally {
      if (activeRunId === runId) {
        isTranslating = false;
        activeRunId = null;
      }
      const btn = document.getElementById("echo360-translator-btn");
      if (btn && !btn.textContent.includes("已加载") && !btn.textContent.includes("已就绪")) {
        ns.ui.updateActionButtons("加载翻译字幕", false);
      } else {
        ns.ui.updateActionButtons(btn?.textContent || "翻译字幕已加载", false);
      }
    }
  }

  async function init() {
    if (!location.hostname.includes("echo360.")) {
      console.log("[echo360-translator] skip non-echo360 frame:", location.href);
      return;
    }

    ns.video.installPageProbe();

    const video = await ns.video.waitForVideo(30000);
    if (!video) {
      console.log("[echo360-translator] video not found during init:", location.href);
      return;
    }

    ns.ui.ensurePanel({
      onTranslate: () => onClickTranslate(false),
      onForceTranslate: () => onClickTranslate(true),
      onPrefsChanged,
      onTargetChanged,
    });

    const existing = Array.from(video.querySelectorAll('track[data-echo360-translated="1"]'));
    if (existing.length > 0) {
      ns.renderer.setLastTranslatedTrack(existing[existing.length - 1]);
    }

    const prefs = await ns.storage.getPrefs();
    ns.renderer.applySubtitleSize(prefs.size || DEFAULT_SUBTITLE_SIZE);
    ns.renderer.applySubtitleVisibility(prefs.enabled !== false);

    if (!trackSyncTimer) {
      trackSyncTimer = setInterval(async () => {
        const p = await ns.storage.getPrefs();
        if (p.enabled === false) return;
        ns.renderer.ensureTrackOnPrimaryVideo();
        ns.renderer.applySubtitleVisibility(true);
      }, 1200);
    }

    const firstRunKey = "echo360TranslatorFirstRunShown";
    const firstRun = await chrome.storage.local.get(firstRunKey);
    if (!firstRun[firstRunKey]) {
      ns.ui.setStatusText("首次使用：1) 填 API Key 2) 选语言 3) 点加载翻译字幕");
      await chrome.storage.local.set({ [firstRunKey]: true });
    }
  }

  ns.controller = {
    init,
  };
})();
