/**
 * Branch-coverage tests for extension/backend_client.js (extension direct-translate path)
 *
 * Store 构建下翻译在扩展内完成（createDirectTranslateJob / waitDirectJob），
 * 不依赖 Python 后端。此处只覆盖扩展侧错误格式化与直连任务轮询。
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

let client;

// ── setup ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  const ns = makeFullNs({
    browserApi: {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
    },
  });
  // backend_client.js also calls chrome.runtime.sendMessage directly
  // (for direct-translate messages). Stub the global chrome object.
  globalThis.chrome = {
    runtime: {
      sendMessage: vi.fn(),
      lastError: null,
    },
  };
  window.Echo360Translator = ns;
  evalModule("backend_client.js");
  client = window.Echo360Translator.backendClient;
});

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.chrome.runtime.lastError = null;
});

// ---------------------------------------------------------------------------
// friendlyErrorMessage
// ---------------------------------------------------------------------------
describe("friendlyErrorMessage", () => {
  it("preserves an existing [CODE] prefix already in the message", () => {
    const msg = "[MY_CODE] something went wrong";
    const result = client.friendlyErrorMessage(msg);
    expect(result).toContain("[MY_CODE]");
  });

  it("extracts HTTP 401 status and returns auth error", () => {
    const result = client.friendlyErrorMessage("HTTP 401 Unauthorized");
    expect(result).toContain("[HTTP_401]");
    expect(result).toContain("API Key 无效");
  });

  it("extracts HTTP 403 status and returns auth error", () => {
    const result = client.friendlyErrorMessage("HTTP 403 Forbidden");
    expect(result).toContain("[HTTP_403]");
    expect(result).toContain("API Key 无效");
  });

  it("handles HTTP_403 underscore format", () => {
    const result = client.friendlyErrorMessage("HTTP_403 error");
    expect(result).toContain("[HTTP_403]");
  });

  it("maps 'Failed to fetch' to NETWORK_ERROR", () => {
    const result = client.friendlyErrorMessage("Failed to fetch");
    expect(result).toContain("[NETWORK_ERROR]");
    expect(result).toContain("网络请求失败");
  });

  it("maps 'timeout' (case-insensitive) to TRANSLATION_TIMEOUT", () => {
    const result = client.friendlyErrorMessage("Request Timeout after 30s");
    expect(result).toContain("[TRANSLATION_TIMEOUT]");
    expect(result).toContain("超时");
  });

  it("maps 'job not found' (case-insensitive) to JOB_NOT_FOUND", () => {
    const result = client.friendlyErrorMessage("job not found");
    expect(result).toContain("[JOB_NOT_FOUND]");
  });

  it("maps 'provider' (case-insensitive) to PROVIDER_CONFIG_ERROR", () => {
    const result = client.friendlyErrorMessage("Invalid Provider setting");
    expect(result).toContain("[PROVIDER_CONFIG_ERROR]");
    expect(result).toContain("Provider/Model 配置有误");
  });

  it("falls back to TRANSLATION_ERROR for generic messages", () => {
    const result = client.friendlyErrorMessage("Something completely unknown");
    expect(result).toContain("[TRANSLATION_ERROR]");
    expect(result).toContain("Something completely unknown");
  });

  it("handles null / undefined gracefully", () => {
    expect(() => client.friendlyErrorMessage(null)).not.toThrow();
    expect(() => client.friendlyErrorMessage(undefined)).not.toThrow();
  });

  it("strips leading 'Error: ' prefix from generic messages", () => {
    const result = client.friendlyErrorMessage("Error: network blip");
    expect(result).not.toMatch(/^\[.+\] Error: /);
    expect(result).toContain("network blip");
  });

  it("handles non-401/403 HTTP status codes as generic error", () => {
    const result = client.friendlyErrorMessage("HTTP 500 Internal Server Error");
    expect(result).toContain("[HTTP_500]");
    expect(result).not.toContain("API Key");
  });
});

// ---------------------------------------------------------------------------
// formatJobError (accessed via waitJob / waitDirectJob paths; test indirectly)
// ---------------------------------------------------------------------------
describe("formatJobError (via waitDirectJob)", () => {
  async function runDirectJobWith(jobData) {
    let calls = 0;
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls += 1;
      if (calls === 1) cb({ ok: true, data: { job_id: "job-1" } }); // createDirectTranslateJob
      else cb({ ok: true, data: jobData });
    });
    return client.waitDirectJob("job-1", { isActive: () => true });
  }

  it("returns result on completed job", async () => {
    const result = await runDirectJobWith({
      status: "completed",
      result: { translated_vtt: "WEBVTT\n\n", warnings: [], cache_hit: false },
      progress: { current: 0, total: 0 },
    });
    expect(result.translated_vtt).toBe("WEBVTT\n\n");
  });

  it("throws error with [error_code] prefix when job fails (code not already in message)", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "rate limit exceeded",
        error_code: "HTTP_429",
        status_code: 429,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/\[HTTP_429\]/);
  });

  it("does NOT duplicate code prefix when it is already in the message", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "[HTTP_429] rate limit exceeded",
        error_code: "HTTP_429",
        status_code: 429,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/^\[HTTP_429\] rate limit exceeded$/);
  });

  it("uses status_code when error_code is absent", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "upstream error",
        error_code: "",
        status_code: 503,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/\[HTTP_503\]/);
  });

  it("uses default message '翻译失败' when job.error is empty", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "",
        error_code: "",
        status_code: null,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow("翻译失败");
  });

  it("throws stale error when isActive returns false", async () => {
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      cb({ ok: true, data: { status: "running", progress: { current: 0, total: 0 } } });
    });
    await expect(
      client.waitDirectJob("job-1", { isActive: () => false })
    ).rejects.toThrow("stale job");
  });

  it("calls onProgress when job is running and total > 0", async () => {
    const onProgress = vi.fn();
    let calls = 0;
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls += 1;
      if (calls === 1) {
        cb({
          ok: true,
          data: {
            status: "running",
            progress: { current: 3, total: 10, line: "[3/10] Translating" },
          },
        });
      } else {
        cb({
          ok: true,
          data: {
            status: "completed",
            result: { translated_vtt: "WEBVTT\n\n", warnings: [], cache_hit: false },
            progress: { current: 10, total: 10 },
          },
        });
      }
    });
    await client.waitDirectJob("job-1", { isActive: () => true, onProgress });
    expect(onProgress).toHaveBeenCalledWith(3, 10);
  });

  it("calls onPartialVtt when partial_vtt changes during polling", async () => {
    const onPartialVtt = vi.fn();
    let calls = 0;
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      calls += 1;
      if (calls === 1) {
        cb({
          ok: true,
          data: {
            status: "running",
            partial_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial\n",
            progress: { current: 1, total: 10, partial: true },
          },
        });
      } else {
        cb({
          ok: true,
          data: {
            status: "completed",
            result: { translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nDone\n", warnings: [], cache_hit: false },
            progress: { current: 10, total: 10 },
          },
        });
      }
    });
    await client.waitDirectJob("job-1", { isActive: () => true, onPartialVtt });
    expect(onPartialVtt).toHaveBeenCalledWith(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial\n",
      expect.objectContaining({ current: 1, total: 10 })
    );
  });
});
