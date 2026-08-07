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
 *   P17 updateTranslatedVtt refreshes cue translations without remounting
 *   P19 mount refuses immediately with no native caption capability
 *   P20 onNoCaptionCapability fires once capability is confirmed absent
 *   P21 onNoCaptionCapability stays silent when CC capability exists but is off
 *   P22 onNoCaptionCapability fires at most once per mount
 *   P23 renderCurrentCue does not throw if onNoCaptionCapability unmounts synchronously
 *   P24 requestVideoFrameCallback-driven re-renders are throttled (high refresh-rate storms)
 *   P25 timeupdate-driven re-renders are never throttled
 *   P26 a host-page main-thread stall extends the grace period instead of exhausting it early
 *   P27 ordinary call gaps are never mistaken for a stall
 *   P28 MutationObserver retries on any mutation while unmatched, regardless of text match
 *   P29 once matched, unrelated mutations no longer trigger a full-tree scan
 *   P30 high-speed lag: caption DOM showing an earlier cue than currentTime gets that cue's
 *       translation injected in the same microtask as the DOM write
 *   P31 anchor text lagging behind the time-computed cue keeps its (still correct) translation
 *       instead of being blanked, then follows the text when Echo360 catches up
 *   P32 text outside the resolution window is never force-matched and exhausts normally
 *   P33 a caption mutation arriving after grace exhaustion still wakes up injection
 *   P34 a short next cue is injected from its mutation even before timeupdate bookkeeping catches up
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
  // Captures the latest callback (rather than invoking it) so tests can
  // manually fire successive "video frames" to simulate a high-refresh-rate
  // display without waiting on a real render loop.
  el.requestVideoFrameCallback = vi.fn((cb) => {
    el._lastFrameCallback = cb;
    return 1;
  });
  el.cancelVideoFrameCallback = vi.fn();
  stubRect(el);
  return el;
}

/** Invokes the most recently scheduled requestVideoFrameCallback, if any. */
function fireVideoFrame(video) {
  const cb = video._lastFrameCallback;
  video._lastFrameCallback = null;
  cb?.();
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
  window.Echo360Translator = makeFullNs({
    sourceFinder: {
      // Defaults to "this video has a native caption track" so the existing
      // DOM-injection tests below (which never touch this mock) behave as
      // before. Capability-specific tests override the return value.
      hasNativeCaptionCapability: vi.fn(() => true),
    },
  });
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
  window.Echo360Translator.sourceFinder.hasNativeCaptionCapability.mockReset().mockReturnValue(true);

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

  it("P17: updateTranslatedVtt refreshes pending translation text without remounting", () => {
    const pendingVtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
正在翻译中...

00:00:02.500 --> 00:00:04.500
正在翻译中...

00:00:05.000 --> 00:00:07.000
正在翻译中...

`;
    const partialTransVtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

00:00:02.500 --> 00:00:04.500
正在翻译中...

00:00:05.000 --> 00:00:07.000
正在翻译中...

`;
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: pendingVtt, size: "medium" });
    const span = addCaptionSpan(player, "Hello world");
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("正在翻译中...");

    expect(renderer.updateTranslatedVtt({ originalVtt: ORIG_VTT, translatedVtt: partialTransVtt })).toBe(true);
    expect(renderer.isMounted()).toBe(true);
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
  });

  it("P18: updateTranslatedVtt returns false when renderer is not mounted", () => {
    expect(renderer.updateTranslatedVtt({ originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT })).toBe(false);
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

  it("P24: throttles requestVideoFrameCallback-driven re-renders so a high-refresh-rate storm doesn't pay for a full scan on every frame", () => {
    // Regression guard for a real-world bug report: on a 144Hz display at 2x
    // playback speed, requestVideoFrameCallback can fire far more often than
    // a human can perceive a subtitle updating. Without a throttle, every
    // one of those callbacks would pay for a full O(N) player-subtree scan
    // while a cue is still unmatched (e.g. right after seeking), and the
    // resulting main-thread backlog was reported to make injection fall
    // further and further behind across several subsequent cues.
    const video = makeVideo(1.0);
    const player = setupPlayer(video); // no matching caption span yet
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const scanSpy = vi.spyOn(player, "querySelectorAll");
    scanSpy.mockClear();

    // Simulate ~7ms-apart video frames (roughly a 144Hz cadence) for 100ms -
    // about 14 callbacks - all while the cue remains unmatched and well
    // within the 750ms grace period.
    for (let i = 0; i < 14; i += 1) {
      mockNow += 7;
      fireVideoFrame(video);
    }

    const fullScanCalls = scanSpy.mock.calls.filter((args) => args[0] === "*").length;
    // A 33ms throttle floor over 100ms allows at most ~4 real scan attempts,
    // versus the 14 an unthrottled loop would have made.
    expect(fullScanCalls).toBeGreaterThan(0);
    expect(fullScanCalls).toBeLessThanOrEqual(4);
  });

  it("P25: does not throttle timeupdate-driven re-renders (only the requestVideoFrameCallback loop is capped)", () => {
    const video = makeVideo(1.0);
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    // First attempt (inside mount, at now=0) failed: no matching span yet.

    const span = addCaptionSpan(player, "Hello world");

    // Only 5ms later - well under the rVFC throttle window - but triggered
    // via timeupdate, which must keep retrying immediately regardless.
    mockNow = 5;
    video.dispatchEvent(new Event("timeupdate"));

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
  });

  it("P26: extends a cue's grace period by however long the host page's main thread stalled, instead of exhausting it early", () => {
    // Regression guard for a real-world report: Echo360's own player can
    // freeze the shared main thread for several seconds around a seek (its
    // own WebGL/audio reinit, style recalculation, etc.) - nothing this
    // extension does can run *during* that freeze either. Without this
    // adjustment, a cue could get marked "exhausted" (and its translation
    // blanked) purely because the 750ms grace period elapsed in real
    // wall-clock time while the thread was unavailable to us - even though
    // we never actually got a chance to search for a match.
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video); // no matching caption span yet

    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });
    // mount's own render call happened at mockNow=0.

    // Simulate a 3-second host-page freeze: the next trigger only fires
    // 3000ms later in wall-clock time, far more than the 750ms grace period,
    // but we never got a single chance to search during that gap.
    mockNow = 3000;
    video.dispatchEvent(new Event("timeupdate"));

    // The grace period must have been pushed back by the stall, so the cue
    // is NOT exhausted yet even though 3000ms of wall-clock time has passed.
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(false);
    expect(renderer.getDebugState().stallCount).toBe(1);
    expect(renderer.getDebugState().lastStallGapMs).toBe(3000);

    // A matching span now appears (as if Echo360 finally rendered it once
    // the freeze cleared) and the very next trigger should still find it.
    const span = addCaptionSpan(player, "Hello world");
    mockNow = 3010;
    video.dispatchEvent(new Event("timeupdate"));

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
  });

  it("P27: does not treat ordinary call gaps as a stall", () => {
    // The stall-detection threshold must sit comfortably above normal
    // trigger cadence (rVFC throttled to ~33ms, timeupdate at least every
    // ~250ms) so everyday gaps between triggers are never mistaken for a
    // host-page freeze.
    const video = makeVideo(1.0);
    setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    mockNow = 250;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 500;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 800; // past the 750ms grace period; no stall ever occurred
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().stallCount).toBe(0);
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);
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

  it("P28: MutationObserver retries on ANY player mutation while unmatched, even if its text doesn't match the current cue", async () => {
    // Regression guard for a real-world report: the lag from a seek/stall
    // was found to carry over into several subsequent cues. Root cause -
    // right after a stall, Echo360 needs a moment to catch its own caption
    // box up to the actual (fast-forwarded) position, and in the meantime it
    // may render cues *behind* whatever cue we're currently expecting. The
    // old text-matching pre-filter treated those as irrelevant and only
    // reacted once Echo360 finally caught all the way up - stretching the
    // lag across every cue in between. Reacting to any mutation while
    // unmatched (and letting the real scan/match logic decide relevance)
    // fixes this.
    const video = makeVideo(1.0); // cue 0 ("Hello world"), unmatched - no span yet
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const scanSpy = vi.spyOn(player, "querySelectorAll");
    scanSpy.mockClear();

    // Echo360 mutates its own caption box with text that does NOT match cue
    // 0 at all (e.g. it's still rendering stale/unrelated content while
    // catching up from a stall).
    const decoy = document.createElement("div");
    decoy.textContent = "completely unrelated caption text";
    stubRect(decoy, { width: 200, height: 30, top: 400, left: 220, bottom: 430, right: 420 });
    player.appendChild(decoy);
    await Promise.resolve();

    // A fresh full-tree scan attempt must have happened in reaction to this
    // mutation, even though its text doesn't match the cue we're waiting on.
    const fullScanCalls = scanSpy.mock.calls.filter((args) => args[0] === "*").length;
    expect(fullScanCalls).toBeGreaterThan(0);
  });

  it("P29: once a cue is matched, unrelated player mutations no longer trigger a full-tree scan", async () => {
    // The relaxed P28 behavior must not regress the steady-state
    // optimization: after a match is found, unrelated DOM churn elsewhere in
    // the player (progress bar ticks, etc.) should stay cheap.
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translated-line")).toBe("1"); // now matched

    const scanSpy = vi.spyOn(player, "querySelectorAll");
    scanSpy.mockClear();

    const decoy = document.createElement("div");
    decoy.textContent = "unrelated progress bar tick";
    stubRect(decoy, { width: 200, height: 30, top: 400, left: 220, bottom: 430, right: 420 });
    player.appendChild(decoy);
    await Promise.resolve();

    const fullScanCalls = scanSpy.mock.calls.filter((args) => args[0] === "*").length;
    expect(fullScanCalls).toBe(0);
  });

  it("P34: a short next cue is injected from its mutation before timeupdate bookkeeping catches up", async () => {
    const shortOrigVtt = ORIG_VTT.replace("Second line", "OK");
    const shortTransVtt = TRANS_VTT.replace("第二行", "好的");
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video);
    renderer.mount({
      video,
      originalVtt: shortOrigVtt,
      translatedVtt: shortTransVtt,
      size: "medium",
    });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().lastCueIndex).toBe(0);

    // Playback has entered cue 1, but no timeupdate/rVFC callback has run, so
    // the renderer's stored cue index is still 0. Echo360 writes the very
    // short caption first. Its MutationObserver record must be recognized by
    // reverse-looking up "OK", instead of being filtered against cue 0's
    // source and leaving no time for a later retry.
    video.currentTime = 3.0;
    span.textContent = "OK";
    await Promise.resolve();

    expect(span.getAttribute("data-echo360-translation")).toBe("好的");
    expect(renderer.getDebugState().lastCueIndex).toBe(1);
    expect(renderer.getDebugState().nativeInjectedCueIndex).toBe(1);
  });

  it("P30: caption DOM showing an earlier cue than currentTime gets that cue's translation in the same microtask", async () => {
    // The high-playback-speed lag scenario: video.currentTime has already
    // advanced into cue 1's window, but Echo360's main thread is behind and
    // only now writes cue 0's English into the caption box. The injection
    // must follow the *visible text* (cue 0), resolved via the window
    // search, and land in the same microtask as Echo360's DOM write - not
    // wait for Echo360 to catch all the way up to cue 1.
    const video = makeVideo(3.0); // cue 1 by time (2.5s - 4.5s)
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    // Echo360 belatedly renders cue 0's English. No timeupdate/rVFC trigger:
    // only the MutationObserver reacts.
    const span = addCaptionSpan(player, "Hello world");
    await Promise.resolve();

    expect(span.getAttribute("data-echo360-translated-line")).toBe("1");
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().nativeInjectedCueIndex).toBe(0);
  });

  it("P31: anchor text lagging behind the time-computed cue keeps its translation, then follows the catch-up", () => {
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");

    // currentTime moves into cue 1's window but Echo360's box still shows
    // cue 0's English. The (still visually correct) translation must stay.
    video.currentTime = 3.0; // cue 1 (2.5s - 4.5s)
    mockNow = 20;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().nativeInjectedCueIndex).toBe(0);

    // Even well past cue 1's grace deadline, a genuine text match means the
    // cue is never marked exhausted and the translation is never blanked.
    mockNow = 300;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 600;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 900;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(false);

    // Echo360 finally catches up: the translation follows the new text.
    span.textContent = "Second line";
    mockNow = 910;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("第二行");
    expect(renderer.getDebugState().nativeInjectedCueIndex).toBe(1);
  });

  it("P32: text outside the resolution window is never force-matched and exhausts normally", () => {
    const video = makeVideo(1.0); // cue 0
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    const span = addCaptionSpan(player, "Hello world");
    mockNow = 10;
    video.dispatchEvent(new Event("timeupdate"));
    expect(span.getAttribute("data-echo360-translation")).toBe("你好世界");

    // Echo360 replaces the caption text with something that belongs to no
    // nearby cue at all (e.g. a status message), while time moves to cue 1.
    span.textContent = "Completely unrelated status text";
    video.currentTime = 3.0; // cue 1
    mockNow = 20;
    video.dispatchEvent(new Event("timeupdate")); // cue change: grace runs until 770

    mockNow = 300;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 600;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 900; // past grace with no genuine match
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);
    expect(span.hasAttribute("data-echo360-translated-line")).toBe(false);
  });

  it("P33: a caption mutation arriving after grace exhaustion still wakes up injection", async () => {
    const video = makeVideo(3.0); // cue 1, no caption DOM yet
    const player = setupPlayer(video);
    renderer.mount({ video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium" });

    mockNow = 300;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 600;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 900; // grace (750ms from mount) lapsed, still no match
    video.dispatchEvent(new Event("timeupdate"));
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);

    // Echo360's caption box finally appears on the SAME cue - the mutation
    // must reopen the search instead of staying silent until the next cue.
    const span = addCaptionSpan(player, "Second line");
    await Promise.resolve();

    expect(span.getAttribute("data-echo360-translation")).toBe("第二行");
    expect(renderer.getDebugState().nativeSearchExhausted).toBe(false);
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
    // The native CC renderer must not draw a separate fallback overlay in that state.
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

// ── P19 - P22 ─────────────────────────────────────────────────────────────────
describe("native caption capability detection & fallback", () => {
  it("P19: mount returns false immediately when the video has no native caption capability at all", () => {
    // No <track>/TextTrack ever existed for this video (e.g. a lesson with
    // only a Transcript side panel) — there is nothing for the DOM scanner
    // to ever find, so mount() should refuse synchronously instead of
    // waiting out a per-cue grace period first.
    window.Echo360Translator.sourceFinder.hasNativeCaptionCapability.mockReturnValue(false);
    const video = makeVideo(1.0);
    setupPlayer(video);
    const onNoCaptionCapability = vi.fn();

    const mounted = renderer.mount({
      video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium", onNoCaptionCapability,
    });

    expect(mounted).toBe(false);
    expect(renderer.isMounted()).toBe(false);
    // mount() itself only signals refusal via its return value; it is the
    // caller's job to decide what "no capability" means (e.g. fall back).
    expect(onNoCaptionCapability).not.toHaveBeenCalled();
  });

  it("P20: fires onNoCaptionCapability once the grace period expires and capability is confirmed absent", () => {
    const video = makeVideo(1.0);
    setupPlayer(video); // no matching caption span ever added
    const onNoCaptionCapability = vi.fn();
    renderer.mount({
      video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium", onNoCaptionCapability,
    });

    // Capability looked present at mount time (default mock), but nothing
    // ever appears; the safety-net re-check at exhaustion time confirms
    // there really is no native caption capability after all.
    window.Echo360Translator.sourceFinder.hasNativeCaptionCapability.mockReturnValue(false);
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);
    expect(onNoCaptionCapability).toHaveBeenCalledOnce();
  });

  it("P21: does not fire onNoCaptionCapability when native CC capability exists but is simply turned off", () => {
    // Distinguishes "the user/Echo360 turned CC off" (stay silent, respect
    // the choice) from "this lesson never had CC" (fall back automatically).
    const video = makeVideo(1.0);
    setupPlayer(video); // no matching caption span; capability stays true throughout
    const onNoCaptionCapability = vi.fn();
    renderer.mount({
      video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium", onNoCaptionCapability,
    });

    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));

    expect(renderer.getDebugState().nativeSearchExhausted).toBe(true);
    expect(onNoCaptionCapability).not.toHaveBeenCalled();
  });

  it("P22: fires onNoCaptionCapability at most once even across repeated exhausted checks", () => {
    const video = makeVideo(1.0);
    setupPlayer(video);
    const onNoCaptionCapability = vi.fn();
    renderer.mount({
      video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium", onNoCaptionCapability,
    });

    window.Echo360Translator.sourceFinder.hasNativeCaptionCapability.mockReturnValue(false);
    mockNow = 800;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 850;
    video.dispatchEvent(new Event("timeupdate"));
    mockNow = 900;
    video.dispatchEvent(new Event("timeupdate"));

    expect(onNoCaptionCapability).toHaveBeenCalledOnce();
  });

  it("P23: does not throw when onNoCaptionCapability synchronously unmounts (real-world renderer.js behavior)", () => {
    // renderer.js's real onNoCaptionCapability callback re-renders as a
    // browser <track> synchronously, which calls this module's unmount()
    // before returning - `state` becomes null mid-way through the still
    // -running renderCurrentCue() call that triggered the callback.
    const video = makeVideo(1.0);
    setupPlayer(video);
    const onNoCaptionCapability = vi.fn(() => {
      renderer.unmount();
    });
    renderer.mount({
      video, originalVtt: ORIG_VTT, translatedVtt: TRANS_VTT, size: "medium", onNoCaptionCapability,
    });

    // Confirm (as of the grace-period exhaustion check) that capability is
    // really absent, so the safety-net callback actually fires.
    window.Echo360Translator.sourceFinder.hasNativeCaptionCapability.mockReturnValue(false);
    mockNow = 800;
    expect(() => video.dispatchEvent(new Event("timeupdate"))).not.toThrow();

    expect(onNoCaptionCapability).toHaveBeenCalledOnce();
    expect(renderer.isMounted()).toBe(false);
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
