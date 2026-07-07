import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs, makeStorageMock } from "../helpers/load-module.js";

const ORIG_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

`;

const TRANS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

`;

function makeVideo() {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
  Object.defineProperty(video, "duration", { value: 2, configurable: true });
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "textTracks", { value: [], configurable: true });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    bottom: 360,
    right: 640,
  });
  return video;
}

function setupControllerWithRenderer() {
  Object.defineProperty(window, "location", {
    value: { hostname: "echo360.org", pathname: "/lesson/test-id", href: "https://echo360.org/lesson/test-id" },
    configurable: true,
    writable: true,
  });
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

  const video = makeVideo();
  document.body.appendChild(video);
  const localMock = makeStorageMock({});
  const prefs = {
    enabled: true,
    size: "medium",
    bilingual: true,
    reverseOrder: false,
    useNativeSubtitles: false,
  };
  const domMount = vi.fn(() => false);

  window.Echo360Translator = makeFullNs({
    browserApi: {
      storage: { local: localMock },
      runtime: { sendMessage: vi.fn() },
    },
    storage: {
      getPrefs: vi.fn(async () => prefs),
      getConfig: vi.fn(async () => ({ target: "ZH" })),
    },
    ui: {
      ensurePanel: vi.fn(),
      setStatusText: vi.fn(),
      updateActionButtons: vi.fn(),
    },
    video: {
      installPageProbe: vi.fn(),
      waitForVideo: vi.fn(async () => video),
      getAllVideos: () => [video],
      getPrimaryVideo: () => video,
      querySelectorAllDeep: (selector) => Array.from(document.querySelectorAll(selector)),
      getVideoHintMediaIds: () => new Set(),
    },
    sourceFinder: {
      buildSourceMeta: () => ({ sourceId: "", mediaId: "", mapSource: "", stats: { maxEnd: 2 } }),
      pickBestMountVideoByVtt: () => video,
    },
    bilingualDomRenderer: {
      mount: domMount,
      unmount: vi.fn(),
      isMounted: () => false,
      ensureMounted: vi.fn(),
      setVisible: vi.fn(),
      applySize: vi.fn(),
    },
  });
  evalModule("vtt.js");
  evalModule("subtitle_strategy.js");
  evalModule("renderer.js");
  evalModule("controller.js");
  return { ns: window.Echo360Translator, video, domMount };
}

describe("controller track sync in Echo360 native CC mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to a browser track when native CC DOM mounting fails, and periodic sync does not re-attempt native CC mounting afterwards", async () => {
    const { ns, video, domMount } = setupControllerWithRenderer();

    const mounted = ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    expect(mounted).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);

    await ns.controller.init();
    await vi.advanceTimersByTimeAsync(2400);

    // A browser track is already showing (the automatic fallback), so
    // periodic sync should not keep re-attempting the failed native CC mount.
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });
});
