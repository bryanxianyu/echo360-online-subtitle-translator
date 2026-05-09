(() => {
  const ns = window.Echo360Translator;
  const {
    DEFAULT_SUBTITLE_SIZE,
    CUE_LINE_MAP,
    BILINGUAL_LINE_PAIR_MAP,
  } = ns.constants;

  function formatVttTime(seconds) {
    const ms = Math.max(0, Math.floor(seconds * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mm = ms % 1000;
    const pad2 = (n) => String(n).padStart(2, "0");
    const pad3 = (n) => String(n).padStart(3, "0");
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(mm)}`;
  }

  function cueTextToLine(text) {
    return String(text || "").replace(/\r/g, "").trim();
  }

  function parseVttStats(vttText) {
    const lines = String(vttText || "").split("\n");
    const timeRe = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
    let cueCount = 0;
    let maxEnd = 0;
    const ranges = [];
    const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    for (const line of lines) {
      const match = line.match(timeRe);
      if (!match) continue;
      cueCount += 1;
      const s = toSec(match[1], match[2], match[3], match[4]);
      const e = toSec(match[5], match[6], match[7], match[8]);
      if (e > maxEnd) maxEnd = e;
      ranges.push([s, e]);
    }
    return { cueCount, maxEnd, ranges };
  }

  function parseVttBlocks(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("-->")) continue;
      let j = i + 1;
      const text = [];
      while (j < lines.length && lines[j].trim() !== "") {
        text.push(lines[j]);
        j += 1;
      }
      out.push({ time: lines[i], text: text.join("\n") });
      i = j;
    }
    return out;
  }

  function buildBilingualVtt(translatedVtt, originalVtt, reverseOrder = false, size = DEFAULT_SUBTITLE_SIZE) {
    const trans = parseVttBlocks(translatedVtt);
    const orig = parseVttBlocks(originalVtt);
    if (trans.length === 0 || orig.length === 0) return translatedVtt;
    const n = Math.min(trans.length, orig.length);
    const linePair = BILINGUAL_LINE_PAIR_MAP[size] || BILINGUAL_LINE_PAIR_MAP[DEFAULT_SUBTITLE_SIZE];
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < n; i += 1) {
      const [zhText, enText] = reverseOrder
        ? [orig[i].text, trans[i].text]
        : [trans[i].text, orig[i].text];
      lines.push(`${i + 1}a`);
      lines.push(`${trans[i].time} line:${linePair.upper} position:50% align:middle`);
      lines.push(zhText);
      lines.push("");

      lines.push(`${i + 1}b`);
      lines.push(`${trans[i].time} line:${linePair.lower} position:50% align:middle`);
      lines.push(enText);
      lines.push("");
    }
    return lines.join("\n");
  }

  function normalizeCueText(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isAlreadyBilingualVtt(translatedVtt, originalVtt) {
    const trans = parseVttBlocks(translatedVtt);
    const orig = parseVttBlocks(originalVtt);
    if (trans.length === 0 || orig.length === 0) return false;
    const n = Math.min(trans.length, orig.length, 120);
    if (n < 3) return false;

    let hit = 0;
    let checked = 0;
    for (let i = 0; i < n; i += 1) {
      const t = normalizeCueText(trans[i].text);
      const o = normalizeCueText(orig[i].text);
      if (!t || !o) continue;
      checked += 1;
      if (t.includes(o)) hit += 1;
    }
    if (checked < 3) return false;
    return hit / checked >= 0.35;
  }

  function hasCjk(text) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(text || ""));
  }

  function reorderCueTextZhFirst(text) {
    const parts = String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2) return String(text || "");
    const zhIdx = parts.findIndex((p) => hasCjk(p));
    if (zhIdx <= 0) return parts.join("\n");
    const zhLine = parts[zhIdx];
    const rest = parts.filter((_, i) => i !== zhIdx);
    return [zhLine, ...rest].join("\n");
  }

  function normalizeBilingualOrderZhFirst(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      if (!lines[i].includes("-->")) continue;
      const cueText = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        cueText.push(lines[j]);
        j += 1;
      }
      out.push(reorderCueTextZhFirst(cueText.join("\n")));
      out.push("");
      i = j;
    }
    return out.join("\n");
  }

  function extractPrimaryTranslatedVtt(vttText) {
    const lines = String(vttText || "").replace(/\r/g, "").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(lines[i]);
      if (!lines[i].includes("-->")) continue;
      const cueText = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        cueText.push(lines[j]);
        j += 1;
      }
      const parts = cueText.map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        out.push("");
      } else {
        const zhLine = parts.find((p) => hasCjk(p));
        out.push(zhLine || parts[0]);
      }
      out.push("");
      i = j;
    }
    return out.join("\n");
  }

  function applyCueBottom(vttText, size) {
    const linePos = CUE_LINE_MAP[size] || CUE_LINE_MAP[DEFAULT_SUBTITLE_SIZE];
    return String(vttText || "")
      .split("\n")
      .map((line) => {
        if (!line.includes("-->")) return line;
        if (/\sline:[^\s]+/.test(line)) return line;
        let out = line
          .replace(/\sline:[^\s]+/g, "")
          .replace(/\sposition:[^\s]+/g, "")
          .replace(/\salign:[^\s]+/g, "")
          .trimEnd();
        out += ` line:${linePos} position:50% align:middle`;
        return out;
      })
      .join("\n");
  }

  ns.vtt = {
    formatVttTime,
    cueTextToLine,
    parseVttStats,
    parseVttBlocks,
    buildBilingualVtt,
    isAlreadyBilingualVtt,
    normalizeBilingualOrderZhFirst,
    extractPrimaryTranslatedVtt,
    applyCueBottom,
  };
})();
