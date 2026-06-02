(() => {
  const ns = window.Echo360Translator;
  const {
    DEFAULT_SUBTITLE_SIZE,
    CUE_LINE_MAP,
  } = ns.constants;

  const SPLIT_CUE_GAP_MAP = {
    small: 4.4,
    medium: 4.8,
    large: 5.5,
  };

  function detectBrowser() {
    const ua = navigator.userAgent || "";
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua) || /Chromium\//.test(ua) || /CriOS\//.test(ua)) return "chrome";
    if (/Safari\//.test(ua)) return "safari";
    return "unknown";
  }

  function buildSingleCueBilingualVtt({ translatedVtt, originalVtt, reverseOrder = false, size = DEFAULT_SUBTITLE_SIZE }) {
    const trans = ns.vtt.parseVttBlocks(translatedVtt);
    const orig = ns.vtt.parseVttBlocks(originalVtt);
    if (trans.length === 0 || orig.length === 0) return translatedVtt;
    const n = Math.min(trans.length, orig.length);
    const linePos = CUE_LINE_MAP[size] || CUE_LINE_MAP[DEFAULT_SUBTITLE_SIZE];
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < n; i += 1) {
      const [firstText, secondText] = reverseOrder
        ? [orig[i].text, trans[i].text]
        : [trans[i].text, orig[i].text];
      const cueLines = [firstText, secondText]
        .map(ns.vtt.cueTextToLine)
        .filter(Boolean);
      lines.push(String(i + 1));
      lines.push(`${trans[i].time} line:${linePos} position:50% align:middle`);
      lines.push(...cueLines);
      lines.push("");
    }
    return lines.join("\n");
  }

  function buildSplitCueBilingualVtt({ translatedVtt, originalVtt, reverseOrder = false, size = DEFAULT_SUBTITLE_SIZE }) {
    const trans = ns.vtt.parseVttBlocks(translatedVtt);
    const orig = ns.vtt.parseVttBlocks(originalVtt);
    if (trans.length === 0 || orig.length === 0) return translatedVtt;
    const n = Math.min(trans.length, orig.length);
    const linePos = CUE_LINE_MAP[size] || CUE_LINE_MAP[DEFAULT_SUBTITLE_SIZE];
    const gap = SPLIT_CUE_GAP_MAP[size] || SPLIT_CUE_GAP_MAP[DEFAULT_SUBTITLE_SIZE];
    const upper = `${Math.max(0, Number.parseFloat(linePos) - gap)}%`;
    const lower = linePos;
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < n; i += 1) {
      const [firstText, secondText] = reverseOrder
        ? [orig[i].text, trans[i].text]
        : [trans[i].text, orig[i].text];
      const first = ns.vtt.cueTextToLine(firstText);
      const second = ns.vtt.cueTextToLine(secondText);
      if (first) {
        lines.push(`${i + 1}a`);
        lines.push(`${trans[i].time} line:${upper} position:50% align:middle`);
        lines.push(first);
        lines.push("");
      }
      if (second) {
        lines.push(`${i + 1}b`);
        lines.push(`${trans[i].time} line:${lower} position:50% align:middle`);
        lines.push(second);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  function getStrategy() {
    const browser = detectBrowser();
    if (browser === "safari") {
      return {
        browser,
        cueMode: "single",
        buildBilingualVtt: buildSingleCueBilingualVtt,
      };
    }
    return {
      browser,
      cueMode: "split",
      buildBilingualVtt: buildSplitCueBilingualVtt,
    };
  }

  function buildBilingualVtt(options) {
    return getStrategy().buildBilingualVtt(options);
  }

  ns.subtitleStrategy = {
    detectBrowser,
    getStrategy,
    buildBilingualVtt,
    buildSingleCueBilingualVtt,
    buildSplitCueBilingualVtt,
  };
})();
