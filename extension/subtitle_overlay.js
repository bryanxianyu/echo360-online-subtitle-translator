(() => {
  const ns = window.Echo360Translator;
  let state = null;
  let fontReady = null;
  function loadFont() {
    if (fontReady || typeof FontFace === "undefined" || !ns.browserApi?.runtime?.getURL) return;
    const url = ns.browserApi.runtime.getURL("fonts/NotoSansCJKsc-Regular.otf");
    const font = new FontFace("Echo360 Subtitle", `url("${url}")`, { weight: "400", style: "normal" });
    document.fonts.add(font);
    fontReady = font.load().then(refresh).catch((err) => {
      console.warn("[echo360-translator] subtitle font unavailable, using fallback:", err.message);
    });
  }
  const STYLE = `
    :host { all: initial; pointer-events: none; }
    *, *::before, *::after { box-sizing: border-box; }
    .stage { position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: flex-end; overflow: hidden;
      padding: 8px var(--side, 24px) var(--bottom, 24px); }
    .caption { flex: 0 1 auto; min-height: 0; max-width: 100%; overflow: hidden;
      padding: .12em .44em .18em; border-radius: .3em;
      color: #fff; background: rgba(48, 48, 50, .64);
      font-family: "Echo360 Subtitle", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: var(--font-size, 24px); font-weight: 400; line-height: 1.36;
      font-style: normal; letter-spacing: 0; text-align: center;
      text-shadow: 0 1px 2px rgba(0,0,0,.24); }
    .line { white-space: pre-line; overflow-wrap: anywhere; unicode-bidi: plaintext; }
    .line + .line { margin-top: .12em; }
    .original { color: rgba(255,255,255,.9); }
    [hidden] { display: none !important; }
  `;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function needsNative(video) {
    return fullscreenElement() === video || !!video.webkitDisplayingFullscreen || document.pictureInPictureElement === video;
  }

  function listen(s, target, name, handler, options) {
    target?.addEventListener?.(name, handler, options);
    s.cleanups.push(() => target?.removeEventListener?.(name, handler, options));
  }

  function setHostStyle(host, name, value) {
    // Host-page rules cannot override geometry or make the overlay clickable.
    host.style.setProperty(name, value, "important");
  }

  function nativePayload(s) {
    const original = s.original;
    return "WEBVTT\n\n" + s.translated.map((cue, index) => {
      const orig = ns.subtitleTimeline.active(original, cue.start);
      const lines = s.bilingual ? (s.reverseOrder ? [orig, cue.text] : [cue.text, orig]) : [cue.text];
      // Negative snapped lines grow upward and leave room beneath the text.
      return `${index + 1}\n${ns.vtt.formatVttTime(cue.start)} --> ${ns.vtt.formatVttTime(cue.end)} line:-3\n${lines.filter(Boolean).map((text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\n")}\n`;
    }).join("\n");
  }

  function removeFallback(s) {
    if (s.track?.track) s.track.track.mode = "disabled";
    s.track?.remove();
    s.track = null;
    if (s.url) URL.revokeObjectURL(s.url);
    s.url = "";
  }

  function syncFallback(s) {
    if (!s.native) {
      removeFallback(s);
      return;
    }
    if (!s.track || s.nativeDirty) {
      removeFallback(s);
      const track = document.createElement("track");
      track.label = "翻译字幕";
      track.kind = "subtitles";
      track.setAttribute("data-echo360-translated", "1");
      s.url = URL.createObjectURL(new Blob([nativePayload(s)], { type: "text/vtt;charset=utf-8" }));
      track.src = s.url;
      s.track = track;
      track.addEventListener("load", () => {
        if (state === s && s.track === track && track.track) track.track.mode = s.visible && s.native ? "showing" : "disabled";
      });
      s.video.appendChild(track);
      s.nativeDirty = false;
    }
    if (s.track.track) s.track.track.mode = s.visible ? "showing" : "disabled";
  }

  function layout(s) {
    const full = fullscreenElement();
    s.native = needsNative(s.video);
    syncFallback(s);
    const parent = full && full !== s.video && full.contains(s.video) ? full : document.documentElement;
    if (s.host.parentElement !== parent) parent.appendChild(s.host);
    const rect = ns.subtitleLayout.visibleRect(s.video);
    const obscured = full && full !== s.video && !full.contains(s.video);
    s.hasArea = !!rect && !obscured;
    setHostStyle(s.host, "display", s.visible && s.hasArea && !s.native ? "block" : "none");
    if (!rect) return;
    const m = ns.subtitleLayout.metrics(rect, s.size, !!full);
    for (const [key, value] of Object.entries({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })) {
      setHostStyle(s.host, key, `${value}px`);
    }
    s.host.style.setProperty("--font-size", `${m.fontSize}px`);
    s.host.style.setProperty("--bottom", `${m.bottom}px`);
    s.host.style.setProperty("--side", `${m.side}px`);
  }

  function render(s) {
    const time = Number(s.video.currentTime) || 0;
    const translated = ns.subtitleTimeline.active(s.translated, time);
    const original = s.bilingual ? ns.subtitleTimeline.active(s.original, time) : "";
    const key = JSON.stringify([translated, original, s.reverseOrder]);
    if (key !== s.textKey) {
      s.textKey = key;
      const rows = s.reverseOrder ? [[original, "original"], [translated, "translated"]] : [[translated, "translated"], [original, "original"]];
      s.caption.replaceChildren(...rows.filter(([text]) => text).map(([text, kind]) => {
        const row = document.createElement("div");
        row.className = `line ${kind}`;
        row.dir = "auto";
        row.textContent = text;
        return row;
      }));
      s.caption.hidden = !translated && !original;
    }
  }

  function refresh() {
    if (!state) return;
    layout(state);
    render(state);
  }

  function animate(s) {
    if (state !== s || s.frame) return;
    const tick = (now) => {
      s.frame = 0;
      if (state !== s) return;
      if (!s.video.isConnected) {
        setHostStyle(s.host, "display", "none");
        return;
      }
      if (now - s.lastLayout > 150) {
        layout(s);
        s.lastLayout = now;
      }
      render(s);
      if (!s.video.paused && !s.video.ended && !document.hidden && s.visible) s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }

  function mount(options) {
    const video = options.video;
    if (!video?.isConnected) return false;
    loadFont();
    if (state?.video !== video) unmount();
    if (!state) {
      const host = document.createElement("div");
      host.id = "echo360-subtitle-overlay";
      for (const [key, value] of Object.entries({ position: "fixed", margin: "0", padding: "0", border: "0", "pointer-events": "none", "z-index": "2147483646", overflow: "hidden", "box-sizing": "border-box", "color-scheme": "normal", isolation: "isolate" })) setHostStyle(host, key, value);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const stage = document.createElement("div");
      stage.className = "stage";
      const caption = document.createElement("div");
      caption.className = "caption";
      caption.setAttribute("role", "group");
      caption.setAttribute("aria-label", "翻译字幕");
      stage.appendChild(caption);
      shadow.append(style, stage);
      const s = state = { video, host, caption, visible: true, cleanups: [], frame: 0, lastLayout: 0, url: "", track: null };
      const update = () => { refresh(); animate(s); };
      for (const event of ["timeupdate", "seeking", "seeked", "play", "pause", "ratechange", "loadedmetadata", "resize", "ended", "enterpictureinpicture", "leavepictureinpicture", "webkitbeginfullscreen", "webkitendfullscreen"]) listen(s, video, event, update);
      for (const event of ["fullscreenchange", "webkitfullscreenchange", "visibilitychange"]) listen(s, document, event, update);
      listen(s, window, "resize", update);
      listen(s, document, "scroll", update, true);
      listen(s, window.visualViewport, "resize", update);
      listen(s, window.visualViewport, "scroll", update);
      listen(s, video.textTracks, "change", update);
      listen(s, video.textTracks, "addtrack", update);
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(update);
        observer.observe(video);
        if (video.parentElement) observer.observe(video.parentElement);
        s.cleanups.push(() => observer.disconnect());
      }
    }
    Object.assign(state, {
      translated: ns.subtitleTimeline.parse(options.translatedVtt),
      original: ns.subtitleTimeline.parse(options.originalVtt),
      bilingual: !!options.bilingual,
      reverseOrder: !!options.reverseOrder,
      size: options.size || "medium", nativeDirty: true,
    });
    refresh();
    animate(state);
    return true;
  }

  function unmount() {
    const s = state;
    if (!s) return;
    state = null;
    cancelAnimationFrame(s.frame);
    s.cleanups.forEach((cleanup) => cleanup());
    removeFallback(s);
    s.host.remove();
  }

  ns.subtitleOverlay = {
    mount, unmount, refresh,
    isMounted: () => !!state?.video.isConnected,
    getVideo: () => state?.video || null,
    setVisible(enabled) {
      if (!state) return;
      state.visible = !!enabled;
      refresh();
      if (enabled) animate(state);
    },
    applySize(size) {
      if (!state) return;
      state.size = size;
      refresh();
    },
  };
})();
