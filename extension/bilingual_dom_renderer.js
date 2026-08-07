(() => {
  const ns = window.Echo360Translator;
  const SIZE_RATIO = { small: 0.038, medium: 0.046, large: 0.054 };
  const NATIVE_CAPTION_GRACE_MS = 750;
  const INJECTED_LINE_SELECTOR = "[data-echo360-translated-line='1']";
  const INJECTION_STYLE_ID = "echo360-translator-dom-injection-style";
  const DEBUG_ELEMENT_ID = "echo360-translator-dom-debug";
  // requestVideoFrameCallback re-invokes renderCurrentCue() at the display's
  // refresh rate (commonly 60-120Hz) for as long as native CC injection is
  // mounted, i.e.
  // for the entire video duration. The debug snapshot is only ever read by
  // a human inspecting the DOM, so refreshing it that often buys nothing and
  // just burns main-thread time on JSON.stringify + a DOM write every frame.
  const DEBUG_PUBLISH_THROTTLE_MS = 250;
  // requestVideoFrameCallback fires at the rate the video actually presents
  // frames, which on a high-refresh-rate display (120/144Hz+) can be far
  // more often than a human can perceive a subtitle updating. Left
  // unthrottled, every one of those extra callbacks pays for a full
  // player-subtree scan while a cue hasn't been matched yet (e.g. right
  // after seeking, or during fast playback where cues change quickly in
  // real time) - competing with the browser's own rendering work for
  // main-thread time. Under load this backlog compounds: rVFC/timeupdate
  // callbacks queue up faster than they can run, so by the time one finally
  // executes, currentTime (especially at 2x+ speed) has already moved into
  // a *later* cue, which restarts the search-and-retry cycle again -
  // carrying the lag into several subsequent cues instead of just the one
  // that was jumped to. 30Hz is comfortably faster than any human can
  // notice a subtitle lag, while cutting the worst case (144Hz) down to
  // roughly a fifth as many scan attempts. timeupdate/seeked/play and the
  // MutationObserver path are untouched by this and keep reacting
  // immediately - only the "just checking again in case nothing changed"
  // rVFC loop is capped.
  const NATIVE_RENDER_FRAME_THROTTLE_MS = 33;
  // If the host page's own main thread stalls for a while (e.g. Echo360's
  // player doing heavy work of its own around a seek - WebGL/audio
  // reinit, style recalculation, etc.), every callback on this page,
  // including our own, is delayed by the same amount; there is nothing we
  // can do to run *during* that stall. What we CAN do is notice, once the
  // thread frees up, that a lot more real time passed than we actually got
  // a chance to search in, and extend the per-cue grace period by exactly
  // that much - so a cue doesn't get unfairly marked "exhausted" (and its
  // translation blanked) purely because the host page froze, rather than
  // because there really was no matching native caption to find. Set well
  // above the normal call cadence (rVFC is throttled to ~33ms, timeupdate
  // fires at least every ~250ms) so ordinary gaps between triggers are
  // never mistaken for a stall.
  const NATIVE_STALL_GAP_THRESHOLD_MS = 1000;
  let state = null;
  let lastDebugPublishAt = -Infinity;

  function publishDebugState() {
    const now = performance.now();
    if (now - lastDebugPublishAt < DEBUG_PUBLISH_THROTTLE_MS) return;
    lastDebugPublishAt = now;
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
    // Intentionally avoids cloneNode(true): cloning a subtree that contains
    // the player's <video>/<audio> element makes Chrome re-issue a fetch for
    // its (often blob:) src on the detached clone, which fails loudly in the
    // console (net::ERR_FILE_NOT_FOUND) without any functional benefit here.
    // Walking text nodes directly gets the same result with no side effects.
    // Note: only *descendants* matching INJECTED_LINE_SELECTOR are skipped,
    // matching the previous clone + querySelectorAll(...).remove() behavior
    // (which never dropped the root element's own text).
    let text = "";
    const collectChildren = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent || "";
        } else if (child.nodeType === Node.ELEMENT_NODE && !child.matches?.(INJECTED_LINE_SELECTOR)) {
          collectChildren(child);
        }
      }
    };
    if (element.nodeType === Node.TEXT_NODE) text += element.textContent || "";
    else collectChildren(element);
    return normalizeText(text);
  }

  // How far around the time-computed "expected" cue index to search when
  // resolving what the native caption box's *actual* text corresponds to
  // (see findCueIndexMatchingText below). Biased much further backward than
  // forward: under main-thread pressure (especially at 2x+ playback) Echo360's
  // own caption box lags *behind* wall-clock time - still showing an earlier
  // cue - rather than racing ahead of it, since real time keeps advancing
  // while its render is still catching up.
  const NATIVE_TEXT_MATCH_WINDOW_BACK = 8;
  const NATIVE_TEXT_MATCH_WINDOW_FORWARD = 2;

  // Resolves which cue a piece of DOM text actually belongs to, searching a
  // small window of cues around `hintIndex` (the cue findCueIndex() computed
  // from video.currentTime) rather than only accepting that exact cue. This
  // is the core of text-driven injection: the visible native caption text -
  // not video.currentTime - is the source of truth for *which* translation
  // to inject; time is only used to center the search window and to
  // disambiguate between multiple textual matches (picking the closest).
  function findCueIndexMatchingText(elementText, hintIndex) {
    const text = normalizeText(elementText);
    if (!text || hintIndex < 0 || !state?.cues.length) return -1;
    let bestIndex = -1;
    let bestDistance = Infinity;
    const start = Math.max(0, hintIndex - NATIVE_TEXT_MATCH_WINDOW_BACK);
    const end = Math.min(state.cues.length - 1, hintIndex + NATIVE_TEXT_MATCH_WINDOW_FORWARD);
    for (let i = start; i <= end; i += 1) {
      const candidateSource = normalizeText(state.cues[i].source);
      if (!candidateSource) continue;
      if (text.length > Math.max(260, candidateSource.length * 4)) continue;
      const probe = candidateSource.length > 56 ? candidateSource.slice(0, 56) : candidateSource;
      if (!(text.includes(probe) || candidateSource.includes(text))) continue;
      const distance = Math.abs(i - hintIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  // Returns { element, cueIndex, matchPath } for the native caption node to
  // inject into, or null if none can be found right now. `cueIndex` is the
  // cue the node's *actual* visible text resolved to - which may differ from
  // `hintIndex` (the time-based guess) whenever Echo360's own render is
  // lagging behind currentTime (common at high playback speed).
  function findNativeCaptionElement(hintIndex) {
    if (!state?.player) return null;
    if (!state.cues[hintIndex]) return null;

    // Fast path: most caption widgets (including Echo360's) reuse the same
    // container element across cues and just swap its text content. Trying
    // the previously matched anchor first turns the common case into an O(1)
    // check instead of a full player-subtree scan, and skips the layout/style
    // recalculation cost for every other element entirely. The anchor's real
    // text is resolved via the window search, so this fast path stays correct
    // even when Echo360's box is momentarily behind our time-based guess.
    if (state.nativeAnchor?.isConnected && isVisibleInPlayer(state.nativeAnchor)) {
      const anchorText = elementTextWithoutInjectedLine(state.nativeAnchor);
      const matchedIndex = findCueIndexMatchingText(anchorText, hintIndex);
      if (matchedIndex >= 0) {
        return { element: state.nativeAnchor, cueIndex: matchedIndex, matchPath: "sticky-o1" };
      }
    }

    // Cold start / anchor lost: no established anchor to read real text
    // from yet. Resolve every candidate's text via the same window search
    // (rather than only accepting hintIndex's own cue) - otherwise a scan
    // running while Echo360's caption box is mid-catch-up (still showing an
    // earlier cue) would find zero candidates and have to wait for a later
    // retry, even though the right cue's text - just not the one hintIndex
    // predicted - is already sitting in the DOM.
    //
    // Diagnostics: every full player-subtree scan is timed and counted so
    // getDebugState() can surface *why* injection is lagging on a given
    // machine/browser - a slow scan (large/deep player DOM, or Echo360's own
    // style recalcs making getBoundingClientRect/getComputedStyle expensive)
    // looks very different from "too many scan attempts" (high rvfcFrameCount
    // vs rvfcRenderCount, or many scanCount entries within one cue's grace
    // period) and needs a different fix.
    const scanStart = performance.now();
    const elements = Array.from(state.player.querySelectorAll("*"));
    const playerRect = state.player.getBoundingClientRect();
    let best = null;

    for (const element of elements) {
      const tag = element.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|CANVAS|VIDEO|BUTTON|INPUT|SELECT|TEXTAREA)$/i.test(tag)) continue;
      // Cheap text comparison first; only elements that already match text
      // pay for a forced layout/style read via isVisibleInPlayer below. On a
      // typical player DOM, this cuts the number of getBoundingClientRect/
      // getComputedStyle calls from "every element" down to a handful.
      const text = elementTextWithoutInjectedLine(element);
      if (!text) continue;
      const matchedIndex = findCueIndexMatchingText(text, hintIndex);
      if (matchedIndex < 0) continue;
      const matchedSource = normalizeText(state.cues[matchedIndex].source);
      const matchedProbe = matchedSource.length > 56 ? matchedSource.slice(0, 56) : matchedSource;
      // Skip elements whose match is really owed to a more specific
      // descendant containing the matching text (avoids picking an
      // ancestor container over the actual caption line inside it).
      const childMatch = Array.from(element.children || []).some((child) => {
        if (child.matches?.(INJECTED_LINE_SELECTOR)) return false;
        return elementTextWithoutInjectedLine(child).includes(matchedProbe);
      });
      if (childMatch) continue;
      if (!isVisibleInPlayer(element)) continue;

      const rect = element.getBoundingClientRect();
      const bottomScore = Math.max(0, rect.top - playerRect.top) / Math.max(1, playerRect.height);
      const hint = `${element.id || ""} ${element.className || ""} ${element.getAttribute("role") || ""}`;
      const hintScore = /(caption|subtitle|cue|text-track|cc)/i.test(hint) ? 2 : 0;
      const lengthPenalty = Math.abs(text.length - matchedSource.length) / Math.max(1, matchedSource.length);
      // Prefer a match resolved to a cue closer to hintIndex, so a
      // technically-valid but farther-away cue in the window doesn't win
      // out over one more consistent with where playback currently is.
      const indexDistancePenalty = Math.abs(matchedIndex - hintIndex) * 0.5;
      const score = hintScore + bottomScore - lengthPenalty - indexDistancePenalty;
      if (!best || score > best.score) best = { element, cueIndex: matchedIndex, score };
    }

    const scanDurationMs = performance.now() - scanStart;
    state.scanCount += 1;
    state.scanTotalMs += scanDurationMs;
    state.lastScanMs = scanDurationMs;
    state.lastScanElementCount = elements.length;

    return best ? { element: best.element, cueIndex: best.cueIndex, matchPath: "full-scan" } : null;
  }

  function mutationCouldAffectActiveCaption(mutations) {
    if (!state) return false;
    if (state.nativeAnchor && !state.nativeAnchor.isConnected) return true;
    if (mutations.length === 0) return false;
    // While the current cue hasn't been matched yet, don't pre-filter by
    // text at all: right after a seek/stall, Echo360 often needs a moment to
    // catch its own caption box up to the *actual* current position, and in
    // the meantime it may render several cues *behind* whatever cue we're
    // currently looking for (real time keeps advancing - especially at 2x+
    // speed - while Echo360 is still working through the backlog). Filtering
    // by "does this mutation's text match the cue we expect right now" would
    // reject all of those as irrelevant and only resync once Echo360 fully
    // catches up to the exact cue we're on *at that later moment* - visibly
    // stretching the lag across every cue in between. Reacting to any DOM
    // change here instead just means an extra renderCurrentCue() call (and,
    // if still unmatched, a full scan - measured at ~1ms in practice) during
    // the comparatively brief window before a match is found; once matched,
    // the text-probe filter below takes back over so unrelated player churn
    // (progress bar ticks, etc.) doesn't trigger a scan on every mutation for
    // the rest of the cue.
    //
    // This deliberately includes the post-grace "exhausted" state: if we gave
    // up on a cue because its grace period lapsed before Echo360's caption
    // box was ready (common at high playback speed and after seeks), a
    // caption DOM write arriving *after* grace expiry is exactly the signal
    // to look again - the observer callback below clears
    // nativeSearchExhausted, but only if we react to the mutation here first.
    // A `!nativeSearchExhausted` guard here previously left the caption
    // visible for the rest of the cue with no translation.
    if (state.lastCueIndex >= 0 && state.nativeInjectedCueIndex !== state.lastCueIndex) {
      return true;
    }
    // Once a cue has been matched, filter player churn by resolving the
    // mutation's *new text* against nearby cues. Do not compare it only with
    // state.lastCueIndex: Echo360 can write the next (especially very short)
    // caption before our next timeupdate/rVFC callback updates that
    // bookkeeping. The old filter rejected that caption mutation as
    // unrelated, and by the next 33ms check the short cue could already have
    // disappeared. Read currentTime afresh for the best hint; if playback is
    // in a gap, fall back to the last known index so the forward side of the
    // text-match window can still recognize the new caption.
    const currentIndex = findCueIndex(Number(state.video.currentTime || 0));
    const hintIndex = currentIndex >= 0 ? currentIndex : state.lastCueIndex;
    if (hintIndex < 0) return false;

    const matchesNode = (node) => {
      const target = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!target || target.closest?.("#echo360-translator-panel")) return false;
      const text = elementTextWithoutInjectedLine(target);
      return !!text && findCueIndexMatchingText(text, hintIndex) >= 0;
    };

    return mutations.some((mutation) => {
      if (matchesNode(mutation.target)) return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(matchesNode);
    });
  }

  // Cheap (O(1)) replacement for querying the DOM on every single video
  // frame: we already hold a direct reference to the one element we ever
  // inject into, so checking it directly avoids a subtree query that would
  // otherwise run at the display's refresh rate for as long as native CC
  // injection stays mounted.
  function isInjectedLinePresent() {
    return !!(state?.nativeAnchor?.isConnected && state.nativeAnchor.hasAttribute("data-echo360-translated-line"));
  }

  // The "already injected, nothing to do" early-return in renderCurrentCue
  // must mean the translation the user can currently see still belongs to
  // the text Echo360 is currently showing. Checking only attribute presence
  // let a stale injection (anchor swapped/hidden, or its text moved on to a
  // cue we haven't re-resolved) block re-matching for the rest of the cue.
  // `matchedIndex >= 0` (not `=== injected`) keeps this cheap check from
  // fighting the sticky path: whatever nearby cue the text resolves to,
  // injectIntoNativeCaption is the one that re-resolves and re-injects.
  function isInjectionStillValid() {
    const anchor = state?.nativeAnchor;
    if (!anchor?.isConnected || !anchor.hasAttribute("data-echo360-translated-line")) return false;
    if (!isVisibleInPlayer(anchor)) return false;
    const anchorText = elementTextWithoutInjectedLine(anchor);
    if (!anchorText) return false;
    const hintIndex = state.lastCueIndex >= 0 ? state.lastCueIndex : state.nativeInjectedCueIndex;
    const matchedIndex = findCueIndexMatchingText(anchorText, hintIndex);
    return matchedIndex >= 0 && matchedIndex === state.nativeInjectedCueIndex;
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

  // Attempts to inject the translation for whichever cue the native caption
  // box's *actual visible text* resolves to (see findNativeCaptionElement),
  // using `hintIndex` (the time-based guess) only to center the resolution
  // window. Returns { cueIndex, matchPath } on success, or null.
  function injectIntoNativeCaption(hintIndex) {
    if (state.reverseOrder) return null;
    const match = findNativeCaptionElement(hintIndex);
    if (!match) return null;
    const { element: anchor, cueIndex, matchPath } = match;
    const cue = state.cues[cueIndex];
    if (!cue) return null;

    if (state.nativeAnchor !== anchor) clearInjectedLines();
    ensureInjectionStyle();
    anchor.setAttribute("data-echo360-translated-line", "1");
    anchor.setAttribute("data-echo360-translation", cue.translation || "");
    state.nativeAnchor = anchor;
    state.lastMatchPath = matchPath;
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
    return { cueIndex, matchPath };
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
    const now = performance.now();
    const gapSinceLastRender = now - state.lastRenderAt;
    state.lastRenderAt = now;
    if (gapSinceLastRender > NATIVE_STALL_GAP_THRESHOLD_MS) {
      // The host page's main thread was unavailable to us for a while (see
      // NATIVE_STALL_GAP_THRESHOLD_MS above) - push the current cue's grace
      // period back by exactly how much time we lost, so it gets the same
      // *effective* search window it would have had if the stall never
      // happened, instead of being penalized for time we were never able to
      // use.
      state.nativeCaptionWaitUntil += gapSinceLastRender;
      state.stallCount += 1;
      state.lastStallGapMs = Math.round(gapSinceLastRender);
      state.totalStallMs += gapSinceLastRender;
    }
    const index = findCueIndex(Number(state.video.currentTime || 0));
    if (index === state.lastCueIndex && state.nativeInjectedCueIndex === index && isInjectionStillValid()) {
      publishDebugState();
      return;
    }
    if (index !== state.lastCueIndex) {
      state.lastCueIndex = index;
      state.nativeInjectedCueIndex = -2;
      state.nativeCaptionWaitUntil = now + NATIVE_CAPTION_GRACE_MS;
      state.nativeSearchExhausted = false;
      // Diagnostics: marks the moment this cue became "current" (via
      // timeupdate/seeked/rVFC), so the latency recorded below on a
      // successful match measures the full user-visible delay - including
      // any time lost to a backlogged main thread - not just the final
      // scan's own duration.
      state.cueChangedAt = now;
    } else if (state.nativeInjectedCueIndex === index && !isInjectionStillValid()) {
      // Echo360 swapped/removed/hid the caption node, or its text drifted
      // away from the injected cue, without a cue-index change (e.g. it
      // re-renders its own box mid-cue). Force an immediate re-match instead
      // of treating a stale injection as "done".
      state.nativeInjectedCueIndex = -2;
      state.nativeSearchExhausted = false;
    }
    const cue = index >= 0 ? state.cues[index] : null;
    if (!state.visible) {
      clearInjectedLines();
      publishDebugState();
      return;
    }
    // As long as this cue hasn't been matched yet, every trigger
    // (timeupdate/rVFC/mutation) retries immediately - no fixed polling
    // interval. Once matched, the early-return above avoids re-scanning the
    // DOM every frame. Once the grace period lapses without ever finding a
    // match (e.g. Echo360's own CC is turned off, so there is nothing to find
    // for the whole video), stop scanning altogether until a real DOM
    // mutation or cue change gives a reason to look again - otherwise this
    // would scan the entire player subtree on every video frame forever.
    //
    // Note nativeInjectedCueIndex holds the cue the visible text actually
    // resolved to, which can trail `index` while Echo360's render is behind
    // (high playback speed). In that state this keeps re-checking every
    // trigger - the sticky-anchor path makes that an O(window) text check,
    // not a full scan - so the moment Echo360 catches up we re-resolve.
    const shouldSearchNative = !!cue && state.nativeInjectedCueIndex !== index && !state.nativeSearchExhausted;
    if (shouldSearchNative) {
      const result = injectIntoNativeCaption(index);
      if (result) {
        const { cueIndex: matchedIndex, matchPath } = result;
        // Only count/log a fresh hit when the resolution actually moved to a
        // new cue - repeatedly reaffirming an already-injected, still-lagging
        // cue while waiting for Echo360 to catch up must not spam
        // nativeInjectionHits/injectionLatencies on every trigger.
        const isNewMatch = matchedIndex !== state.nativeInjectedCueIndex;
        state.nativeInjectedCueIndex = matchedIndex;
        if (isNewMatch) {
          state.nativeInjectionHits += 1;
          // Diagnostics: user-visible "how long after this cue started did the
          // translation actually appear" - the number to watch when diagnosing
          // reports of injection lagging behind after a seek.
          state.injectionLatencies.push({
            cueIndex: matchedIndex,
            latencyMs: Math.round(now - state.cueChangedAt),
            path: matchPath,
          });
          if (state.injectionLatencies.length > 30) state.injectionLatencies.shift();
        }
        publishDebugState();
        return;
      }
      state.nativeInjectedCueIndex = -1;
      if (now >= state.nativeCaptionWaitUntil) {
        state.nativeSearchExhausted = true;
        // Safety net: the mount-time capability pre-check (below) can be a
        // stale/false positive (e.g. Echo360 hadn't wired its <track> yet).
        // Re-check exactly once, at the point native CC injection is about to
        // give up on a
        // real cue, so a genuinely CC-less lesson still gets a definitive
        // "no capability" signal instead of silently showing nothing forever.
        if (!state.capabilityFallbackFired && !ns.sourceFinder.hasNativeCaptionCapability(state.video)) {
          state.capabilityFallbackFired = true;
          const stateBeforeCallback = state;
          state.onNoCaptionCapability?.();
          // The callback commonly re-renders synchronously (e.g. renderer.js
          // falling back to the browser <track> renderer), which calls this
          // module's unmount() - and possibly a fresh mount() - before
          // returning. `state` (the shared module binding, not a local copy)
          // may now be null or an entirely different mount; either way this
          // in-flight renderCurrentCue() call was based on a mount that no
          // longer applies, so bail out instead of dereferencing stale/null
          // state below.
          if (state !== stateBeforeCallback) return;
        }
      }
    }
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
      // Diagnostics: rvfcFrameCount tracks how often the browser actually
      // presents a video frame (i.e. roughly the effective display/decode
      // rate); rvfcRenderCount tracks how many of those actually passed the
      // throttle and triggered a render. A large gap between the two
      // confirms the throttle is doing its job on a high refresh-rate
      // display; if the gap is small but lag persists, the bottleneck is
      // scan cost (see scanCount/lastScanMs), not trigger frequency.
      state.rvfcFrameCount += 1;
      const now = performance.now();
      if (now - state.lastFrameRenderAt >= NATIVE_RENDER_FRAME_THROTTLE_MS) {
        state.lastFrameRenderAt = now;
        state.rvfcRenderCount += 1;
        renderCurrentCue();
      }
      scheduleVideoFrame();
    });
  }

  function updateTranslatedVtt({ originalVtt, translatedVtt, size, reverseOrder }) {
    if (!state) return false;
    const cues = buildCues(originalVtt, translatedVtt);
    if (cues.length === 0) return false;
    state.cues = cues;
    if (size && SIZE_RATIO[size]) state.size = size;
    if (reverseOrder !== undefined) state.reverseOrder = !!reverseOrder;
    state.lastCueIndex = -2;
    state.nativeInjectedCueIndex = -2;
    state.nativeSearchExhausted = false;
    state.nativeAnchor = null;
    state.nativeAnchorDebug = null;
    state.lastMatchPath = "none";
    clearInjectedLines();
    renderCurrentCue();
    publishDebugState();
    return true;
  }

  function mount({ video, originalVtt, translatedVtt, size, reverseOrder, onNoCaptionCapability }) {
    const player = findPlayer(video);
    const cues = buildCues(originalVtt, translatedVtt);
    if (!video || !player || cues.length === 0) return false;

    // Fast path: skip the whole native CC DOM-injection attempt (and its per-cue
    // grace period) when this video has no Echo360-owned caption track at
    // all. There is nothing for the scanner to ever find, so failing fast
    // here lets the caller fall back to the browser <track> renderer
    // immediately instead of waiting out NATIVE_CAPTION_GRACE_MS per cue.
    if (!ns.sourceFinder.hasNativeCaptionCapability(video)) return false;

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
      nativeSearchExhausted: false,
      nativeAnchor: null,
      nativeAnchorDebug: null,
      // Which path produced the last successful injection: "sticky-o1"
      // (O(1) anchor reuse) vs "full-scan" (cold start / anchor lost).
      lastMatchPath: "none",
      onNoCaptionCapability: typeof onNoCaptionCapability === "function" ? onNoCaptionCapability : null,
      capabilityFallbackFired: false,
      listeners: [],
      frameHandle: null,
      lastFrameRenderAt: -Infinity,
      // Initialized to "now" (not -Infinity/0) so the very first
      // renderCurrentCue() call right below doesn't compute a huge fake gap
      // and mistake mount() itself for a host-page stall.
      lastRenderAt: performance.now(),
      mutationObserver: null,
      handlingMutation: false,
      // Diagnostics only (see getDebugState()); none of these affect
      // matching/injection behavior.
      scanCount: 0,
      scanTotalMs: 0,
      lastScanMs: 0,
      lastScanElementCount: 0,
      rvfcFrameCount: 0,
      rvfcRenderCount: 0,
      cueChangedAt: 0,
      injectionLatencies: [],
      stallCount: 0,
      lastStallGapMs: 0,
      totalStallMs: 0,
    };

    for (const eventName of ["timeupdate", "seeked", "play", "loadedmetadata"]) {
      const listener = renderCurrentCue;
      video.addEventListener(eventName, listener);
      state.listeners.push([eventName, listener]);
    }
    state.mutationObserver = new MutationObserver((mutations) => {
      // Handled synchronously, in the same microtask as Echo360's own DOM
      // write: MutationObserver callbacks run before the browser paints, so
      // reacting here (instead of deferring to requestAnimationFrame) lands
      // our injection in the *same* frame as the native caption change
      // instead of the next one.
      if (!state || state.handlingMutation || !mutationCouldAffectActiveCaption(mutations)) return;
      state.handlingMutation = true;
      try {
        // Force a fresh match even if this cue was already resolved: Echo360
        // may have mutated the anchor's text in place (e.g. corrected a typo)
        // without swapping the node, so the presence check alone wouldn't
        // catch it. Also clear the "gave up" flag: a relevant mutation is a
        // concrete reason to look again even if earlier attempts this cue
        // were exhausted.
        state.nativeInjectedCueIndex = -2;
        state.nativeSearchExhausted = false;
        renderCurrentCue();
      } finally {
        state.handlingMutation = false;
      }
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
      injectedLineCount: isInjectedLinePresent() ? 1 : 0,
      nativeInjectionHits: state.nativeInjectionHits,
      waitingForNativeCaption: performance.now() < state.nativeCaptionWaitUntil,
      nativeSearchExhausted: state.nativeSearchExhausted,
      lastMatchPath: state.lastMatchPath,
      playerAttached: state.player.isConnected,
      nativeAnchor: state.nativeAnchorDebug,
      // --- perf diagnostics (added to debug injection lag reports) ---
      playbackRate: state.video.playbackRate,
      // How many full player-subtree scans have run, their cost, and how
      // big the scanned subtree is. High lastScanMs/avgScanMs with a normal
      // element count points at expensive layout/style reads (e.g. Echo360's
      // own CSS-in-JS churn); a very large lastScanElementCount points at
      // the player DOM itself being the bottleneck.
      scanCount: state.scanCount,
      lastScanMs: Math.round(state.lastScanMs * 100) / 100,
      avgScanMs: state.scanCount ? Math.round((state.scanTotalMs / state.scanCount) * 100) / 100 : 0,
      lastScanElementCount: state.lastScanElementCount,
      // How often requestVideoFrameCallback actually fires vs. how many of
      // those firings passed the throttle and triggered a render. A big gap
      // confirms the throttle is absorbing a high-refresh-rate storm; if the
      // gap is small but lag persists, the bottleneck is scan cost instead.
      rvfcFrameCount: state.rvfcFrameCount,
      rvfcRenderCount: state.rvfcRenderCount,
      // How many times a gap of more than NATIVE_STALL_GAP_THRESHOLD_MS was
      // observed between two renderCurrentCue() calls - i.e. how many times
      // the *host page's own main thread* (not this extension) was
      // unavailable to us for a long stretch, and how long in total. A
      // nonzero count here, especially one that lines up with when the
      // reported lag happened, points at the host page (Echo360's player)
      // stalling the shared main thread rather than anything in this scan/
      // injection code.
      stallCount: state.stallCount,
      lastStallGapMs: state.lastStallGapMs,
      totalStallMs: Math.round(state.totalStallMs),
      // Wall-clock time from "this cue became current" to "translation was
      // actually injected", for the last 30 successful matches - the direct
      // measurement of the lag being reported.
      recentInjectionLatenciesMs: state.injectionLatencies.slice(-30),
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
    clearInjectedLines();
    state = null;
    publishDebugState();
  }

  ns.bilingualDomRenderer = {
    mount,
    updateTranslatedVtt,
    unmount,
    setVisible,
    applySize,
    ensureMounted,
    isMounted,
    getDebugState,
  };
})();
