(() => {
  const ns = window.Echo360Translator;

  function seconds(value) {
    const parts = value.replace(",", ".").split(":").map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  // Treat VTT markup as text, never as live page HTML. Decode the entities
  // defined by WebVTT after stripping tags so escaped angle brackets survive.
  function plainText(value) {
    const entities = { amp: "&", lt: "<", gt: ">", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f", quot: '"', apos: "'" };
    return String(value || "").replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g, (_, name) => entities[name]).trim();
  }

  function parse(vtt) {
    const cues = [];
    for (const block of ns.vtt.parseVttBlocks(vtt)) {
      const match = block.time.match(/((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/);
      if (!match) continue;
      const start = seconds(match[1]);
      const end = seconds(match[2]);
      if (!(end > start)) continue;
      cues.push({ start, end, text: plainText(block.text) });
    }
    cues.sort((a, b) => a.start - b.start);
    let maxEnd = 0;
    for (const cue of cues) cue.maxEnd = maxEnd = Math.max(maxEnd, cue.end);
    return cues;
  }

  // Binary search plus a prefix maximum keeps long lectures inexpensive,
  // including overlapping cues and arbitrary backward seeks.
  function active(cues, time) {
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cues[mid].start <= time) low = mid + 1;
      else high = mid;
    }
    const found = [];
    for (let i = low - 1; i >= 0 && cues[i].maxEnd > time; i -= 1) {
      if (cues[i].end > time && cues[i].text) found.push(cues[i].text);
    }
    return found.reverse().join("\n");
  }

  ns.subtitleTimeline = { parse, active, plainText };
})();
