(() => {
  const ns = window.Echo360Translator;
  const { DEFAULT_SUBTITLE_SIZE, SUBTITLE_PENDING_LABEL, SUBTITLE_SIZE_OPTIONS } = ns.constants;

  let lastTranslatedTrack = null;
  let lastRenderedVtt = "";
  let lastOriginalVtt = "";
  let lastRenderPrefs = {
    bilingual: false,
    size: DEFAULT_SUBTITLE_SIZE,
    reverseOrder: false,
    useNativeSubtitles: true,
  };
  let lastRenderSourceMeta = null;
  let pendingMount = null;

  function applySubtitleSize(size) {
    const normalizedSize = SUBTITLE_SIZE_OPTIONS.includes(size) ? size : DEFAULT_SUBTITLE_SIZE;
    ns.subtitleOverlay?.applySize(normalizedSize);
    ns.bilingualDomRenderer?.applySize(normalizedSize);
  }

  function applySubtitleVisibility(enabled) {
    if (ns.subtitleOverlay?.isMounted()) {
      ns.subtitleOverlay.setVisible(enabled);
      return;
    }
    if (ns.bilingualDomRenderer?.isMounted()) {
      ns.bilingualDomRenderer.setVisible(enabled);
      return;
    }
    if (enabled) ensureTrackOnPrimaryVideo();
  }

  function ensureTrackOnPrimaryVideo() {
    if (ns.subtitleOverlay?.getVideo()) {
      const target = ns.sourceFinder.pickBestMountVideoByVtt(lastOriginalVtt, lastRenderSourceMeta);
      if (target === ns.subtitleOverlay.getVideo() && target.isConnected) {
        ns.subtitleOverlay.refresh();
        return;
      }
      ns.subtitleOverlay.unmount();
    }
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
          p.useNativeSubtitles,
          { browserBilingual: p.browserBilingual, browserReverseOrder: p.browserReverseOrder }
        );
        ns.ui?.setStatusText("已找到匹配视频，字幕已自动显示");
        ns.ui?.updateActionButtons("翻译字幕已加载");
        return;
      }
    }
    if (!lastRenderedVtt || !lastOriginalVtt) return;
    renderTranslatedTrack(
      lastRenderedVtt,
      lastOriginalVtt,
      !!lastRenderPrefs.bilingual,
      lastRenderPrefs.size || DEFAULT_SUBTITLE_SIZE,
      !!lastRenderPrefs.reverseOrder,
      lastRenderSourceMeta,
      !!lastRenderPrefs.useNativeSubtitles,
      { browserBilingual: lastRenderPrefs.browserBilingual, browserReverseOrder: lastRenderPrefs.browserReverseOrder }
    );
  }

  function deactivateTranslatedRenderers() {
    ns.subtitleOverlay?.unmount();
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
    removeTranslatedTrackElements();
    pendingMount = null;
    lastRenderedVtt = "";
    lastOriginalVtt = "";
    lastRenderSourceMeta = null;
  }

  function removeTranslatedTrackElements() {
    const tracks = ns.video.querySelectorAllDeep('track[data-echo360-translated="1"], track[label*="翻译字幕"]');
    tracks.forEach((track) => track.remove());
  }

  function renderTranslatedTrack(
    translatedVtt,
    originalVtt,
    bilingual,
    size = DEFAULT_SUBTITLE_SIZE,
    reverseOrder = false,
    sourceMeta = null,
    useNativeSubtitles = true,
    renderOptions = {}
  ) {
    const incremental = !!renderOptions.incremental;
    // Native CC mode forces bilingual=true/reverseOrder=false on its `bilingual`/
    // `reverseOrder` params (it only ever injects one translated line, so
    // those controls are disabled while native CC injection is active) - that
    // forced pair must never leak into a fallback to the unified overlay,
    // which has its own independent, user-chosen preference. Callers
    // pass that real preference through renderOptions; fall back to
    // bilingual/reverseOrder as-is only for callers that don't provide it.
    const fallbackBilingual = renderOptions.browserBilingual ?? bilingual;
    const fallbackReverseOrder = renderOptions.browserReverseOrder ?? reverseOrder;
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
        browserBilingual: !!fallbackBilingual,
        browserReverseOrder: !!fallbackReverseOrder,
      };
      return false;
    }
    const backendLooksBilingual = ns.vtt.isAlreadyBilingualVtt(translatedVtt, originalVtt);
    let normalizedTranslated = backendLooksBilingual
      ? ns.vtt.extractPrimaryTranslatedVtt(ns.vtt.normalizeBilingualOrderZhFirst(translatedVtt))
      : translatedVtt;
    if (renderOptions.previewPending) {
      normalizedTranslated = ns.vtt.buildIncrementalPreviewVtt(normalizedTranslated, originalVtt, {
        placeholder: renderOptions.pendingLabel || SUBTITLE_PENDING_LABEL,
      });
    }
    lastRenderedVtt = normalizedTranslated;
    lastOriginalVtt = originalVtt;
    lastRenderPrefs = {
      bilingual: !!bilingual,
      size: size || DEFAULT_SUBTITLE_SIZE,
      reverseOrder: !!reverseOrder,
      useNativeSubtitles: !!useNativeSubtitles,
      browserBilingual: !!fallbackBilingual,
      browserReverseOrder: !!fallbackReverseOrder,
    };
    lastRenderSourceMeta = resolvedSourceMeta;

    const nativeDomMode = bilingual && !useNativeSubtitles;
    if (!incremental && !(ns.subtitleOverlay?.isMounted() && !nativeDomMode)) {
      deactivateTranslatedRenderers();
    } else if (ns.bilingualDomRenderer?.isMounted() && !nativeDomMode) {
      ns.bilingualDomRenderer.unmount();
    }

    if (nativeDomMode) {
      if (incremental && ns.bilingualDomRenderer?.isMounted()) {
        if (ns.bilingualDomRenderer.updateTranslatedVtt({
          originalVtt,
          translatedVtt: normalizedTranslated,
          size,
          reverseOrder,
        })) {
          lastTranslatedTrack = { mode: "bilingual-dom" };
          return true;
        }
        return false;
      }
      removeTranslatedTrackElements();
      const mounted = ns.bilingualDomRenderer?.mount({
        video,
        originalVtt,
        translatedVtt: normalizedTranslated,
        size,
        reverseOrder,
        onNoCaptionCapability: () => {
          // Fires once, mid-playback, if the per-cue grace period expires and
          // this lesson turns out to have no native CC at all. Re-render as the
          // unified overlay without touching the saved preference.
          console.info("[echo360-translator] no Echo360 native CC on this video; falling back to unified overlay");
          ns.ui?.setStatusText("此课程无 Echo360 原生字幕位，已自动切换为统一字幕");
          renderTranslatedTrack(translatedVtt, originalVtt, fallbackBilingual, size, fallbackReverseOrder, resolvedSourceMeta, true, renderOptions);
        },
      });
      if (mounted) {
        lastTranslatedTrack = { mode: "bilingual-dom" };
        return true;
      }
      // mount() refused synchronously — most commonly because the
      // capability pre-check already found no native CC track for this video.
      // Fall back to the unified overlay immediately.
      return renderTranslatedTrack(translatedVtt, originalVtt, fallbackBilingual, size, fallbackReverseOrder, resolvedSourceMeta, true, renderOptions);
    }
    if (ns.subtitleOverlay) {
      if (!ns.subtitleOverlay.isMounted()) removeTranslatedTrackElements();
      const mounted = ns.subtitleOverlay.mount({ video, translatedVtt: normalizedTranslated, originalVtt, bilingual, size, reverseOrder });
      if (mounted) {
        pendingMount = null;
        lastTranslatedTrack = { mode: "overlay" };
      }
      return mounted;
    }
    return false;
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

  ns.renderer = {
    applySubtitleSize,
    applySubtitleVisibility,
    ensureTrackOnPrimaryVideo,
    cleanupTranslatedTracks,
    renderTranslatedTrack,
    getRenderState,
  };
})();
