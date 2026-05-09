(() => {
  const ns = window.Echo360Translator;

  function proxyRequest(backendUrl, path, method = "GET", payload = null) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "proxy-request", backendUrl, path, method, payload },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response || !response.ok) return reject(new Error(response?.error || "request failed"));
          resolve(response.data);
        }
      );
    });
  }

  function proxyTranslateSync(backendUrl, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "proxy-translate", backendUrl, payload },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response || !response.ok) return reject(new Error(response?.error || "sync translate failed"));
          resolve(response.data);
        }
      );
    });
  }

  function friendlyErrorMessage(raw) {
    const msg = String(raw || "");
    if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) return "API Key 无效或无权限。";
    if (msg.includes("timeout")) return "请求超时，请降低并发或增大超时。";
    if (msg.includes("provider")) return "Provider/Model 配置有误。";
    if (msg.includes("job not found")) return "后台任务不存在，请重试。";
    return msg.replace(/^Error:\s*/, "");
  }

  async function waitJob(backendUrl, jobId, options = {}) {
    const maxMs = 8 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (options.isActive && !options.isActive()) {
        throw new Error("stale job");
      }
      const job = await proxyRequest(backendUrl, `/translate-async/${jobId}`);
      const p = job.progress || { current: 0, total: 0 };
      if (job.status === "running" && p.total > 0) {
        options.onProgress?.(p.current, p.total);
      }
      if (job.status === "completed") return job.result;
      if (job.status === "failed") throw new Error(job.error || "翻译失败");
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error("翻译任务超时（超过 8 分钟）");
  }

  ns.backendClient = {
    proxyRequest,
    proxyTranslateSync,
    friendlyErrorMessage,
    waitJob,
  };
})();
