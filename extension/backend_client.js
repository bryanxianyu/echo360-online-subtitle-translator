(() => {
  const ns = window.Echo360Translator;
  const extensionApi = ns.browserApi;

  async function proxyRequest(backendUrl, path, method = "GET", payload = null) {
    const response = await extensionApi.runtime.sendMessage({ type: "proxy-request", backendUrl, path, method, payload });
    if (!response || !response.ok) throw new Error(response?.error || "request failed");
    return response.data;
  }

  async function proxyTranslateSync(backendUrl, payload) {
    const response = await extensionApi.runtime.sendMessage({ type: "proxy-translate", backendUrl, payload });
    if (!response || !response.ok) throw new Error(response?.error || "sync translate failed");
    return response.data;
  }

  function friendlyErrorMessage(raw) {
    const msg = String(raw || "");
    const existingCode = msg.match(/\[([A-Z0-9_]+)\]/)?.[1] || "";
    const httpStatus = msg.match(/\bHTTP[\s_]+(\d{3})\b/i)?.[1];
    const code = existingCode || (httpStatus ? `HTTP_${httpStatus}` :
      msg.includes("Failed to fetch") ? "NETWORK_ERROR" :
      msg.includes("ModuleNotFoundError") ? "BACKEND_DEPENDENCY_MISSING" :
      msg.toLowerCase().includes("timeout") ? "TRANSLATION_TIMEOUT" :
      msg.toLowerCase().includes("job not found") ? "JOB_NOT_FOUND" :
      msg.toLowerCase().includes("provider") ? "PROVIDER_CONFIG_ERROR" :
      "TRANSLATION_ERROR");
    const prefix = `[${code}]`;

    if (httpStatus === "401" || httpStatus === "403") return `${prefix} API Key 无效或无权限。`;
    if (msg.includes("Failed to fetch")) return `${prefix} 网络请求失败。请检查网络、Provider 权限，或尝试切换 Provider。`;
    if (msg.includes("ModuleNotFoundError")) return `${prefix} 本地后端依赖缺失。请在 backend 环境执行 pip install -r requirements.txt。`;
    if (msg.toLowerCase().includes("timeout")) return `${prefix} 请求超时，请降低并发或增大超时。`;
    if (msg.toLowerCase().includes("provider")) return `${prefix} Provider/Model 配置有误。`;
    if (msg.toLowerCase().includes("job not found")) return `${prefix} 后台任务不存在，请重试。`;
    return `${prefix} ${msg.replace(/^Error:\s*/, "")}`;
  }

  function formatJobError(job) {
    const message = job.error || "翻译失败";
    const code = job.error_code || (job.status_code ? `HTTP_${job.status_code}` : "");
    return code && !String(message).includes(`[${code}]`) ? `[${code}] ${message}` : message;
  }

  function createDirectTranslateJob(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "direct-translate-async", payload },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response || !response.ok) return reject(new Error(response?.error || "direct translate failed"));
          resolve(response.data);
        }
      );
    });
  }

  function readDirectTranslateJob(jobId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "direct-translate-job", jobId },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response || !response.ok) return reject(new Error(response?.error || "direct translate job failed"));
          resolve(response.data);
        }
      );
    });
  }

  async function waitDirectJob(jobId, options = {}) {
    const maxMs = 8 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (options.isActive && !options.isActive()) {
        throw new Error("stale job");
      }
      const job = await readDirectTranslateJob(jobId);
      const p = job.progress || { current: 0, total: 0 };
      if (job.status === "running" && p.total > 0) {
        options.onProgress?.(p.current, p.total);
      }
      if (job.status === "completed") return job.result;
      if (job.status === "failed") throw new Error(formatJobError(job));
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error("翻译任务超时（超过 8 分钟）");
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
      if (job.status === "failed") throw new Error(formatJobError(job));
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error("翻译任务超时（超过 8 分钟）");
  }

  ns.backendClient = {
    proxyRequest,
    proxyTranslateSync,
    friendlyErrorMessage,
    waitJob,
    createDirectTranslateJob,
    waitDirectJob,
  };
})();
