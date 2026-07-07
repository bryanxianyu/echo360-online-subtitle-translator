(() => {
  const ns = window.Echo360Translator;
  const videoApi = ns.video;
  const vttApi = ns.vtt;

  function findBestTrackElement(video) {
    const tracks = Array.from(video.querySelectorAll("track[src]"));
    if (tracks.length > 0) return tracks[0];
    const textTracks = Array.from(document.querySelectorAll("track[src]"));
    return textTracks[0] || null;
  }

  // Echo360's own CC box is rendered through a custom DOM overlay, not the
  // HTML5 <track>/TextTrack API — video.textTracks stays empty even on
  // lessons that visibly have a working CC toggle. So the only reliable,
  // toggle-state-independent signal is the *existence* of the player's own
  // "Toggle Captions" control: its aria-label/title stay in English
  // regardless of the page's UI language, while its generated class names
  // (styled-components hashes) are not stable across Echo360 deployments.
  function findCaptionToggleButton(video) {
    const player = video?.closest?.("#player") || document.querySelector("#player") || document;
    const controls = Array.from(player.querySelectorAll('button, [role="button"]'));
    return controls.find((el) => {
      const hint = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      return /caption|subtitle/i.test(hint);
    }) || null;
  }

  // Whether this video has ANY Echo360-owned caption capability at all —
  // regardless of whether it is currently toggled on/off. Deliberately
  // independent of "is a caption box visible right now":
  //   - A <track>/TextTrack existing (any `mode`), or the player exposing a
  //     "Toggle Captions" control (any `aria-pressed` state), means the
  //     lesson genuinely has native CC; if nothing is visible, that's the
  //     user (or Echo360) having turned it off, not a missing feature.
  //   - Neither exists (our own translated-track elements are excluded) —
  //     e.g. a Transcript-only lesson with no synced CC — so DOM injection
  //     can never succeed no matter how long we wait.
  function hasNativeCaptionCapability(video) {
    if (!video) return false;
    const nativeTrackEls = Array.from(video.querySelectorAll("track[src]")).filter(
      (t) => !t.hasAttribute("data-echo360-translated")
    );
    if (nativeTrackEls.length > 0) return true;
    if (Array.from(video.textTracks || []).some((t) => !(t.label || "").includes("翻译"))) return true;
    return !!findCaptionToggleButton(video);
  }

  async function exportVttFromTextTracks(video, timeoutMs = 8000) {
    const tracks = Array.from(video.textTracks || []);
    if (tracks.length === 0) return "";
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const t of tracks) {
        if (t.mode === "disabled") t.mode = "hidden";
        const cues = t.cues ? Array.from(t.cues) : [];
        if (cues.length > 0) {
          const lines = ["WEBVTT", ""];
          cues.forEach((cue, idx) => {
            const text = vttApi.cueTextToLine(cue.text);
            if (!text) return;
            lines.push(String(idx + 1));
            lines.push(`${vttApi.formatVttTime(cue.startTime)} --> ${vttApi.formatVttTime(cue.endTime)}`);
            lines.push(text);
            lines.push("");
          });
          if (lines.length > 2) return lines.join("\n");
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "";
  }

  function collectCandidateSubtitleUrls() {
    const entries = performance.getEntriesByType("resource") || [];
    const items = [];
    for (const e of entries) {
      const name = String(e.name || "");
      const low = name.toLowerCase();
      if (low.includes(".vtt") || low.includes("webvtt") || low.includes("subtitle") || low.includes("caption")) {
        items.push({ url: name, responseEnd: Number(e.responseEnd || 0) });
      }
    }
    const dedup = new Map();
    for (const item of items) dedup.set(item.url, item);
    return Array.from(dedup.values()).sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 20);
  }

  function getLessonId() {
    const m = String(location.pathname || "").match(/\/lesson\/([^/]+)/);
    return m ? m[1] : "";
  }

  function collectTranscriptMediaIdCandidates() {
    const lessonId = getLessonId();
    const lessonLower = lessonId.toLowerCase();
    const resourceIds = [...videoApi.collectInteractiveMediaIdsFromResources()];
    const hintIds = [];
    const seen = new Set(resourceIds);
    for (const v of videoApi.getAllVideos()) {
      for (const id of videoApi.getVideoHintMediaIds(v)) {
        if (seen.has(id)) continue;
        // React fiber / lesson URLs often leak partial UUIDs from the lesson id
        // itself (e.g. 2f659ee3… from G_2f659ee3-…_927f0a6a-…). They never
        // resolve to a transcript-file endpoint and only add console noise.
        if (lessonLower.includes(String(id).toLowerCase())) continue;
        seen.add(id);
        hintIds.push(id);
      }
    }
    return { lessonId, resourceIds, hintIds };
  }

  async function tryTranscriptFileForMediaIds(lessonId, mediaIds, video) {
    if (mediaIds.length === 0) return null;
    const nowSec = Number(video?.currentTime || 0);
    let best = null;
    for (const mediaId of mediaIds) {
      const url = `${location.origin}/api/ui/echoplayer/lessons/${encodeURIComponent(lessonId)}/medias/${encodeURIComponent(mediaId)}/transcript-file?format=vtt`;
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!(text.trim().startsWith("WEBVTT") || text.includes("-->"))) continue;
        const stats = vttApi.parseVttStats(text);
        if (stats.cueCount <= 0) continue;
        const coversNow = stats.ranges.some(([s, e]) => nowSec >= s && nowSec <= e);
        const score = (coversNow ? 1_000_000 : 0) + stats.maxEnd * 100 + stats.cueCount;
        if (!best || score > best.score) {
          best = { score, text, url, mediaId, cueCount: stats.cueCount, coversNow };
        }
      } catch (_) {}
    }
    return best;
  }

  function buildTranscriptFileResult(best) {
    return {
      text: best.text,
      sourceId: best.url,
      strongMapped: true,
      sourceMeta: {
        sourceId: best.url,
        mediaId: best.mediaId,
        mapSource: "transcript-file",
        stats: vttApi.parseVttStats(best.text),
      },
    };
  }

  // Echo360's transcript side panel (search icon + speaker labels, e.g. when
  // the player itself shows no CC track) is backed by a stable, documented
  // API — the same one its own "Download" button uses — rather than a
  // network request whose URL contains "vtt"/"caption"/"subtitle". Hitting
  // it directly finds a real, cue-timed VTT even when collectCandidateSubtitleUrls()
  // and the <track>/TextTrack based lookups all come up empty.
  async function fetchTranscriptFileVtt(video) {
    const empty = { text: "", sourceId: "", strongMapped: false, sourceMeta: null };
    const { lessonId, resourceIds, hintIds } = collectTranscriptMediaIdCandidates();
    if (!lessonId || (resourceIds.length === 0 && hintIds.length === 0)) return empty;

    // Interactive-media resource ids map directly to this lesson's transcript.
    // When one of them hits, stop immediately — do not keep probing React-fiber
    // hint UUIDs that mostly 404 and clutter the console.
    let best = await tryTranscriptFileForMediaIds(lessonId, resourceIds, video);
    if (best) {
      console.log(
        "[echo360-translator] using Echo360 transcript-file API VTT:",
        best.url,
        "cues=",
        best.cueCount,
        "coversNow=",
        best.coversNow
      );
      return buildTranscriptFileResult(best);
    }

    best = await tryTranscriptFileForMediaIds(lessonId, hintIds, video);
    if (!best) return empty;

    console.log(
      "[echo360-translator] using Echo360 transcript-file API VTT:",
      best.url,
      "cues=",
      best.cueCount,
      "coversNow=",
      best.coversNow
    );
    return buildTranscriptFileResult(best);
  }

  function buildSourceMeta(sourceId, vttText) {
    return {
      sourceId: sourceId || "",
      mediaId: videoApi.extractMediaIdFromVttUrl(sourceId || ""),
      mapSource: "",
      stats: vttApi.parseVttStats(vttText),
    };
  }

  async function fetchBestVttFromCandidates(video) {
    const candidates = collectCandidateSubtitleUrls();
    const nowSec = Number(video?.currentTime || 0);
    const durationSec = Number(video?.duration || 0);
    const videoHintIds = videoApi.getVideoHintMediaIds(video);
    const resourceMediaIds = videoApi.collectInteractiveMediaIdsFromResources();
    const activeVideoBoost = videoApi.isVideoLikelyActive(video) ? 50_000 : 0;
    let best = null;
    for (const item of candidates) {
      try {
        const resp = await fetch(item.url, { credentials: "include" });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!(text.trim().startsWith("WEBVTT") || text.includes("-->"))) continue;
        const stats = vttApi.parseVttStats(text);
        if (stats.cueCount <= 0) continue;
        const coversNow = stats.ranges.some(([s, e]) => nowSec >= s && nowSec <= e);
        const mediaId = videoApi.extractMediaIdFromVttUrl(item.url);
        const videoMapped = mediaId && videoHintIds.has(mediaId);
        const resourceMapped = mediaId && resourceMediaIds.has(mediaId);
        const strongMapped = !!(videoMapped || resourceMapped);
        const mapSource = videoMapped ? "video" : resourceMapped ? "resource" : "";

        let durationScore = 0;
        if (Number.isFinite(durationSec) && durationSec > 0 && Number.isFinite(stats.maxEnd) && stats.maxEnd > 0) {
          const diff = Math.abs(durationSec - stats.maxEnd);
          durationScore = Math.max(0, 20_000 - diff * 200);
        }

        const score =
          (strongMapped ? 10_000_000 : 0) +
          (coversNow ? 1_000_000 : 0) +
          durationScore +
          activeVideoBoost +
          stats.maxEnd * 100 +
          stats.cueCount +
          item.responseEnd / 1000;
        if (!best || score > best.score) {
          best = {
            score,
            text,
            url: item.url,
            mediaId,
            cueCount: stats.cueCount,
            strongMapped,
            mapSource,
            coversNow,
            durationScore: Math.round(durationScore),
          };
        }
      } catch (_) {}
    }
    if (!best) return { text: "", sourceId: "", strongMapped: false, sourceMeta: null };
    const stats = vttApi.parseVttStats(best.text);
    if (best.strongMapped) {
      console.log(
        "[echo360-translator] using strong-mapped VTT candidate:",
        best.url,
        "match=",
        best.mapSource,
        "cues=",
        best.cueCount,
        "maxEnd=",
        Math.round(stats.maxEnd),
        "coversNow=",
        best.coversNow,
        "durationScore=",
        best.durationScore
      );
    } else {
      console.log(
        "[echo360-translator] using timeline+state fallback VTT candidate:",
        best.url,
        "cues=",
        best.cueCount,
        "maxEnd=",
        Math.round(stats.maxEnd),
        "coversNow=",
        best.coversNow,
        "durationScore=",
        best.durationScore
      );
    }
    return {
      text: best.text,
      sourceId: best.url,
      strongMapped: !!best.strongMapped,
      sourceMeta: { ...buildSourceMeta(best.url, best.text), mapSource: best.mapSource || "" },
    };
  }

  function pickBestMountVideoByVtt(vttText, sourceMeta = null) {
    const videos = videoApi.getAllVideos();
    if (videos.length === 0) return null;
    if (!vttText) return videoApi.getPrimaryVideo();
    const stats = sourceMeta?.stats || vttApi.parseVttStats(vttText);
    const vttEnd = Number(stats.maxEnd || 0);
    if (!(vttEnd > 0)) return videoApi.getPrimaryVideo();
    const mediaId = (sourceMeta?.mediaId || "").toLowerCase();

    let best = null;
    for (const v of videos) {
      const d = Number(v.duration || 0);
      if (!Number.isFinite(d) || d <= 0) continue;
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      const diff = Math.abs(d - vttEnd);
      const canContainTimeline = d + 2 >= vttEnd;
      const strongMapped = mediaId && videoApi.getVideoHintMediaIds(v).has(mediaId);
      const coversCurrent = stats.ranges.some(([s, e]) => Number(v.currentTime || 0) >= s && Number(v.currentTime || 0) <= e);
      const closeDurationScore = Math.max(0, 2_000_000 - diff * 2000);
      const timelineScore = canContainTimeline ? 5_000_000 : -5_000_000;
      const score =
        (strongMapped ? 20_000_000 : 0) +
        timelineScore +
        closeDurationScore +
        (coversCurrent ? 1_000_000 : 0) +
        (!v.paused && !v.ended ? 100_000 : 0) +
        (Number(v.currentTime || 0) > 0 ? 50_000 : 0) +
        (visible ? 20_000 : 0) +
        area / 1000;
      if (!best || score > best.score) best = { video: v, score };
    }
    if (best?.video) {
      const d = Number(best.video.duration || 0);
      if (d + 2 < vttEnd && videos.length > 1 && vttEnd > 60) return null;
    }
    return best?.video || videoApi.getPrimaryVideo();
  }

  ns.sourceFinder = {
    findBestTrackElement,
    hasNativeCaptionCapability,
    exportVttFromTextTracks,
    collectCandidateSubtitleUrls,
    buildSourceMeta,
    fetchTranscriptFileVtt,
    fetchBestVttFromCandidates,
    pickBestMountVideoByVtt,
  };
})();
