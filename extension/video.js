(() => {
  const ns = window.Echo360Translator;

  function installPageProbe() {
    if (window.__echo360TranslatorProbeInstalled) return;
    window.__echo360TranslatorProbeInstalled = true;

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== "echo360-translator-probe" || !data.record) return;
      if (data.record.kind === "video-snapshot" && Array.isArray(data.record.videos)) {
        ns.state.latestPageVideoSnapshot = data.record.videos;
      }
    });
  }

  function querySelectorAllDeep(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));
    const stack = Array.from(root.querySelectorAll("*"));
    while (stack.length > 0) {
      const el = stack.shift();
      if (!el || !el.shadowRoot) continue;
      results.push(...Array.from(el.shadowRoot.querySelectorAll(selector)));
      stack.push(...Array.from(el.shadowRoot.querySelectorAll("*")));
    }
    return results;
  }

  function getAllVideos() {
    return querySelectorAllDeep("video");
  }

  function getVideoSelectionScore(video) {
    if (!video) return -Infinity;
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
    let score = 0;
    if (!video.paused && !video.ended) score += 1_000_000;
    if (Number(video.currentTime) > 0) score += 100_000 + Number(video.currentTime) * 100;
    score += (Number(video.readyState) || 0) * 10_000;
    if (visible) score += 50_000;
    score += area;
    if (!visible || area < 10_000) score -= 200_000;
    return score;
  }

  function getPrimaryVideo() {
    const videos = getAllVideos();
    if (videos.length === 0) return null;
    const candidates = videos.filter((v) => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      return visible && area > 10_000;
    });
    const pool = candidates.length > 0 ? candidates : videos;
    return pool.slice().sort((a, b) => getVideoSelectionScore(b) - getVideoSelectionScore(a))[0];
  }

  function isVideoLikelyActive(video) {
    if (!video) return false;
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
    return visible && area > 10_000 && !video.ended && (video.readyState || 0) >= 2;
  }

  async function waitForVideo(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const video = getPrimaryVideo();
      if (video) return video;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  function addUuidMatches(text, out) {
    const matches = String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || [];
    for (const id of matches) out.add(id.toLowerCase());
  }

  function collectUuidsFromObject(value, out, depth = 0, seen = new WeakSet()) {
    if (out.size > 120 || depth > 5 || value == null) return;
    const type = typeof value;
    if (type === "string" || type === "number") {
      addUuidMatches(value, out);
      return;
    }
    if (type !== "object" && type !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);

    let keys = [];
    try {
      keys = Reflect.ownKeys(value).slice(0, 120);
    } catch (_) {
      return;
    }
    for (const key of keys) {
      addUuidMatches(key, out);
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      collectUuidsFromObject(next, out, depth + 1, seen);
    }
  }

  function getInternalMediaIdsFromNode(node) {
    const hints = new Set();
    if (!node) return hints;
    let keys = [];
    try {
      keys = Reflect.ownKeys(node);
    } catch (_) {
      return hints;
    }
    for (const key of keys) {
      const name = String(key);
      if (!/(react|fiber|props|state|echo|media|player)/i.test(name)) continue;
      try {
        collectUuidsFromObject(node[key], hints);
      } catch (_) {}
    }
    return hints;
  }

  function extractMediaIdFromVttUrl(url) {
    const m = String(url || "").match(/captions-([0-9a-f-]{36})-/i);
    return m ? m[1].toLowerCase() : "";
  }

  function extractInteractiveMediaId(url) {
    const m = String(url || "").match(/\/api\/ui\/interactive-media\/media\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : "";
  }

  function collectInteractiveMediaIdsFromResources() {
    const ids = new Set();
    const entries = performance.getEntriesByType("resource") || [];
    for (const e of entries) {
      const id = extractInteractiveMediaId(e.name || "");
      if (id) ids.add(id);
    }
    return ids;
  }

  function getVideoHintMediaIds(video) {
    const hints = new Set();
    const add = (s) => addUuidMatches(s, hints);
    add(video?.currentSrc || "");
    add(video?.src || "");
    const attrs = video ? Array.from(video.attributes || []) : [];
    for (const a of attrs) add(a.value);
    let node = video;
    let depth = 0;
    while (node && depth < 5) {
      const at = Array.from(node.attributes || []);
      for (const a of at) add(a.value);
      for (const id of getInternalMediaIdsFromNode(node)) hints.add(id);
      node = node.parentElement;
      depth += 1;
    }
    const videos = getAllVideos();
    const index = videos.indexOf(video);
    const probeVideo = index >= 0 ? ns.state.latestPageVideoSnapshot[index] : null;
    if (probeVideo && Array.isArray(probeVideo.uuidHints)) {
      for (const id of probeVideo.uuidHints) hints.add(String(id).toLowerCase());
    }
    return hints;
  }

  ns.video = {
    installPageProbe,
    querySelectorAllDeep,
    getAllVideos,
    getPrimaryVideo,
    isVideoLikelyActive,
    waitForVideo,
    extractMediaIdFromVttUrl,
    collectInteractiveMediaIdsFromResources,
    getVideoHintMediaIds,
  };
})();
