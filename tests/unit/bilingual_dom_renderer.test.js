/**
 * Unit tests for extension/bilingual_dom_renderer.js
 *
 * DOM operations are exercised with jsdom.  APIs jsdom does not implement are
 * replaced with targeted test doubles:
 *
 *   getBoundingClientRect – always returns 0 in jsdom; stubbed per-element
 *                           with vi.spyOn so the visibility and layout checks
 *                           see realistic rectangles.
 *
 *   requestVideoFrameCallback / cancelVideoFrameCallback – non-standard API
 *                           added directly to the video double.
 *
 *   performance.now        – controlled via vi.spyOn so tests can move the
 *                           clock forward to trigger / skip the 750 ms native-
 *                           caption grace period without sleeping.
 *
 * Coverage:
 *   P1  mount returns false – no #player element
 *   P2  mount returns false – empty VTT (no cues)
 *   P3  mount returns true; isMounted() reflects state
 *   P4  unmount clears mounted state
 *   P5  getDebugState().cueCount matches VTT cue count
 *   P6  lastCueIndex = -1 when currentTime falls between cues
 *   P7  lastCueIndex tracks currentTime across timeupdate events
 *   P8  DOM injection – sets data attrs on a native caption double
 *   P9  DOM injection – cleared on unmount
 *   P10 native CC injector does not expose fallback debug state
 *   P11 native CC injector stays quiet when injection fails
 *   P12 setVisible(false) prevents native injection
 */

import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

// ── Fixture VTT strings ───────────────────────────────────────────────────────
// Three cues; gaps between them so we can test "no active cue" at currentTime.
//   Cue 0 : 00:00:00.000 – 00:00:02.000  (0 ≤ t ≤ 2)
//   Cue 1 : 00:00:02.500 – 00:00:04.500  (2.5 ≤ t ≤ 4.5)
//   Cue 2 : 00:00:05.000 – 00:00:07.000  (5 ≤ t ≤ 7)
const ORIG_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.500 --> 00:00:04.500
Second line

00:00:05.000 --> 00:00:07.000
Third line

`;

const TRANS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

00:00:02.500 --> 00:00:04.500
第二行

00:00:05.000 --> 00:00:07.000
第三行

`;

// ── Test double factories ─────────────────────────────────────────────────────

/** Stub getBoundingClientRect on an element to return a real-looking rectangle. */
function stubRect(el, overrides = {}) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    width: 640, height: 360,
    top: 100, left: 0, bottom: 460, right: 640,
    ...overrides,
  });
}

/**
 * Minimal video double: real HTMLVideoElement with injected
 * requestVideoFrameCallback, cancelVideoFrameCallback, and a mutable
 * currentTime backed by a plain variable.
 */
function makeVideo(currentTime = 0) {
  const el = document.createElement("video");
  let _t = currentTime;
  Object.defineProperty(el, "currentTime", {
    get: () => _t,
    set: (v) => { _t = v; },
    configurable: true,
  });
  // duration / paused / ended are read-only getters on HTMLMediaElement in jsdom
  el.requestVideoFrameCallback = vi.fn(() => 1);
  el.cancelVideoFrameCallback = vi.fn();
  stubRect(el);
  return el;
}

/**
 * Append a #player div containing the given video to document.body, stub its
 * getBoundingClientRect, and return it.
 */
function setupPlayer(video) {
  const player = document.createElement("div");
  player.id = "player";
  stubRect(player);
  player.appendChild(video);
  document.body.appendChild(player);
  return player;
}

// ── Module loading ────────────────────────────────────────────────────────────
let renderer;

beforeAll(() => {
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("bilingual_dom_renderer.js");
  renderer = window.Echo360Translator.bilingualDomRenderer;
});

// ── Per-test setup ────────────────────────────────────────────────────────────
let mockNow;

beforeEach(() => {
  // Reset performance clock; individual tests advance mockNow as needed.
  mockNow = 0;
  vi.spyOn(performance, "now").mockImplementation(() => mockNow);

  // Ensure clean renderer and DOM state before every test.
  renderer.unmount();
  document.querySelectorAll("#player").forEach((el) => el.remove());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── P1 / P2 ───────────────────────────────────────────────────────────────────
describe("mount – early returns", () => {
  it("P1: returns false when no #player element exists", () => {
    const video = makeVideo();
    // video is NOT appended to any #player in the DOM
    expect(renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" })).toBe(false);
    expect(renderer.isMounted()).toBe(false);
  });

  it("P2: returns false when VTT produces no cues", () => {
    const video = makeVideo();
    setupPlayer(video);
    expect(renderer.mount({ video, originalVtt: "WEBVTT\n\n", translatedVtt: "WEBVTT\n\n", size: "medium" })).toBe(false);
    expect(renderer.isMounted()).toBe(false);
  });
});

// ── P3 / P4 ───────────────────────────────────────────────────────────────────
describe("mount / unmount lifecycle", () => {
  it("P3: returns true with valid video + player + VTT; isMounted() true", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    expect(renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" })).toBe(true);
    expect(renderer.isMounted()).toBe(true);
  });

  it("P4: unmount clears mounted state", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    expect(renderer.isMounted()).toBe(true);

    renderer.unmount();
    expect(renderer.isMounted()).toBe(false);
  });
});

// ── P5 / P6 / P7 ─────────────────────────────────────────────────────────────
describe("cue tracking via getDebugState()", () => {
  it("P5: cueCount equals the number of VTT cues", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    expect(renderer.getDebugState().cueCount).toBe(3);
  });

  it("P6: lastCueIndex is -1 when currentTime falls in a gap between cues", () => {
    const video = makeVideo(2.2); // gap between cue 0 (ends 2.0) and cue 1 (starts 2.5)
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    // renderCurrentCue is called inside mount; state should reflect currentTime 2.2
    expect(renderer.getDebugState().lastCueIndex).toBe(-1);
  });

  it("P7: lastCueIndex updates to the correct cue on timeupdate", () => {
    const video = makeVideo(2.2); // starts in gap → lastCueIndex = -1
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    expect(renderer.getDebugState().lastCueIndex).toBe(-1);

    video.currentTime = 3.0; // now in cue 1 (2.5–4.5)
    video.dispatchEvent(new Event("timeupdate"));
    expect(renderer.getDebugState().lastCueIndex).toBe(1);

    video.currentTime = 6.0; // cue 2 (5–7)
    video.dispatchEvent(new Event("timeupdate"));
    expect(renderer.getDebugState().lastCueIndex).toBe(2);
  });
});

// ── P8 / P9 ───────────────────────────────────────────────────────────────────
describe("DOM injection via native caption double", () => {
  /**
   * Adds a <span> to the player whose text matches the first cue's source.
   * Its getBoundingClientRect is stubbed to look visible inside the player,
   * which is what findNativeCaptionElement requires to select the element.
   */
  function addCaptionSpan(player, text) {
    const span = document.createElement("span");
    span.textContent = text;
    stubRect(span, { width: 200, height: 30, top: 400, left: 220, bottom: 430, right: 420 });
    player.appendChild(span);
    return span;
  }

  it("P8: sets data-echo360-translated-line and data-echo360-translation on the native element", () => {
    const video = makeVideo(1.0); // in cue 0 ("Hello world")
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    // mount called renderCurrentCue at now=0 (grace period active); injection not yet attempted successfully

    const span = addCaptionSpan(player, "Hello world");

    // Advance past grace period (750 ms) and past nextNativeSearchAt (200 ms)
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().nativeInjectionHits).toBe(1);
  });

  it("P9: injection attributes are cleared after unmount", () => {
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.hasAttribute("data-echo360-translated-line")).toBe(true);

    renderer.unmount();
    expect(span.hasAttribute("data-echo360-translated-line")).toBe(false);
    expect(span.hasAttribute("data-echo360-translation")).toBe(false);
  });

  it("P13: retries on the very next trigger with no fixed polling delay", () => {
    // Regression guard for the removed 200ms NATIVE_SEARCH_INTERVAL_MS throttle:
    // once a cue is unmatched, every subsequent trigger should retry immediately
    // rather than waiting out a fixed interval.
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    // First attempt (inside mount, at now=0) failed: no matching span yet.

    const span = addCaptionSpan(player, "Hello world");

    // Advance only 10ms (well under the old 200ms interval) and well within
    // the 750ms grace period.
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().nativeInjectionHits).toBe(1);
  });

  it("P15: never clones DOM nodes while searching (avoids re-triggering the player's <video> src)", () => {
    // Regression guard: findNativeCaptionElement used to call
    // element.cloneNode(true) on every scanned element to strip out
    // previously-injected lines before reading textContent. Since #player
    // contains the <video> itself, cloning any of its ancestors deep-clones
    // the <video> too, and Chrome re-issues a fetch for its (often blob:)
    // src on the detached clone - failing loudly in the console for no
    // functional benefit. The text-collection walk must never call
    // cloneNode.
    const video = makeVideo(1.0);
    const player = setupPlayer(video); // player contains `video` as a child
    const cloneSpy = vi.spyOn(Element.prototype, "cloneNode");
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));

    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("P16: stops full-tree scanning once the grace period expires with no match (e.g. Echo360 CC is off)", () => {
    // Without this, a cue that never has a matching native caption (because
    // the user turned Echo360's own CC off) would trigger a full player
    // subtree scan on every single trigger (timeupdate/rVFC) forever.
    const video = makeVideo(1.0);
    const player = setupPlayer(video); // no matching caption span ever added
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    mockNow = 800; // past the 750ms grace period, still no match found
    video.dispatchEvent(new Event("timeupdate"));
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);

    // clearInjectedLines() still does a cheap, targeted querySelectorAll for
    // the injected-line selector each time; what must NOT happen anymore is
    // the expensive full "*" subtree scan that findNativeCaptionElement does.
    const scanSpy = vi.spyOn(player, "querySelectorAll");
    mockNow = 850;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 900;
    video.dispatchEvent(new Event("timeupdate"));

    expect(scanSpy).not.toHaveBeenCalledWith("*");
  });

  it("P17: reuses the same anchor across cues without a full-tree scan (sticky anchor fast path)", () => {
    // Echo360's own caption box typically stays the same DOM node across
    // cues and just swaps its text. The fast path should detect this by
    // re-checking the previous anchor directly instead of re-scanning the
    // whole player subtree.
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");

    // Echo360 reuses the same node for the next cue: it just swaps the text.
    span.textContent = "Second line";
    video.currentTime = 3.0; // cue 1 (2.5s - 4.5s)
    mockNow = 20;

    const scanSpy = vi.spyOn(player, "querySelectorAll");
    video.dispatchEvent(new Event("timeupdate"));

    expect(span.getAttribute("data-echo360-translation")).toBe("第二行");
    expect(scanSpy).not.toHaveBeenCalledWith("*");
  });

  it("P18: only pays the layout/style cost for text-matching candidates during a full scan", () => {
    // Regression guard for reordering the cheap text check before the
    // layout-forcing isVisibleInPlayer() check: unrelated elements should
    // never reach getComputedStyle at all.
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    for (let i = 0; i < 5; i += 1) {
      const decoy = document.createElement("div");
      decoy.textContent = `unrelated decoy text ${i}`;
      stubRect(decoy, { width: 200, height: 30, top: 400, left: 220, bottom: 430, right: 420 });
      player.appendChild(decoy);
    }
    const span = addCaptionSpan(player, "Hello world");

    const styleSpy = vi.spyOn(window, "getComputedStyle");
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    expect(styleSpy).toHaveBeenCalledTimes(1);
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
  });

  it("P14: MutationObserver injects synchronously without a video event or rAF flush", async () => {
    // No timeupdate/seeked/play/rVFC trigger at all: only the MutationObserver
    // reacting to Echo360 creating its caption node should cause the
    // injection. Awaiting a single microtask tick (no fake-timer/rAF flush)
    // is enough, proving the reaction happens in the same frame as the
    // mutation rather than one frame later.
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    await Promise.resolve();

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
  });
});

// ── P10 / P11 ─────────────────────────────────────────────────────────────────
describe("native CC disabled / injection unavailable", () => {
  it("P10: does not expose fallback overlay debug state", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    // mockNow = 0 → nativeCaptionWaitUntil = 750 after first render
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    mockNow = 400; // still inside grace period
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState()).not.toHaveProperty("fallbackVisible");
    expect(renderer.getDebugState()).not.toHaveProperty("fallbackHits");
  });

  it("P11: stays quiet after grace period when injection fails", () => {
    // No native caption element in player means Echo360's own CC is not visible.
    // The beta renderer must not draw a separate fallback overlay in that state.
    const video = makeVideo(1.0);
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    // First render (now=0): grace period active, box stays hidden.
    mockNow = 0;
    video.dispatchEvent(new Event("timeupdate"));
    expect(renderer.getDebugState().injectedLineCount).toBe(0);

    // Advance past grace period; injection still fails (no native element).
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().injectedLineCount).toBe(0);
    expect(document.querySelector("[data-echo360-translated-line='1']")).toBeNull();
    expect(document.getElementById("echo360-bilingual-dom-overlay")).toBeNull();
    expect(renderer.getDebugState()).not.toHaveProperty("fallbackHits");
  });
});

// ── P12 ───────────────────────────────────────────────────────────────────────
describe("setVisible()", () => {
  it("P12: setVisible(false) prevents native injection even when a cue is active", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    // Advance past grace; native injection should remain disabled.
    mockNow = 800;
    renderer.setVisible(false);

    // Dispatch a timeupdate to re-run renderCurrentCue.
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().injectedLineCount).toBe(0);
  });
});
