(() => {
  const ns = window.Echo360Translator;
  const SIZE_RATIO = { small: 0.038, medium: 0.046, large: 0.054 };
  const NATIVE_CAPTION_GRACE_MS = 750;
  const NATIVE_SEARCH_INTERVAL_MS = 200;
  const INJECTED_LINE_SELECTOR = "[data-echo360-translated-line='1']";
  const INJECTION_STYLE_ID = "echo360-translator-dom-injection-style";
  const DEBUG_ELEMENT_ID = "echo360-translator-dom-debug";
  let state = null;

  function publishDebugState() {
    let element = document.getElementById(DEBUG_ELEMENT_ID);
    if (!element) {
      element = document.createElement("meta");
      element.id = DEBUG_ELEMENT_ID;
      element.setAttribute("name", "echo360-translator-dom-debug");
      (document.head || document.documentElement).appendChild(element);
    }
    element.setAttribute("content", JSON.stringify(getDebugState()));
  }

  function parseTime(value) {
    const match = String(value || "").match(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    if (!match) return NaN;
    const [hours, minutes, seconds] = match[0].split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }

  function cueLine(text) {
    return String(text || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildCues(originalVtt, translatedVtt) {
    const original = ns.vtt.parseVttBlocks(originalVtt);
    const translated = ns.vtt.parseVttBlocks(translatedVtt);
    const count = Math.min(original.length, translated.length);
    const cues = [];
    for (let index = 0; index < count; index += 1) {
      const [startText, endText] = String(original[index].time || "").split("-->");
      const start = parseTime(startText);
      const end = parseTime(endText);
      const source = cueLine(original[index].text);
      const translation = cueLine(translated[index].text);
      if (Number.isFinite(start) && Number.isFinite(end) && (source || translation)) {
        cues.push({ start, end, source, translation });
      }
    }
    return cues;
  }

  function findPlayer(video) {
    return video?.closest("#player") || document.querySelector("#player");
  }

  function findCueIndex(time) {
    if (!state?.cues.length) return -1;
    const previous = state.lastCueIndex;
    if (previous >= 0) {
      const cue = state.cues[previous];
      if (time >= cue.start && time <= cue.end) return previous;
    }
    let low = 0;
    let high = state.cues.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (state.cues[mid].start <= time) low = mid + 1;
      else high = mid - 1;
    }
    if (high < 0) return -1;
    const cue = state.cues[high];
    return time >= cue.start && time <= cue.end ? high : -1;
  }

  function isVisibleInPlayer(element) {
    if (!state?.player || !element?.isConnected) return false;
    if (element.closest("#echo360-translator-panel")) return false;
    const rect = element.getBoundingClientRect();
    const playerRect = state.player.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 10) return false;
    if (rect.bottom < playerRect.top || rect.top > playerRect.bottom) return false;
    if (rect.right < playerRect.left || rect.left > playerRect.right) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
  }

  function elementTextWithoutInjectedLine(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.(INJECTED_LINE_SELECTOR).forEach((line) => line.remove());
    return normalizeText(clone.textContent || "");
  }

  function findNativeCaptionElement(sourceText) {
    if (!state?.player || !sourceText) return null;
    const normalizedSource = normalizeText(sourceText);
    if (!normalizedSource) return null;
    const sourceProbe = normalizedSource.length > 56 ? normalizedSource.slice(0, 56) : normalizedSource;
    const elements = Array.from(state.player.querySelectorAll("*"));
    const playerRect = state.player.getBoundingClientRect();
    let best = null;

    for (const element of elements) {
      const tag = element.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|VIDEO|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(tag)) continue;
      if (!isVisibleInPlayer(element)) continue;

      const text = elementTextWithoutInjectedLine(element);
      if (!text || text.length > Math.max(260, normalizedSource.length * 4)) continue;
      const matches = text.includes(sourceProbe) || normalizedSource.includes(text);
      if (!matches) continue;

      const childMatch = Array.from(element.children || []).some((child) => {
        if (child.matches?.(INJECTED_LINE_SELECTOR)) return false;
        return elementTextWithoutInjectedLine(child).includes(sourceProbe);
      });
      if (childMatch) continue;

      const rect = element.getBoundingClientRect();
      const bottomScore = Math.max(0, rect.top - playerRect.top) / Math.max(1, playerRect.height);
      const hint = `${element.id || ""} ${element.className || ""} ${element.getAttribute("role") || ""}`;
      const hintScore = /(caption|subtitle|cue|text-track|cc)/i.test(hint) ? 2 : 0;
      const lengthPenalty = Math.abs(text.length - normalizedSource.length) / Math.max(1, normalizedSource.length);
      const score = hintScore + bottomScore - lengthPenalty;
      if (!best || score > best.score) best = { element, score };
    }

    return best?.element || null;
  }

  function mutationCouldAffectActiveCaption(mutations) {
    if (!state) return false;
    if (state.nativeAnchor && !state.nativeAnchor.isConnected) return true;
    const cue = state.lastCueIndex >= 0 ? state.cues[state.lastCueIndex] : null;
    const source = normalizeText(cue?.source || "");
    if (!source) return false;
    const probe = source.length > 56 ? source.slice(0, 56) : source;

    const matchesNode = (node) => {
      const target = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const text = normalizeText(target?.textContent || "");
      return !!text && (text.includes(probe) || source.includes(text));
    };

    return mutations.some((mutation) => {
      if (matchesNode(mutation.target)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(matchesNode);
    });
  }

  function clearInjectedLines() {
    if (!state?.player) return;
    state.player.querySelectorAll(INJECTED_LINE_SELECTOR).forEach((element) => {
      if (element.hasAttribute("data-echo360-translation")) {
        element.removeAttribute("data-echo360-translated-line");
        element.removeAttribute("data-echo360-translation");
      } else {
        // Remove child nodes left by earlier experimental builds.
        element.remove();
      }
    });
    state.nativeAnchor = null;
  }

  function ensureInjectionStyle() {
    if (document.getElementById(INJECTION_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = INJECTION_STYLE_ID;
    style.textContent = `
      ${INJECTED_LINE_SELECTOR}::after {
        content: attr(data-echo360-translation);
        display: block;
        margin-top: 0.1em;
        color: inherit;
        font: inherit;
        line-height: inherit;
        text-align: inherit;
        white-space: normal;
        pointer-events: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectIntoNativeCaption(cue) {
    if (!cue || state.reverseOrder) return false;
    const anchor = findNativeCaptionElement(cue.source);
    if (!anchor) return false;

    if (state.nativeAnchor !== anchor) clearInjectedLines();
    ensureInjectionStyle();
    anchor.setAttribute("data-echo360-translated-line", "1");
    anchor.setAttribute("data-echo360-translation", cue.translation || "");
    state.nativeAnchor = anchor;
    const rect = anchor.getBoundingClientRect();
    state.nativeAnchorDebug = {
      tag: anchor.tagName,
      id: anchor.id || "",
      className: typeof anchor.className === "string" ? anchor.className : "",
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    return true;
  }

  function ensureAttached() {
    if (!state) return false;
    const player = state.player.isConnected ? state.player : findPlayer(state.video);
    if (!player) return false;
    if (state.player !== player) {
      state.player = player;
      state.mutationObserver?.disconnect();
      state.mutationObserver?.observe(player, { childList: true, characterData: true, subtree: true });
    }
    return true;
  }

  function renderCurrentCue() {
    if (!state || !ensureAttached()) return;
    const index = findCueIndex(Number(state.video.currentTime || 0));
    if (
      index === state.lastCueIndex &&
      state.nativeInjectedCueIndex === index &&
      state.player.querySelector(INJECTED_LINE_SELECTOR)
    ) {
      publishDebugState();
      return;
    }
    if (index !== state.lastCueIndex) {
      state.lastCueIndex = index;
      state.nativeInjectedCueIndex = -2;
      state.nativeCaptionWaitUntil = performance.now() + NATIVE_CAPTION_GRACE_MS;
      state.nextNativeSearchAt = 0;
    }
    const cue = index >= 0 ? state.cues[index] : null;
    if (!state.visible) {
      clearInjectedLines();
      publishDebugState();
      return;
    }
    const now = performance.now();
    const shouldSearchNative = cue && state.visible && now >= state.nextNativeSearchAt;
    if (shouldSearchNative) state.nextNativeSearchAt = now + NATIVE_SEARCH_INTERVAL_MS;
    if (shouldSearchNative && injectIntoNativeCaption(cue)) {
      state.nativeInjectedCueIndex = index;
      state.nativeInjectionHits += 1;
      publishDebugState();
      return;
    }
    state.nativeInjectedCueIndex = -1;
    if (!cue && state.nativeAnchor?.isConnected && isVisibleInPlayer(state.nativeAnchor)) {
      publishDebugState();
      return;
    }
    if (cue && state.visible && now < state.nativeCaptionWaitUntil) {
      publishDebugState();
      return;
    }
    clearInjectedLines();
    publishDebugState();
  }

  function scheduleVideoFrame() {
    if (!state || typeof state.video.requestVideoFrameCallback !== "function") return;
    state.frameHandle = state.video.requestVideoFrameCallback(() => {
      renderCurrentCue();
      scheduleVideoFrame();
    });
  }

  function mount({ video, originalVtt, translatedVtt, size, reverseOrder }) {
    const player = findPlayer(video);
    const cues = buildCues(originalVtt, translatedVtt);
    if (!video || !player || cues.length === 0) return false;

    unmount();
    state = {
      video,
      player,
      cues,
      size: SIZE_RATIO[size] ? size : "medium",
      reverseOrder: !!reverseOrder,
      visible: true,
      lastCueIndex: -2,
      nativeInjectedCueIndex: -2,
      nativeInjectionHits: 0,
      nativeCaptionWaitUntil: 0,
      nextNativeSearchAt: 0,
      nativeAnchor: null,
      nativeAnchorDebug: null,
      listeners: [],
      frameHandle: null,
      mutationObserver: null,
      mutationFrameHandle: null,
    };

    for (const eventName of ["timeupdate", "seeked", "play", "loadedmetadata"]) {
      const listener = renderCurrentCue;
      video.addEventListener(eventName, listener);
      state.listeners.push([eventName, listener]);
    }
    state.mutationObserver = new MutationObserver((mutations) => {
      if (!state || state.mutationFrameHandle !== null || !mutationCouldAffectActiveCaption(mutations)) return;
      state.mutationFrameHandle = requestAnimationFrame(() => {
        if (!state) return;
        state.mutationFrameHandle = null;
        state.nextNativeSearchAt = 0;
        renderCurrentCue();
      });
    });
    state.mutationObserver.observe(player, { childList: true, characterData: true, subtree: true });

    ensureAttached();
    renderCurrentCue();
    scheduleVideoFrame();
    publishDebugState();
    console.info("[echo360-translator] mounted Echo360 native CC injector", { cueCount: cues.length });
    return true;
  }

  function getDebugState() {
    if (!state) return { mounted: false };
    return {
      mounted: true,
      cueCount: state.cues.length,
      lastCueIndex: state.lastCueIndex,
      nativeInjectedCueIndex: state.nativeInjectedCueIndex,
      injectedLineCount: state.player.querySelectorAll(INJECTED_LINE_SELECTOR).length,
      nativeInjectionHits: state.nativeInjectionHits,
      waitingForNativeCaption: performance.now() < state.nativeCaptionWaitUntil,
      playerAttached: state.player.isConnected,
      nativeAnchor: state.nativeAnchorDebug,
    };
  }

  function setVisible(visible) {
    if (!state) return;
    state.visible = !!visible;
    renderCurrentCue();
  }

  function applySize(size) {
    if (!state) return;
    state.size = SIZE_RATIO[size] ? size : "medium";
  }

  function ensureMounted() {
    ensureAttached();
    renderCurrentCue();
  }

  function isMounted() {
    return !!state;
  }

  function unmount() {
    if (!state) return;
    for (const [eventName, listener] of state.listeners) state.video.removeEventListener(eventName, listener);
    if (state.frameHandle !== null && typeof state.video.cancelVideoFrameCallback === "function") {
      state.video.cancelVideoFrameCallback(state.frameHandle);
    }
    state.mutationObserver?.disconnect();
    if (state.mutationFrameHandle !== null) cancelAnimationFrame(state.mutationFrameHandle);
    clearInjectedLines();
    state = null;
    publishDebugState();
  }

  ns.bilingualDomRenderer = {
    mount,
    unmount,
    setVisible,
    applySize,
    ensureMounted,
    isMounted,
    getDebugState,
  };
})();
