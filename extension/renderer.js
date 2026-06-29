(() => {
  const ns = window.Echo360Translator;
  const {
    DEFAULT_SUBTITLE_LINE_HEIGHT,
    DEFAULT_SUBTITLE_SIZE,
    SAFARI_LINE_HEIGHT_MAP,
    SAFARI_SIZE_MAP,
    SIZE_MAP,
  } = ns.constants;

  let lastTranslatedTrack = null;
  let lastRenderedVtt = "";
  let lastOriginalVtt = "";
  let styleEl = null;
  let lastRenderPrefs = {
    bilingual: false,
    size: DEFAULT_SUBTITLE_SIZE,
    reverseOrder: false,
    useNativeSubtitles: true,
  };
  let lastRenderSourceMeta = null;
  let pendingMount = null;
  let fullscreenListenerInstalled = false;
  const nativeTrackStates = new Map();

  function isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent || "");
  }

  function isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.webkitCurrentFullScreenElement ||
      ns.video.getAllVideos().some((video) => video.webkitDisplayingFullscreen)
    );
  }

  function ensureFullscreenListener() {
    if (fullscreenListenerInstalled) return;
    fullscreenListenerInstalled = true;
    ["fullscreenchange", "webkitfullscreenchange", "webkitbeginfullscreen", "webkitendfullscreen"].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        applySubtitleSize(lastRenderPrefs.size || DEFAULT_SUBTITLE_SIZE);
      }, true);
    });
  }

  function resolveSubtitleLineHeight() {
    if (!isSafari()) return DEFAULT_SUBTITLE_LINE_HEIGHT;
    const mode = isFullscreen() ? "fullscreen" : "normal";
    return SAFARI_LINE_HEIGHT_MAP[mode] || DEFAULT_SUBTITLE_LINE_HEIGHT;
  }

  function applySubtitleSize(size) {
    const normalizedSize = SIZE_MAP[size] ? size : DEFAULT_SUBTITLE_SIZE;
    const pct = isSafari()
      ? (SAFARI_SIZE_MAP[normalizedSize] || SAFARI_SIZE_MAP[DEFAULT_SUBTITLE_SIZE])
      : (SIZE_MAP[normalizedSize] || SIZE_MAP[DEFAULT_SUBTITLE_SIZE]);
    const lineHeight = resolveSubtitleLineHeight();
    ensureFullscreenListener();
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "echo360-translator-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      video::cue {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
      video:fullscreen::cue {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
      video:-webkit-full-screen::cue {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
      video::-webkit-media-text-track-display {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
      video:fullscreen::-webkit-media-text-track-display {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
      video:-webkit-full-screen::-webkit-media-text-track-display {
        font-size: ${pct} !important;
        line-height: ${lineHeight} !important;
      }
    `;
    ns.bilingualDomRenderer?.applySize(normalizedSize);
  }

  function shouldShowTranslatedTrackForVideo(video, videos = ns.video.getAllVideos()) {
    if (!video) return false;
    const currentTime = Number(video.currentTime || 0);
    if (!video.paused && !video.ended) return true;
    if (currentTime > 0.25) return true;
    if (videos.length > 1) return false;
    return !videos.some((v) => {
      if (v === video) return false;
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && area > 10_000;
      return visible && !v.paused && !v.ended;
    });
  }

  function pickActiveTranslatedTrack() {
    const trackEls = ns.video.querySelectorAllDeep('track[data-echo360-translated="1"], track[label*="翻译字幕"]');
    if (trackEls.length === 0) return null;
    const videos = ns.video.getAllVideos();
    let best = null;
    for (const el of trackEls) {
      const t = el.track;
      if (!t) continue;
      const v = videos.find((x) => x.contains(el));
      if (!v) continue;
      if (!shouldShowTranslatedTrackForVideo(v, videos)) continue;
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      const playingBoost = (!v.paused && !v.ended) ? 1_000_000 : 0;
      const progressedBoost = Number(v.currentTime || 0) > 0 ? 200_000 : 0;
      const score = playingBoost + progressedBoost + (visible ? 50_000 : 0) + area;
      if (!best || score > best.score) best = { track: t, score };
    }
    return best?.track || null;
  }

  function applySubtitleVisibility(enabled) {
    if (ns.bilingualDomRenderer?.isMounted()) {
      ns.bilingualDomRenderer.setVisible(enabled);
      return;
    }
    if (enabled) {
      ensureTrackOnPrimaryVideo();
    }
    const videos = ns.video.getAllVideos();
    if (videos.length === 0) return;
    let activeTextTrack = pickActiveTranslatedTrack() || lastTranslatedTrack?.track || null;
    if (!activeTextTrack) {
      const translatedEls = ns.video.querySelectorAllDeep('track[data-echo360-translated="1"], track[label*="翻译字幕"]');
      const latest = translatedEls[translatedEls.length - 1];
      const latestVideo = latest ? videos.find((x) => x.contains(latest)) : null;
      activeTextTrack = latest && shouldShowTranslatedTrackForVideo(latestVideo, videos) ? latest.track : null;
    }
    for (const video of videos) {
      let hasNonTranslatedShowing = false;
      const nonTranslatedCandidates = [];
      for (const t of video.textTracks) {
        const isTranslatedTrack = (t.label || "").includes("翻译");
        if (enabled) {
          if (isTranslatedTrack) {
            t.mode = activeTextTrack && t === activeTextTrack ? "showing" : "disabled";
          }
        } else if (isTranslatedTrack) {
          t.mode = "disabled";
        } else {
          if (t.mode === "showing") hasNonTranslatedShowing = true;
          nonTranslatedCandidates.push(t);
        }
      }
      if (!enabled && !hasNonTranslatedShowing && nonTranslatedCandidates.length > 0) {
        nonTranslatedCandidates[0].mode = "showing";
      }
    }
  }

  function ensureTrackOnPrimaryVideo() {
    if (ns.bilingualDomRenderer?.isMounted()) {
      ns.bilingualDomRenderer.ensureMounted();
      return;
    }
    if (pendingMount) {
      const target = ns.sourceFinder.pickBestMountVideoByVtt(pendingMount.originalVtt, pendingMount.sourceMeta || null);
      if (target) {
        const p = pendingMount;
        pendingMount = null;
        renderTranslatedTrack(
          p.translatedVtt,
          p.originalVtt,
          p.bilingual,
          p.size,
          p.reverseOrder,
          p.sourceMeta || null,
          p.useNativeSubtitles
        );
        ns.ui?.setStatusText("已找到匹配视频，字幕已自动显示");
        ns.ui?.updateActionButtons("翻译字幕已加载");
        return;
      }
    }
    if (!lastRenderedVtt || !lastOriginalVtt) return;
    if (hasRenderedTranslatedTrack()) return;
    renderTranslatedTrack(
      lastRenderedVtt,
      lastOriginalVtt,
      !!lastRenderPrefs.bilingual,
      lastRenderPrefs.size || DEFAULT_SUBTITLE_SIZE,
      !!lastRenderPrefs.reverseOrder,
      lastRenderSourceMeta,
      !!lastRenderPrefs.useNativeSubtitles
    );
  }

  function deactivateTranslatedRenderers() {
    ns.bilingualDomRenderer?.unmount();
    for (const video of ns.video.getAllVideos()) {
      for (const track of video.textTracks) {
        if ((track.label || "").includes("翻译")) track.mode = "disabled";
      }
    }
    lastTranslatedTrack = null;
  }

  function cleanupTranslatedTracks() {
    deactivateTranslatedRenderers();
    const tracks = ns.video.querySelectorAllDeep('track[data-echo360-translated="1"], track[label*="翻译字幕"]');
    tracks.forEach((track) => track.remove());
    for (const state of nativeTrackStates.values()) {
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    }
    nativeTrackStates.clear();
  }

  function hasRenderedTranslatedTrack() {
    if (ns.bilingualDomRenderer?.isMounted()) return true;
    return ns.video
      .querySelectorAllDeep('track[data-echo360-translated="1"], track[label*="翻译字幕"]')
      .some((track) => track.track?.mode === "showing");
  }

  function revokeWhenUnused(track, objectUrl) {
    if (!objectUrl) return;
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(objectUrl);
    };
    track.addEventListener("load", revoke, { once: true });
    setTimeout(revoke, 10_000);
  }

  function getOrCreateNativeTrack(video) {
    let state = nativeTrackStates.get(video);
    if (state?.track?.isConnected && video.contains(state.track)) return state;

    const existing = video.querySelector('track[data-echo360-translated="1"], track[label*="翻译字幕"]');
    const track = existing || document.createElement("track");
    state = { track, payload: "", objectUrl: "" };
    nativeTrackStates.set(video, state);
    return state;
  }

  function renderTranslatedTrack(
    translatedVtt,
    originalVtt,
    bilingual,
    size = DEFAULT_SUBTITLE_SIZE,
    reverseOrder = false,
    sourceMeta = null,
    useNativeSubtitles = true
  ) {
    const resolvedSourceMeta = sourceMeta || ns.sourceFinder.buildSourceMeta("", originalVtt);
    const video = ns.sourceFinder.pickBestMountVideoByVtt(originalVtt, resolvedSourceMeta);
    if (!video) {
      pendingMount = {
        translatedVtt,
        originalVtt,
        bilingual: !!bilingual,
        size: size || DEFAULT_SUBTITLE_SIZE,
        reverseOrder: !!reverseOrder,
        sourceMeta: resolvedSourceMeta,
        useNativeSubtitles: !!useNativeSubtitles,
      };
      return false;
    }
    const backendLooksBilingual = ns.vtt.isAlreadyBilingualVtt(translatedVtt, originalVtt);
    const normalizedTranslated = backendLooksBilingual
      ? ns.vtt.extractPrimaryTranslatedVtt(ns.vtt.normalizeBilingualOrderZhFirst(translatedVtt))
      : translatedVtt;
    const rawPayload = bilingual
      ? ns.subtitleStrategy.buildBilingualVtt({
        translatedVtt: normalizedTranslated,
        originalVtt,
        reverseOrder,
        size,
      })
      : normalizedTranslated;
    const payload = ns.vtt.applyCueBottom(rawPayload, size);
    lastRenderedVtt = normalizedTranslated;
    lastOriginalVtt = originalVtt;
    lastRenderPrefs = {
      bilingual: !!bilingual,
      size: size || DEFAULT_SUBTITLE_SIZE,
      reverseOrder: !!reverseOrder,
      useNativeSubtitles: !!useNativeSubtitles,
    };
    lastRenderSourceMeta = resolvedSourceMeta;

    deactivateTranslatedRenderers();
    if (bilingual && !useNativeSubtitles && ns.bilingualDomRenderer?.mount({
      video,
      originalVtt,
      translatedVtt: normalizedTranslated,
      size,
      reverseOrder,
    })) {
      lastTranslatedTrack = { mode: "bilingual-dom" };
      return true;
    }
    const nativeState = getOrCreateNativeTrack(video);
    const track = nativeState.track;
    track.label = bilingual ? "翻译字幕 (双语)" : "翻译字幕";
    track.srclang = "zh";
    track.kind = "subtitles";
    track.setAttribute("data-echo360-translated", "1");
    if (resolvedSourceMeta.sourceId) track.setAttribute("data-echo360-source-id", resolvedSourceMeta.sourceId);
    if (resolvedSourceMeta.mediaId) track.setAttribute("data-echo360-media-id", resolvedSourceMeta.mediaId);
    if (resolvedSourceMeta.mapSource) track.setAttribute("data-echo360-map-source", resolvedSourceMeta.mapSource);
    track.setAttribute("data-echo360-source-max-end", String(Math.round(resolvedSourceMeta.stats?.maxEnd || 0)));
    if (nativeState.payload !== payload || !track.getAttribute("src")) {
      const previousObjectUrl = nativeState.objectUrl;
      const blob = new Blob(["\ufeff", payload], { type: "text/vtt;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      nativeState.payload = payload;
      nativeState.objectUrl = objectUrl;
      track.src = objectUrl;
      revokeWhenUnused(track, previousObjectUrl);
    }
    if (!track.isConnected || !video.contains(track)) {
      track.default = true;
      video.appendChild(track);
    }
    const mountedVideoHintIds = Array.from(ns.video.getVideoHintMediaIds(video));
    console.log("[echo360-translator] mounted translated track:", {
      sourceId: resolvedSourceMeta.sourceId,
      mediaId: resolvedSourceMeta.mediaId,
      mapSource: resolvedSourceMeta.mapSource || "",
      sourceMaxEnd: Math.round(resolvedSourceMeta.stats?.maxEnd || 0),
      videoDuration: Math.round(Number(video.duration || 0)),
      videoCurrentTime: Number(video.currentTime || 0).toFixed(2),
      videoHintMatch: resolvedSourceMeta.mediaId ? mountedVideoHintIds.includes(resolvedSourceMeta.mediaId) : false,
      videoHintIds: mountedVideoHintIds.slice(0, 12),
    });
    lastTranslatedTrack = track;
    if (track.track) track.track.mode = "showing";
    setTimeout(() => {
      if (lastTranslatedTrack !== track || ns.bilingualDomRenderer?.isMounted()) return;
      ns.storage.getPrefs().then((prefs) => {
        if (lastTranslatedTrack !== track || !prefs.useNativeSubtitles) return;
        if (track.track) track.track.mode = prefs.enabled === false ? "disabled" : "showing";
        applySubtitleVisibility(prefs.enabled !== false);
      });
    }, 0);
    return true;
  }

  function getRenderState() {
    return {
      lastTranslatedTrack,
      lastRenderedVtt,
      lastOriginalVtt,
      lastRenderPrefs,
      lastRenderSourceMeta,
    };
  }

  function setLastTranslatedTrack(track) {
    lastTranslatedTrack = track || null;
  }

  ns.renderer = {
    applySubtitleSize,
    applySubtitleVisibility,
    ensureTrackOnPrimaryVideo,
    cleanupTranslatedTracks,
    hasRenderedTranslatedTrack,
    renderTranslatedTrack,
    getRenderState,
    setLastTranslatedTrack,
  };
})();
