import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

let translator;

beforeAll(() => {
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
      .mockResolvedValueOnce(responseFor("你好"))
      .mockResolvedValueOnce(responseFor("世界"));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    const result = await translator.translateVtt(
      {
        provider: "google-web",
        target: "ZH",
        max_paragraphs: 1,
        vtt_text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello\n\n2\n00:00:01.000 --> 00:00:02.000\nWorld\n",
      },
      { onProgress: progress, partialEmitIntervalMs: 0 }
    );

    expect(result.translated_vtt).toContain("你好");
    expect(result.translated_vtt).toContain("世界");
    expect(result.translated_vtt.indexOf("你好")).toBeLessThan(result.translated_vtt.indexOf("世界"));
    expect(progress).toHaveBeenCalledWith(2, 2, expect.stringContaining("[2/2]"));
  });
});
