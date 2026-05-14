importScripts("browser_api.js");

const extensionApi = globalThis.Echo360ExtensionApi;

extensionApi.runtime.addOnMessageListener(async (message) => {
  if (!message || (message.type !== "proxy-translate" && message.type !== "proxy-request")) {
    return undefined;
  }

  const { backendUrl } = message;
  if (!backendUrl) {
    return { ok: false, error: "missing backendUrl" };
  }

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
      return { ok: false, error: `HTTP ${resp.status} ${text}` };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: "backend returned non-JSON response" };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
