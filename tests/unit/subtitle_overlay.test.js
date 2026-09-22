import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const vtt = (text, start = "00:00:00.000", end = "00:00:02.000") => `WEBVTT\n\n${start} --> ${end}\n${text}\n`;
let ns, video, player, originalTrack;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function setProperty(object, name, value) {
  Object.defineProperty(object, name, { value, configurable: true, writable: true });
}
function text() { return document.querySelector("#echo360-subtitle-overlay")?.shadowRoot.querySelector(".caption").textContent; }
function mount(extra = {}) {
  return ns.subtitleOverlay.mount({ video, translatedVtt: vtt("字幕将显示为这样。"), originalVtt: vtt("Subtitles appear like this."), ...extra });
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="player"><video></video></div>';
  document.head.innerHTML = "";
  player = document.getElementById("player");
  video = player.querySelector("video");
  video.getBoundingClientRect = () => rect(20, 40, 960, 540);
  player.getBoundingClientRect = () => rect(20, 40, 960, 540);
  setProperty(video, "currentTime", 1);
  setProperty(video, "paused", true);
  setProperty(video, "videoWidth", 1920);
  setProperty(video, "videoHeight", 1080);
  originalTrack = { mode: "showing", label: "English" };
  setProperty(video, "textTracks", [originalTrack]);
  setProperty(document, "fullscreenElement", null);
  setProperty(document, "pictureInPictureElement", null);
  setProperty(URL, "createObjectURL", vi.fn(() => "blob:test"));
  setProperty(URL, "revokeObjectURL", vi.fn());
  ns = window.Echo360Translator = makeFullNs({
    video: {
      getAllVideos: () => [video],
      querySelectorAllDeep: (selector) => Array.from(document.querySelectorAll(selector)),
      getVideoHintMediaIds: () => new Set(),
    },
    sourceFinder: {
      buildSourceMeta: () => ({ stats: { maxEnd: 2 } }),
      pickBestMountVideoByVtt: () => video,
    },
    bilingualDomRenderer: { unmount: vi.fn(), isMounted: () => false, applySize: vi.fn() },
  });
  for (const file of ["vtt.js", "subtitle_timeline.js", "subtitle_layout.js", "subtitle_overlay.js", "renderer.js"]) evalModule(file);
});

afterEach(() => {
  ns.subtitleOverlay.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subtitle timeline", () => {
  it("finds overlaps, excludes end boundaries and supports backward seeks", () => {
    const cues = ns.subtitleTimeline.parse(vtt("long", "00:00:00.000", "00:00:10.000") + "\n00:02.000 --> 00:03.000\nshort\n");
    expect(ns.subtitleTimeline.active(cues, 2.5)).toBe("long\nshort");
    expect(ns.subtitleTimeline.active(cues, 3)).toBe("long");
    expect(ns.subtitleTimeline.active(cues, 10)).toBe("");
    expect(ns.subtitleTimeline.active(cues, 1)).toBe("long");
  });

  it("never renders cue markup as executable HTML", () => {
    mount({ translatedVtt: vtt('<v Speaker><img src=x onerror=alert(1)>Hello &amp; &lt;code&gt;</v>') });
    expect(text()).toBe("Hello & <code>");
    expect(document.querySelector("#echo360-subtitle-overlay").shadowRoot.querySelector("img")).toBeNull();
  });
});

describe("overlay rendering and lifecycle", () => {
  it("uses the overlay by default with no browser cue track", () => {
    expect(ns.renderer.renderTranslatedTrack(vtt("中文"), vtt("English"), false)).toBe(true);
    expect(text()).toBe("中文");
    expect(video.querySelector("track")).toBeNull();
    expect(ns.renderer.getRenderState().lastTranslatedTrack.mode).toBe("overlay");
  });

  it("updates partial translations on the same host, including while paused", () => {
    mount();
    const host = document.getElementById("echo360-subtitle-overlay");
    mount({ translatedVtt: vtt("翻译完成") });
    expect(document.getElementById("echo360-subtitle-overlay")).toBe(host);
    expect(text()).toBe("翻译完成");
  });

  it("keeps bilingual order and changes it without creating two tracks", () => {
    mount({ bilingual: true });
    expect(text()).toBe("字幕将显示为这样。Subtitles appear like this.");
    mount({ bilingual: true, reverseOrder: true });
    expect(text()).toBe("Subtitles appear like this.字幕将显示为这样。");
    expect(video.querySelector("track")).toBeNull();
  });

  it("clears subtitles in cue gaps and renders immediately after seeking", () => {
    mount();
    video.currentTime = 3;
    video.dispatchEvent(new Event("seeked"));
    expect(text()).toBe("");
    video.currentTime = 0.5;
    video.dispatchEvent(new Event("seeking"));
    expect(text()).toContain("字幕");
  });

  it("leaves the user's original track choice untouched", () => {
    mount();
    expect(originalTrack.mode).toBe("showing");
    ns.subtitleOverlay.setVisible(false);
    expect(originalTrack.mode).toBe("showing");
    expect(document.getElementById("echo360-subtitle-overlay").style.display).toBe("none");
    ns.subtitleOverlay.setVisible(true);
    expect(originalTrack.mode).toBe("showing");
    ns.subtitleOverlay.unmount();
    expect(originalTrack.mode).toBe("showing");
    expect(document.getElementById("echo360-subtitle-overlay")).toBeNull();
  });

  it("keeps its layer visible while leaving the Echo360 CC button under user control", () => {
    originalTrack.mode = "disabled";
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-label", "Toggle Captions");
    toggle.setAttribute("aria-pressed", "true");
    player.appendChild(toggle);
    ns.sourceFinder.findCaptionToggleButton = () => toggle;
    mount();
    const host = document.getElementById("echo360-subtitle-overlay");
    expect(host.style.display).toBe("block");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.setAttribute("aria-pressed", "false");
    toggle.dispatchEvent(new Event("click"));
    expect(host.style.display).toBe("block");
    ns.subtitleOverlay.unmount();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("moves inside a fullscreen container and returns on exit", () => {
    mount();
    setProperty(document, "fullscreenElement", player);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(player.querySelector("#echo360-subtitle-overlay")).not.toBeNull();
    expect(video.querySelector("track")).toBeNull();
    setProperty(document, "fullscreenElement", null);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(document.getElementById("echo360-subtitle-overlay").parentElement).toBe(document.documentElement);
  });

  it.each(["fullscreenElement", "pictureInPictureElement"])("uses a track in %s video-only mode and removes it on exit", (property) => {
    originalTrack.mode = "disabled";
    mount();
    setProperty(document, property, video);
    ns.subtitleOverlay.refresh();
    expect(video.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
    expect(document.getElementById("echo360-subtitle-overlay").style.display).toBe("none");
    setProperty(document, property, null);
    ns.subtitleOverlay.refresh();
    expect(video.querySelector("track")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(document.getElementById("echo360-subtitle-overlay").style.display).toBe("block");
  });

  it("retargets when the matched video changes and restores the previous tracks", () => {
    ns.renderer.renderTranslatedTrack(vtt("中文"), vtt("English"), false);
    const nextVideo = document.createElement("video");
    nextVideo.getBoundingClientRect = () => rect(20, 40, 960, 540);
    player.appendChild(nextVideo);
    ns.sourceFinder.pickBestMountVideoByVtt = () => nextVideo;
    ns.renderer.ensureTrackOnPrimaryVideo();
    expect(ns.subtitleOverlay.getVideo()).toBe(nextVideo);
    expect(originalTrack.mode).toBe("showing");
  });

  it("cleanup prevents the periodic renderer sync from resurrecting cancelled subtitles", () => {
    ns.renderer.renderTranslatedTrack(vtt("中文"), vtt("English"), false);
    ns.renderer.cleanupTranslatedTracks();
    ns.renderer.ensureTrackOnPrimaryVideo();
    expect(document.getElementById("echo360-subtitle-overlay")).toBeNull();
    expect(ns.renderer.getRenderState().lastRenderedVtt).toBe("");
  });
});

describe("subtitle safe area", () => {
  it("clips to the viewport and to scroll containers", () => {
    video.getBoundingClientRect = () => rect(20, 500, 960, 540);
    player.style.overflow = "hidden";
    player.getBoundingClientRect = () => rect(20, 500, 960, 180);
    expect(ns.subtitleLayout.visibleRect(video).bottom).toBe(680);
    mount();
    expect(document.getElementById("echo360-subtitle-overlay").style.height).toBe("180px");
  });

  it("positions relative to the contained picture rather than the letterbox", () => {
    video.style.objectFit = "contain";
    video.getBoundingClientRect = () => rect(0, 0, 960, 720);
    expect(ns.subtitleLayout.visibleRect(video)).toMatchObject({ top: 90, height: 540, bottom: 630 });
  });

  it("does not clip fullscreen video to ancestors outside the top layer", () => {
    document.body.style.overflow = "hidden";
    document.body.getBoundingClientRect = () => rect(0, 0, 100, 100);
    setProperty(document, "fullscreenElement", player);
    expect(ns.subtitleLayout.visibleRect(video).bottom).toBe(580);
    document.body.style.overflow = "";
  });

  it("keeps embedded captions low and does not move them with player controls", () => {
    const area = rect(0, 0, 1280, 720);
    const embedded = ns.subtitleLayout.metrics(area, "medium", false);
    expect(embedded.bottom).toBeCloseTo(8.64);
    expect(ns.subtitleLayout.metrics(area, "large", false).fontSize).toBeGreaterThan(embedded.fontSize);
  });

  it("uses the native-style inset only for fullscreen containers", () => {
    const area = rect(0, 0, 1920, 1080);
    expect(ns.subtitleLayout.metrics(area, "medium", false).bottom).toBeCloseTo(12.96);
    expect(ns.subtitleLayout.metrics(area, "medium", true).bottom).toBeCloseTo(37.8);
  });
});
