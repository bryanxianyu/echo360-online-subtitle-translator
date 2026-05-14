importScripts("direct_translator.js");

const DIRECT_CACHE_KEY = "echo360DirectTranslateCache";
const DIRECT_CACHE_MAX_ENTRIES = 10;
const DIRECT_CACHE_MAX_CHARS = 5_000_000;
const DIRECT_JOB_TTL_MS = 60 * 60 * 1000;
const DIRECT_JOB_MAX_COUNT = 100;
const directJobs = new Map();

function storageGetLocal(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve(result);
    });
  });
}

function storageSetLocal(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || String(err)));
      else resolve();
    });
  });
}

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildDirectCacheKey(payload) {
  const digestInput = {
    vtt_text: payload.vtt_text || "",
    provider: payload.provider || "",
    model: payload.model || "",
    endpoint: payload.endpoint || "",
    target: payload.target || "",
    max_paragraphs: payload.max_paragraphs || 0,
    max_chars: payload.max_chars || 0,
    bilingual: !!payload.bilingual,
    reasoning_effort: payload.reasoning_effort || "",
    deepseek_thinking_mode: payload.deepseek_thinking_mode || "",
    deepl_formality: payload.deepl_formality || "",
  };
  return sha256Text(JSON.stringify(digestInput));
}

async function getDirectCache() {
  const obj = await storageGetLocal(DIRECT_CACHE_KEY);
  const cache = obj[DIRECT_CACHE_KEY];
  return cache && typeof cache === "object" ? cache : {};
}

async function getDirectCacheEntry(cacheKey) {
  const cache = await getDirectCache();
  const entry = cache[cacheKey];
  if (!entry?.translated_vtt) return null;
  entry.used_at = Date.now();
  try {
    await setDirectCache(cache);
  } catch (_) {
    // Cache metadata updates should never block a valid cache hit.
  }
  return entry;
}

function pruneDirectCache(cache) {
  const entries = Object.entries(cache)
    .filter(([, entry]) => entry?.translated_vtt)
    .sort((a, b) => Number(b[1].used_at || b[1].created_at || 0) - Number(a[1].used_at || a[1].created_at || 0));
  const next = {};
  let totalChars = 0;
  for (const [key, entry] of entries) {
    const size = Number(entry.size || entry.translated_vtt.length || 0);
    if (Object.keys(next).length >= DIRECT_CACHE_MAX_ENTRIES) continue;
    if (totalChars + size > DIRECT_CACHE_MAX_CHARS) continue;
    next[key] = entry;
    totalChars += size;
  }
  return next;
}

async function setDirectCache(cache) {
  await storageSetLocal({ [DIRECT_CACHE_KEY]: pruneDirectCache(cache) });
}

async function setDirectCacheEntry(cacheKey, translatedVtt) {
  if (!translatedVtt) return;
  const cache = await getDirectCache();
  cache[cacheKey] = {
    translated_vtt: translatedVtt,
    created_at: Date.now(),
    used_at: Date.now(),
    size: translatedVtt.length,
  };
  try {
    await setDirectCache(cache);
  } catch (_) {
    await storageSetLocal({
      [DIRECT_CACHE_KEY]: pruneDirectCache({ [cacheKey]: cache[cacheKey] }),
    });
  }
}

function createDirectJob(payload) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    status: "running",
    progress: { current: 0, total: 0 },
    result: null,
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  directJobs.set(jobId, job);

  (async () => {
    try {
      const cacheKey = await buildDirectCacheKey(payload);
      if (!payload.force_refresh) {
        const cached = await getDirectCacheEntry(cacheKey);
        if (cached) {
          job.status = "completed";
          job.result = { translated_vtt: cached.translated_vtt, warnings: [], cache_hit: true };
          job.updatedAt = Date.now();
          return;
        }
      }
      const result = await Echo360DirectTranslator.translateVtt(payload, (current, total, line = "") => {
        job.progress = { current, total, line };
        job.updatedAt = Date.now();
      });
      job.status = "completed";
      job.result = { ...result, cache_hit: false };
      job.updatedAt = Date.now();
      await setDirectCacheEntry(cacheKey, result.translated_vtt);
    } catch (err) {
      job.status = "failed";
      job.error = err?.message || String(err);
      job.updatedAt = Date.now();
    }
  })();

  return jobId;
}

function pruneDirectJobs() {
  const now = Date.now();
  for (const [jobId, job] of directJobs.entries()) {
    if (now - (job.updatedAt || job.createdAt) > DIRECT_JOB_TTL_MS) directJobs.delete(jobId);
  }
  const overflow = directJobs.size - DIRECT_JOB_MAX_COUNT;
  if (overflow > 0) {
    const removable = Array.from(directJobs.entries())
      .filter(([, job]) => job.status === "completed" || job.status === "failed")
      .sort((a, b) => Number(a[1].updatedAt || a[1].createdAt || 0) - Number(b[1].updatedAt || b[1].createdAt || 0));
    for (const [jobId] of removable.slice(0, overflow)) directJobs.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "direct-translate-async") {
    pruneDirectJobs();
    const jobId = createDirectJob(message.payload || {});
    sendResponse({ ok: true, data: { job_id: jobId } });
    return false;
  }

  if (message.type === "direct-translate-job") {
    const job = directJobs.get(message.jobId);
    if (!job) {
      sendResponse({ ok: false, error: "job not found" });
      return false;
    }
    sendResponse({ ok: true, data: job });
    return false;
  }

  if (message.type !== "proxy-translate" && message.type !== "proxy-request") {
    return false;
  }

  const { backendUrl } = message;
  if (!backendUrl) {
    sendResponse({ ok: false, error: "missing backendUrl" });
    return false;
  }

  (async () => {
    try {
      const base = backendUrl.replace(/\/+$/, "");
      const path = message.type === "proxy-translate" ? "/translate" : (message.path || "/health");
      const method = message.type === "proxy-translate" ? "POST" : (message.method || "GET");
      const headers = { "Content-Type": "application/json", ...(message.headers || {}) };
      const init = { method, headers };
      if (message.payload != null) {
        init.body = JSON.stringify(message.payload);
      }
      const resp = await fetch(`${base}${path}`, init);
      const text = await resp.text();
      if (!resp.ok) {
        sendResponse({ ok: false, error: `HTTP ${resp.status} ${text}` });
        return;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        sendResponse({ ok: false, error: "backend returned non-JSON response" });
        return;
      }
      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
