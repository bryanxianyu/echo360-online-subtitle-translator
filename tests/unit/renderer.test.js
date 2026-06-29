import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const ORIG_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

`;

const TRANS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

`;

function setupRenderer({ domMountResult = true, buildBilingualVtt } = {}) {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  const video = document.createElement("video");
  Object.defineProperty(video, "duration", { value: 2, configurable: true });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    bottom: 360,
    right: 640,
  });
  document.body.appendChild(video);

  const domMount = vi.fn(() => domMountResult);
  window.Echo360Translator = makeFullNs({
    video: {
      getAllVideos: () => [video],
      querySelectorAllDeep: (selector) => Array.from(document.querySelectorAll(selector)),
      getVideoHintMediaIds: () => new Set(),
    },
    sourceFinder: {
      buildSourceMeta: () => ({ sourceId: "", mediaId: "", mapSource: "", stats: { maxEnd: 2 } }),
      pickBestMountVideoByVtt: () => video,
    },
    vtt: {
      isAlreadyBilingualVtt: () => false,
      extractPrimaryTranslatedVtt: (vtt) => vtt,
      normalizeBilingualOrderZhFirst: (vtt) => vtt,
      applyCueBottom: (vtt) => vtt,
    },
    subtitleStrategy: {
      buildBilingualVtt: buildBilingualVtt || (({ translatedVtt }) => translatedVtt),
    },
    bilingualDomRenderer: {
      mount: domMount,
      unmount: vi.fn(),
      isMounted: () => false,
      ensureMounted: vi.fn(),
      setVisible: vi.fn(),
      applySize: vi.fn(),
    },
    storage: {
      getPrefs: vi.fn(async () => ({ enabled: true, useNativeSubtitles: false })),
    },
  });
  evalModule("renderer.js");
  return { renderer: window.Echo360Translator.renderer, video, domMount };
}

describe("renderer Echo360 native CC beta mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the DOM renderer without creating a browser track", () => {
    const { renderer, video, domMount } = setupRenderer({ domMountResult: true });

    const mounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);

    expect(mounted).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll("track").length).toBe(0);
  });

  it("removes an existing translated browser track before mounting the DOM renderer", () => {
    const { renderer, video, domMount } = setupRenderer({ domMountResult: true });
    const existingTrack = document.createElement("track");
    existingTrack.setAttribute("data-echo360-translated", "1");
    existingTrack.label = "翻译字幕";
    video.appendChild(existingTrack);

    const mounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);

    expect(mounted).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelector('track[data-echo360-translated="1"]')).toBeNull();
  });

  it("does not fall back to creating a browser track when DOM mounting fails", () => {
    const { renderer, video, domMount } = setupRenderer({ domMountResult: false });

    const mounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);

    expect(mounted).toBe(false);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll("track").length).toBe(0);
  });
});

describe("renderer browser track mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    let objectUrlId = 0;
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => `blob:echo360-test-${++objectUrlId}`),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
    });
  });

  it("replaces the browser track when bilingual or reverse-order rendering changes the VTT payload", () => {
    const { renderer, video } = setupRenderer({
      buildBilingualVtt: ({ translatedVtt, reverseOrder }) => `${translatedVtt}\n${reverseOrder ? "reverse" : "normal"}`,
    });

    const firstMounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, true);
    const firstTrack = video.querySelector('track[data-echo360-translated="1"]');
    const firstSrc = firstTrack?.getAttribute("src");

    const secondMounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", true, null, true);
    const secondTrack = video.querySelector('track[data-echo360-translated="1"]');
    const secondSrc = secondTrack?.getAttribute("src");

    expect(firstMounted).toBe(true);
    expect(secondMounted).toBe(true);
    expect(firstTrack).not.toBeNull();
    expect(secondTrack).not.toBeNull();
    expect(secondTrack).not.toBe(firstTrack);
    expect(secondSrc).not.toBe(firstSrc);
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });
});
