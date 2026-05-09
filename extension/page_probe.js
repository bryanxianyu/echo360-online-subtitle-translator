(() => {
  if (window.__echo360Probe && window.__echo360Probe.installed) return;

  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const records = [];
  const CAPTURE_NETWORK_DETAILS = false;

  const interestingUrl = (url) =>
    /echo360|captions|caption|subtitle|webvtt|m3u8|mpd|manifest|playlist|interactive-media|transcode|hls|dash|segment|chunk|media/i
      .test(String(url || ""));

  const addUuids = (value, out) => {
    const matches = String(value || "").match(uuidRe) || [];
    matches.forEach((id) => out.add(id.toLowerCase()));
  };

  const collectObjectUuids = (value, out, depth = 0, seen = new WeakSet()) => {
    if (out.size > 120 || depth > 5 || value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      addUuids(value, out);
      return;
    }
    if (typeof value !== "object" && typeof value !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);

    let keys = [];
    try {
      keys = Reflect.ownKeys(value).slice(0, 120);
    } catch (_) {
      return;
    }
    for (const key of keys) {
      addUuids(key, out);
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      collectObjectUuids(next, out, depth + 1, seen);
    }
  };

  const reactHints = (el) => {
    const out = new Set();
    let node = el;
    let depth = 0;
    while (node && depth < 6) {
      let keys = [];
      try {
        keys = Reflect.ownKeys(node);
      } catch (_) {
        keys = [];
      }
      for (const key of keys) {
        const name = String(key);
        if (!/(react|fiber|props|state|echo|media|player)/i.test(name)) continue;
        try {
          collectObjectUuids(node[key], out);
        } catch (_) {}
      }
      node = node.parentElement;
      depth += 1;
    }
    return [...out];
  };

  const push = (record) => {
    const item = { time: Date.now(), ...record };
    records.push(item);
    if (records.length > 500) records.splice(0, records.length - 500);
    window.postMessage({ source: "echo360-translator-probe", record: item }, "*");
  };

  window.__echo360Probe = {
    installed: true,
    records,
    clear() {
      records.length = 0;
    },
    dump(kind) {
      return kind ? records.filter((r) => r.kind === kind) : records.slice();
    },
    resources() {
      return performance.getEntriesByType("resource")
        .map((e) => e.name)
        .filter((name) => interestingUrl(name));
    },
    videos() {
      return [...document.querySelectorAll("video")].map((v, i) => {
        const rect = v.getBoundingClientRect();
        const ids = new Set();
        addUuids(v.currentSrc, ids);
        addUuids(v.src, ids);
        [...v.attributes].forEach((a) => addUuids(a.value, ids));
        reactHints(v).forEach((id) => ids.add(id));
        return {
          i,
          currentTime: Number(v.currentTime || 0).toFixed(2),
          duration: Number(v.duration || 0).toFixed(2),
          paused: v.paused,
          ended: v.ended,
          readyState: v.readyState,
          area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
          currentSrc: v.currentSrc || "",
          src: v.src || "",
          uuidHints: [...ids],
        };
      });
    },
    summary() {
      return {
        videos: this.videos(),
        resources: this.resources(),
        recentNetwork: records.filter((r) => r.kind === "fetch" || r.kind === "xhr").slice(-30),
        mediaEvents: records.filter((r) => r.kind === "media-event").slice(-30),
      };
    },
  };

  const postVideoSnapshot = () => {
    const videos = window.__echo360Probe.videos();
    if (videos.length > 0) push({ kind: "video-snapshot", videos });
  };
  window.__echo360Probe.snapshot = postVideoSnapshot;
  setTimeout(postVideoSnapshot, 0);
  setInterval(postVideoSnapshot, 1500);

  const originalFetch = window.fetch;
  if (CAPTURE_NETWORK_DETAILS && originalFetch && !originalFetch.__echo360ProbePatched) {
    const patchedFetch = async function(input, init) {
      const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      const started = performance.now();
      try {
        const resp = await originalFetch.apply(this, arguments);
        const url = resp.url || rawUrl;
        if (interestingUrl(url)) {
          const contentType = resp.headers.get("content-type") || "";
          const base = {
            kind: "fetch",
            url,
            status: resp.status,
            contentType,
            elapsedMs: Math.round(performance.now() - started),
          };
          if (/json|text|xml|mpegurl|dash|vtt/i.test(contentType) || /api\/|m3u8|mpd|vtt|caption|subtitle/i.test(url)) {
            resp.clone().text()
              .then((text) => push({ ...base, bodyLength: text.length, bodyPreview: text.slice(0, 4000) }))
              .catch(() => push(base));
          } else {
            push(base);
          }
        }
        return resp;
      } catch (err) {
        if (interestingUrl(rawUrl)) push({ kind: "fetch-error", url: String(rawUrl), error: String(err) });
        throw err;
      }
    };
    patchedFetch.__echo360ProbePatched = true;
    window.fetch = patchedFetch;
  }

  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (CAPTURE_NETWORK_DETAILS && xhrProto && !xhrProto.open.__echo360ProbePatched) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    xhrProto.open = function(method, url) {
      this.__echo360Probe = { method, url: String(url || ""), started: performance.now() };
      return originalOpen.apply(this, arguments);
    };
    xhrProto.open.__echo360ProbePatched = true;
    xhrProto.send = function() {
      const xhr = this;
      const meta = xhr.__echo360Probe || {};
      const shouldHideExpectedEcho404 =
        interestingUrl(meta.url) &&
        /\/api\/ui\/(?:interactive-media|discussions)\//i.test(meta.url || "");
      if (shouldHideExpectedEcho404) {
        xhr.addEventListener("error", (event) => event.stopImmediatePropagation(), true);
      }
      xhr.addEventListener("loadend", () => {
        const url = xhr.responseURL || meta.url || "";
        if (!interestingUrl(url)) return;
        let bodyPreview = "";
        let bodyLength = 0;
        try {
          if (!xhr.responseType || xhr.responseType === "text" || xhr.responseType === "json") {
            bodyPreview = String(xhr.responseText || "").slice(0, 4000);
            bodyLength = String(xhr.responseText || "").length;
          }
        } catch (_) {}
        push({
          kind: "xhr",
          method: meta.method || "",
          url,
          status: xhr.status,
          contentType: xhr.getResponseHeader("content-type") || "",
          elapsedMs: Math.round(performance.now() - (meta.started || performance.now())),
          bodyLength,
          bodyPreview,
        });
      });
      return originalSend.apply(this, arguments);
    };
  }

  const mediaEvents = ["loadedmetadata", "durationchange", "play", "pause", "emptied", "loadeddata", "canplay"];
  for (const eventName of mediaEvents) {
    document.addEventListener(eventName, (event) => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      const ids = new Set();
      addUuids(target.currentSrc, ids);
      addUuids(target.src, ids);
      reactHints(target).forEach((id) => ids.add(id));
      push({
        kind: "media-event",
        event: eventName,
        currentTime: Number(target.currentTime || 0).toFixed(2),
        duration: Number(target.duration || 0).toFixed(2),
        paused: target.paused,
        currentSrc: target.currentSrc || "",
        src: target.src || "",
        uuidHints: [...ids],
      });
    }, true);
  }
})();
