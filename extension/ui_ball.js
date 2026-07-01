(() => {
  const ns = window.Echo360Translator;

  const BALL_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M4 6h16v2H4zm0 5h10v2H4zm0 5h7v2H4z"/>
  </svg>`;

  // The floating ball docked to the viewport edge. Exposes only the small
  // surface other modules need (show/hide/pulse) — callers never reach back
  // into its DOM via document.getElementById.
  function create(root, { onActivate } = {}) {
    const ball = document.createElement("button");
    ball.id = "echo360-translator-ball";
    ball.innerHTML = BALL_ICON;
    ball.title = "Echo360 字幕翻译";
    ball.setAttribute("aria-label", "展开字幕翻译控制面板");
    ball.addEventListener("click", () => onActivate?.());
    root.appendChild(ball);

    return {
      el: ball,
      hide() {
        ball.classList.add("echo360-ball-hidden");
      },
      show() {
        ball.classList.remove("echo360-ball-hidden");
      },
      pulse() {
        ball.classList.add("echo360-ball-pulse");
      },
      stopPulse() {
        ball.classList.remove("echo360-ball-pulse");
      },
    };
  }

  ns.uiBall = { create };
})();
