import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

let translator;

beforeAll(() => {
  evalModule("provider_config.js");
  evalModule("direct_translator.js");
  translator = globalThis.Echo360DirectTranslator;
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

function responseFor(text) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([[[text, ""]]]),
  };
}

function providerJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

describe("direct translator task lifecycle", () => {
  it("stops before issuing a provider request when cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(translator.translateVtt(
      {
        provider: "google-web",
        target: "ZH",
        vtt_text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello\n",
      },
      { isCancelled: () => true }
    )).rejects.toThrow("translation cancelled");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps cue order and emits progress for successful batches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(responseFor("你好\n世界"));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    const result = await translator.translateVtt(
      {
        provider: "google-web",
        target: "ZH",
        max_paragraphs: 20,
        max_chars: 2000,
        vtt_text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello\n\n2\n00:00:01.000 --> 00:00:02.000\nWorld\n",
      },
      { onProgress: progress, partialEmitIntervalMs: 0 }
    );

    expect(result.translated_vtt).toContain("你好");
    expect(result.translated_vtt).toContain("世界");
    expect(result.translated_vtt.indexOf("你好")).toBeLessThan(result.translated_vtt.indexOf("世界"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(2, 2, expect.stringContaining("[2/2]"));
  });
});

describe("single-request provider translation probe", () => {
  it("uses the selected unknown model in exactly one real translation request and omits unset reasoning", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerJsonResponse({ output_text: "这节课九点开始。" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translator.probeTranslation({ provider: "openai", api_key: "test-secret", model: "brand-new-model", target: "ZH", timeout: 9 });
    expect(result.translation).toBe("这节课九点开始。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe("brand-new-model");
    expect(request.reasoning).toBeUndefined();
  });

  it("infers Chat Completions from an OpenAI-compatible endpoint path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerJsonResponse({ choices: [{ message: { content: "这节课九点开始。" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await translator.probeTranslation({
      provider: "openai",
      api_key: "test-secret",
      model: "compatible-model",
      endpoint: "https://proxy.example/v1/chat/completions",
      target: "ZH",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/v1/chat/completions");
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.model).toBe("compatible-model");
    expect(request.messages).toHaveLength(2);
    expect(request.input).toBeUndefined();
  });

  it("rejects a missing model before any request instead of using a hardcoded fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(translator.probeTranslation({ provider: "gemini", api_key: "test-secret", model: "", target: "ZH" })).rejects.toThrow("选择或输入模型 ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat an unchanged source response as a successful translation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerJsonResponse({ output_text: "The lecture begins at nine." }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(translator.probeTranslation({ provider: "openai", api_key: "test-secret", model: "unknown-model", target: "FR" })).rejects.toMatchObject({ category: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a custom Google endpoint's safe query parameters without malformed duplicate separators", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFor("你好"));
    vi.stubGlobal("fetch", fetchMock);
    await translator.probeTranslation({
      provider: "google-web",
      endpoint: "https://translate.googleapis.com/translate_a/single?client=proxy",
      target: "ZH",
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("client")).toBe("gtx");
    expect(url.searchParams.get("sl")).toBe("auto");
    expect(url.searchParams.get("tl")).toBe("zh-CN");
    expect(url.searchParams.get("q")).toBe("The lecture begins at nine.");
  });
});
