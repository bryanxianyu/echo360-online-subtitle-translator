chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || (message.type !== "proxy-translate" && message.type !== "proxy-request")) {
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
