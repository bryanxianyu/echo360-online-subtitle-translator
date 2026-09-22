import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const ORIG_VTT = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n`;
const TRANS_VTT = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n你好世界\n\n`;

function setupRenderer({ domMountResult = true } = {}) {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  const video = document.createElement("video");
  Object.defineProperty(video, "duration", { value: 2, configurable: true });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({ width: 640, height: 360, top: 0, left: 0, bottom: 360, right: 640 });
  document.body.appendChild(video);

  let domMounted = false;
  let overlayMounted = false;
  let lastMountOpts = null;
  const domMount = vi.fn((opts) => {
    lastMountOpts = opts;
    domMounted = !!domMountResult;
    return domMounted;
  });
  const overlayMount = vi.fn(() => { overlayMounted = true; return true; });
  const ns = window.Echo360Translator = makeFullNs({
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
      buildIncrementalPreviewVtt: (vtt) => vtt,
    },
    bilingualDomRenderer: {
      mount: domMount,
      updateTranslatedVtt: vi.fn(() => domMounted),
      unmount: vi.fn(() => { domMounted = false; }),
      isMounted: () => domMounted,
      ensureMounted: vi.fn(),
      setVisible: vi.fn(),
      applySize: vi.fn(),
    },
    subtitleOverlay: {
      mount: overlayMount,
      unmount: vi.fn(() => { overlayMounted = false; }),
      isMounted: () => overlayMounted,
      getVideo: () => overlayMounted ? video : null,
      setVisible: vi.fn(),
      applySize: vi.fn(),
      refresh: vi.fn(),
    },
  });
  evalModule("renderer.js");
  return { ns, renderer: ns.renderer, video, domMount, overlayMount, getLastMountOpts: () => lastMountOpts };
}

describe("renderer orchestration", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("mounts the unified overlay by default without creating a native track", () => {
    const { renderer, video, overlayMount } = setupRenderer();
    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true)).toBe(true);
    expect(overlayMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll("track").length).toBe(0);
    expect(renderer.getRenderState().lastTranslatedTrack.mode).toBe("overlay");
  });

  it("removes stale translated tracks before mounting the overlay", () => {
    const { renderer, video } = setupRenderer();
    const stale = document.createElement("track");
    stale.setAttribute("data-echo360-translated", "1");
    video.appendChild(stale);
    renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true);
    expect(video.querySelector('track[data-echo360-translated="1"]')).toBeNull();
  });

  it("falls back to the unified overlay when Echo360 native CC mounting refuses", () => {
    const { renderer, domMount, overlayMount, video } = setupRenderer({ domMountResult: false });
    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false)).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(overlayMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(0);
  });

  it("passes an explicit native-capability fallback callback to the Beta renderer", () => {
    const { renderer, getLastMountOpts } = setupRenderer();
    renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    expect(typeof getLastMountOpts().onNoCaptionCapability).toBe("function");
  });

  it("falls back to the overlay when the Beta renderer loses native capability later", () => {
    const { renderer, getLastMountOpts, overlayMount } = setupRenderer();
    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false)).toBe(true);
    getLastMountOpts().onNoCaptionCapability();
    expect(overlayMount).toHaveBeenCalledOnce();
    expect(renderer.getRenderState().lastTranslatedTrack.mode).toBe("overlay");
  });

  it("updates the same overlay path during incremental preview refreshes", () => {
    const { renderer, overlayMount } = setupRenderer();
    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true)).toBe(true);
    expect(renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true, { incremental: true })).toBe(true);
    expect(overlayMount).toHaveBeenCalledTimes(2);
  });

  it("delegates visibility and size to the active overlay", () => {
    const { renderer, ns } = setupRenderer();
    renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, false, "medium", false, null, true);
    renderer.applySubtitleVisibility(false);
    renderer.applySubtitleSize("large");
    expect(ns.subtitleOverlay.setVisible).toHaveBeenCalledWith(false);
    expect(ns.subtitleOverlay.applySize).toHaveBeenCalledWith("large");
  });

  it("does not change original TextTrack state when no translated renderer is mounted", () => {
    const { renderer, video } = setupRenderer();
    const original = { label: "English", mode: "disabled" };
    Object.defineProperty(video, "textTracks", { value: [original], configurable: true });
    renderer.applySubtitleVisibility(false);
    expect(original.mode).toBe("disabled");
  });
});
