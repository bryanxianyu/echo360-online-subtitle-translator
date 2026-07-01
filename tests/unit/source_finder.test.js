/**
 * Tests for extension/source_finder.js, focused on fetchTranscriptFileVtt():
 * the fallback that hits Echo360's own transcript-file API when no <track>,
 * no populated TextTrack, and no "vtt"/"caption"-looking network request can
 * be found (e.g. the player shows only a transcript side panel with no CC).
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const VTT = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHello\n";

let sourceFinder;
let videoMock;

function setup() {
  videoMock = {
    collectInteractiveMediaIdsFromResources: vi.fn(() => new Set()),
    getAllVideos: vi.fn(() => []),
    getVideoHintMediaIds: vi.fn(() => new Set()),
    extractMediaIdFromVttUrl: vi.fn(() => ""),
  };
  const ns = makeFullNs({ video: videoMock });
  window.Echo360Translator = ns;
  evalModule("vtt.js");
  evalModule("source_finder.js");
  return window.Echo360Translator.sourceFinder;
}

function setLocation(pathname, origin = "https://echo360.net.au") {
  const url = new URL(pathname, origin);
  Object.defineProperty(window, "location", {
    value: { pathname: url.pathname, origin, href: url.href, hostname: new URL(origin).hostname },
    configurable: true,
    writable: true,
  });
}

describe("fetchTranscriptFileVtt", () => {
  beforeEach(() => {
    sourceFinder = setup();
    global.fetch = vi.fn();
  });

  it("returns empty (and never fetches) when the URL has no lesson id", async () => {
    setLocation("/dashboard");
    const result = await sourceFinder.fetchTranscriptFileVtt(null);
    expect(result.text).toBe("");
    expect(result.strongMapped).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns empty (and never fetches) when no media id can be discovered", async () => {
    setLocation("/lesson/abc/classroom");
    const result = await sourceFinder.fetchTranscriptFileVtt(null);
    expect(result.text).toBe("");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches the transcript-file API using the lesson id and a discovered media id", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["media-1"]));
    global.fetch.mockResolvedValue({ ok: true, text: async () => VTT });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://echo360.net.au/api/ui/echoplayer/lessons/abc/medias/media-1/transcript-file?format=vtt",
      { credentials: "include" }
    );
    expect(result.text).toBe(VTT);
    expect(result.strongMapped).toBe(true);
    expect(result.sourceId).toContain("transcript-file");
    expect(result.sourceMeta.mediaId).toBe("media-1");
    expect(result.sourceMeta.mapSource).toBe("transcript-file");
  });

  it("also tries media ids hinted from <video> elements, not just resource-derived ones", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.getAllVideos.mockReturnValue([{}]);
    videoMock.getVideoHintMediaIds.mockReturnValue(new Set(["hinted-id"]));
    global.fetch.mockResolvedValue({ ok: true, text: async () => VTT });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.sourceMeta.mediaId).toBe("hinted-id");
  });

  it("skips a media id whose request 404s and tries the next candidate", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["bad-id", "good-id"]));
    global.fetch.mockImplementation(async (url) => {
      if (url.includes("bad-id")) return { ok: false, status: 404 };
      return { ok: true, text: async () => VTT };
    });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.text).toBe(VTT);
    expect(result.sourceMeta.mediaId).toBe("good-id");
  });

  it("ignores a response body that isn't actually VTT content", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["media-1"]));
    global.fetch.mockResolvedValue({ ok: true, text: async () => "<html>not found</html>" });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.text).toBe("");
  });

  it("ignores a VTT body with zero parsed cues", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["media-1"]));
    global.fetch.mockResolvedValue({ ok: true, text: async () => "WEBVTT\n\n" });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.text).toBe("");
  });

  it("swallows fetch errors and returns empty when every candidate fails", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["media-1"]));
    global.fetch.mockRejectedValue(new Error("network down"));

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.text).toBe("");
  });

  it("prefers the media id whose cue range covers the current playback time", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["media-early", "media-covers"]));
    const earlyVtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nEarly\n";
    const coversVtt = "WEBVTT\n\n1\n00:00:50.000 --> 00:01:00.000\nCovers\n";
    global.fetch.mockImplementation(async (url) => {
      if (url.includes("media-early")) return { ok: true, text: async () => earlyVtt };
      return { ok: true, text: async () => coversVtt };
    });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 55 });
    expect(result.sourceMeta.mediaId).toBe("media-covers");
  });

  it("stops after a resource id hits and does not probe video-hint ids", async () => {
    setLocation("/lesson/abc/classroom");
    videoMock.collectInteractiveMediaIdsFromResources.mockReturnValue(new Set(["good-id"]));
    videoMock.getAllVideos.mockReturnValue([{}]);
    videoMock.getVideoHintMediaIds.mockReturnValue(new Set(["hint-should-not-be-tried"]));
    global.fetch.mockResolvedValue({ ok: true, text: async () => VTT });

    await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain("/medias/good-id/");
  });

  it("drops video-hint ids that are just fragments of the lesson id", async () => {
    setLocation(
      "/lesson/G_2f659ee3-c780-481e-82cd-4cff915789fd_927f0a6a-d11d-48fd-9f6c-38c7eb330c21_2026-05-27T15:05:00.000_2026-05-27T17:00:00.000/classroom"
    );
    videoMock.getAllVideos.mockReturnValue([{}]);
    videoMock.getVideoHintMediaIds.mockReturnValue(
      new Set(["2f659ee3-c780-481e-82cd-4cff915789fd", "927f0a6a-d11d-48fd-9f6c-38c7eb330c21", "real-media-id"])
    );
    global.fetch.mockImplementation(async (url) => {
      if (url.includes("real-media-id")) return { ok: true, text: async () => VTT };
      return { ok: false, status: 404 };
    });

    const result = await sourceFinder.fetchTranscriptFileVtt({ currentTime: 0 });
    expect(result.sourceMeta.mediaId).toBe("real-media-id");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
