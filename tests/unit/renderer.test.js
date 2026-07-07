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
  let objectUrlId = 0;
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => `blob:echo360-test-${++objectUrlId}`),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });
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

  let domMounted = false;
  let lastMountOpts = null;
  const domMount = vi.fn((opts) => {
    lastMountOpts = opts;
    if (!domMountResult) return false;
    domMounted = true;
    return true;
  });
  const domUpdate = vi.fn(() => domMounted);
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
      updateTranslatedVtt: domUpdate,
      unmount: vi.fn(() => {
        domMounted = false;
      }),
      isMounted: () => domMounted,
      ensureMounted: vi.fn(),
      setVisible: vi.fn(),
      applySize: vi.fn(),
    },
    storage: {
      getPrefs: vi.fn(async () => ({ enabled: true, useNativeSubtitles: false })),
    },
  });
  evalModule("renderer.js");
  return {
    renderer: window.Echo360Translator.renderer,
    video,
    domMount,
    domUpdate,
    getLastMountOpts: () => lastMountOpts,
  };
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

  it("falls back to a browser track immediately when DOM mounting refuses synchronously (e.g. no native caption capability)", () => {
    const { renderer, video, domMount } = setupRenderer({ domMountResult: false });

    const mounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);

    expect(mounted).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });

  it("passes an onNoCaptionCapability callback to the DOM renderer on mount", () => {
    const { renderer, getLastMountOpts } = setupRenderer({ domMountResult: true });

    renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);

    expect(typeof getLastMountOpts().onNoCaptionCapability).toBe("function");
  });

  it("falls back to a browser track when the DOM renderer later reports no native caption capability", () => {
    const { renderer, video, getLastMountOpts } = setupRenderer({ domMountResult: true });

    const mounted = renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    expect(mounted).toBe(true);
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(0);

    // Simulate bilingual_dom_renderer.js confirming (after the per-cue grace
    // period) that this lesson has no native CC capability at all.
    getLastMountOpts().onNoCaptionCapability();

    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });

  it("uses the user's real browser-mode preference (not Beta's forced bilingual=true) when falling back synchronously", () => {
    // Beta forces bilingual=true/reverseOrder=false on its own params - but
    // the user's actual saved preference for browser-track mode can be
    // anything, independently. A naive fallback that reuses Beta's forced
    // pair would silently force bilingual-on even for a user who explicitly
    // wants monolingual browser subtitles.
    const buildBilingualVtt = vi.fn(({ translatedVtt }) => translatedVtt);
    const { renderer, video } = setupRenderer({ domMountResult: false, buildBilingualVtt });

    const mounted = renderer.renderTranslatedTrack(
      TRANS_VTT, ORIG_VTT, true, "medium", false, null, false,
      { browserBilingual: false, browserReverseOrder: false }
    );

    expect(mounted).toBe(true);
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
    // renderTranslatedTrack() speculatively builds a bilingual payload from
    // its *own* bilingual/reverseOrder params before it even knows whether
    // Beta will succeed - that first (wasted) call reflects Beta's forced
    // bilingual=true and is unavoidable here. The bug this guards against is
    // the *fallback* recursion also using that forced true instead of
    // browserBilingual=false: that would produce a second call, so a fixed
    // implementation must show exactly one call total, not two.
    expect(buildBilingualVtt).toHaveBeenCalledTimes(1);
  });

  it("uses the user's real browser-mode preference when the DOM renderer reports no native caption capability at runtime", () => {
    const buildBilingualVtt = vi.fn(({ translatedVtt, reverseOrder }) => `${translatedVtt}::${reverseOrder}`);
    const { renderer, getLastMountOpts } = setupRenderer({ domMountResult: true, buildBilingualVtt });

    const mounted = renderer.renderTranslatedTrack(
      TRANS_VTT, ORIG_VTT, true, "medium", false, null, false,
      { browserBilingual: true, browserReverseOrder: true }
    );
    expect(mounted).toBe(true);
    buildBilingualVtt.mockClear();

    getLastMountOpts().onNoCaptionCapability();

    expect(buildBilingualVtt).toHaveBeenCalledWith(expect.objectContaining({ reverseOrder: true }));
  });

  it("updates the DOM renderer in place during incremental beta preview refreshes", () => {
    const partialVtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Partial

`;
    const { renderer, domMount, domUpdate } = setupRenderer({ domMountResult: true });

    expect(renderer.renderTranslatedTrack(partialVtt, ORIG_VTT, true, "medium", false, null, false)).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(domUpdate).not.toHaveBeenCalled();

    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false, { incremental: true })).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(domUpdate).toHaveBeenCalledOnce();
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

  it("updates the same browser track element during incremental preview refreshes", () => {
    const partialVtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Partial

`;
    const { renderer, video } = setupRenderer();

    expect(renderer.renderTranslatedTrack(partialVtt, ORIG_VTT, false, "medium", false, null, true)).toBe(true);
    const firstTrack = video.querySelector('track[data-echo360-translated="1"]');
    const firstSrc = firstTrack?.getAttribute("src");

    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true, { incremental: true })).toBe(true);
    const secondTrack = video.querySelector('track[data-echo360-translated="1"]');
    const secondSrc = secondTrack?.getAttribute("src");

    expect(secondTrack).toBe(firstTrack);
    expect(secondSrc).not.toBe(firstSrc);
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });
});
