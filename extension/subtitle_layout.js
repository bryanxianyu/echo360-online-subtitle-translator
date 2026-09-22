(() => {
  const ns = window.Echo360Translator;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function intersect(a, b, x = true, y = true) {
    const left = x ? Math.max(a.left, b.left) : a.left;
    const top = y ? Math.max(a.top, b.top) : a.top;
    const right = x ? Math.min(a.right, b.right) : a.right;
    const bottom = y ? Math.min(a.bottom, b.bottom) : a.bottom;
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function objectOffset(value, space) {
    if (value === "left" || value === "top") return 0;
    if (value === "right" || value === "bottom") return space;
    if (value?.endsWith("%")) return space * parseFloat(value) / 100;
    if (value?.endsWith("px")) return parseFloat(value);
    return space / 2;
  }

  function visibleRect(video) {
    if (!video?.isConnected) return null;
    let rect = video.getBoundingClientRect();
    const css = getComputedStyle(video);
    if (css.display === "none" || css.visibility === "hidden" || css.opacity === "0") return null;
    if (video.videoWidth && video.videoHeight && ["contain", "scale-down"].includes(css.objectFit)) {
      let scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      if (css.objectFit === "scale-down") scale = Math.min(1, scale);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      const position = css.objectPosition.split(/\s+/);
      const left = rect.left + objectOffset(position[0], rect.width - width);
      const top = rect.top + objectOffset(position[1], rect.height - height);
      rect = { left, top, right: left + width, bottom: top + height, width, height };
    }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    rect = intersect(rect, { left, top, right: left + (viewport?.width || window.innerWidth), bottom: top + (viewport?.height || window.innerHeight) });
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    for (let parent = video.parentElement; parent; parent = parent.parentElement) {
      // Fullscreen belongs to the top layer: ancestors outside it no longer
      // clip it. The root's overflow clips to the viewport, handled above.
      if (parent === document.documentElement || fullscreen === video) break;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
      const clipX = /hidden|clip|scroll|auto/.test(style.overflowX || style.overflow);
      const clipY = /hidden|clip|scroll|auto/.test(style.overflowY || style.overflow);
      if (clipX || clipY) rect = intersect(rect, parent.getBoundingClientRect(), clipX, clipY);
      if (parent === fullscreen) break;
    }
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function metrics(rect, size, fullscreen) {
    const ratio = { small: 0.028, medium: 0.034, large: 0.042 }[size] || 0.034;
    const fontSize = clamp(Math.min(rect.height, rect.width * 9 / 16) * ratio, 16, 42);
    // Echo360 places its controls below the video picture, so their visibility
    // must not move captions. Embedded playback sits closer to the picture's
    // bottom edge; fullscreen keeps a smaller native-style inset while staying
    // close enough to the video edge when the player controls are visible.
    const bottom = fullscreen
      ? clamp(rect.height * 0.035, 20, 40)
      : clamp(rect.height * 0.012, 8, 16);
    return { fontSize, bottom, side: clamp(rect.width * 0.05, 12, 64) };
  }

  ns.subtitleLayout = { visibleRect, metrics, intersect };
})();
