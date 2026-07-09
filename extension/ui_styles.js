(() => {
  const ns = window.Echo360Translator;
  const { DARK, LIGHT, toCssVars } = ns.uiTheme;

  // Width of the slide-out control panel; also used to offset the popover
  // and ball so they stay clear of the panel when it's open.
  const PANEL_W = 164;

  function inject() {
    if (document.getElementById("echo360-ui-styles")) return;
    const style = document.createElement("style");
    style.id = "echo360-ui-styles";
    style.textContent = `
      /* ===== Theme-variable container ===== */
      /* #echo360-ui-root is pointer-events:none so it never intercepts clicks;
         interactive children re-enable pointer-events individually. */
      #echo360-ui-root {
        pointer-events: none;
        ${toCssVars(DARK)}
      }

      /* Light theme – explicit "light" override */
      #echo360-ui-root[data-echo360-appearance="light"] {
        ${toCssVars(LIGHT)}
      }

      /* Light theme – auto mode (follow system, unless "dark" is forced) */
      @media (prefers-color-scheme: light) {
        #echo360-ui-root:not([data-echo360-appearance="dark"]) {
          ${toCssVars(LIGHT)}
        }
      }

      /* ===== Floating ball ===== */
      /*
       * The reveal/hide and pulse animations below are deliberately written to
       * touch only "transform" and "opacity". Echo360's own player can pin the
       * main thread for hundreds of ms at a time (e.g. its own CSS-in-JS style
       * churn during playback); animating "right" or "box-shadow" instead would
       * require a synchronous layout/paint on that same main thread every
       * frame, so this UI would visibly stutter in lockstep with the page's
       * own jank. transform/opacity changes are handled by the compositor on
       * their own thread, so they keep animating smoothly even while the page
       * is busy - it won't fix the underlying page-side lag, but our own UI
       * stops adding to the perceived stutter.
       */
      #echo360-translator-ball {
        position: fixed;
        right: 6px;
        bottom: 120px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: var(--echo360-ball-bg);
        color: var(--echo360-ball-fg);
        border: 1px solid var(--echo360-ball-border);
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 2147483647;
        pointer-events: auto;
        box-shadow: -3px 2px 14px var(--echo360-ball-shadow);
        transform: translateX(32px);
        will-change: transform;
        transition: transform 0.28s cubic-bezier(0.34,1.4,0.64,1),
                    opacity 0.2s ease,
                    box-shadow 0.2s;
        user-select: none;
        outline: none;
      }
      #echo360-translator-ball:hover {
        transform: translateX(0);
        box-shadow: -5px 4px 22px var(--echo360-ball-shadow-hover);
      }
      /* Immediate, JS-independent press feedback so clicks feel responsive
         even if the actual click handler has to wait behind a busy main thread. */
      #echo360-translator-ball:hover:active {
        transform: translateX(0) scale(0.92);
      }
      /*
       * Extend the hover-sensitive zone 30 px to the right.
       * Without this, the 6 px gap between the ball and the viewport edge
       * causes the ball to flicker (mouseleave → retract → re-enter → repeat).
       */
      #echo360-translator-ball::after {
        content: "";
        position: absolute;
        top: -10px;
        right: -30px;
        bottom: -10px;
        left: 0;
      }
      #echo360-translator-ball.echo360-ball-hidden {
        transform: translateX(70px);
        opacity: 0;
        pointer-events: none;
      }

      /* ===== First-run onboarding ===== */
      @keyframes echo360-ball-pulse-ring {
        0% { transform: scale(1); opacity: 0.55; }
        70% { transform: scale(1.55); opacity: 0; }
        100% { transform: scale(1.55); opacity: 0; }
      }
      /* A ::before ripple instead of an animated box-shadow: same "radar ping"
         look, but scale+opacity can run on the compositor thread instead of
         forcing a main-thread repaint every frame.
         Loops until the user dismisses the onboarding bubble (no auto-hide timer). */
      #echo360-translator-ball.echo360-ball-pulse::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: var(--echo360-ball-shadow-hover);
        animation: echo360-ball-pulse-ring 1.8s ease-out infinite;
        will-change: transform, opacity;
        pointer-events: none;
      }
      #echo360-onboarding-bubble {
        position: fixed;
        right: 70px;
        bottom: 122px;
        z-index: 2147483647;
        pointer-events: auto;
        max-width: 240px;
        background: var(--echo360-panel-bg);
        backdrop-filter: var(--echo360-panel-backdrop);
        -webkit-backdrop-filter: var(--echo360-panel-backdrop);
        color: var(--echo360-popover-fg);
        border: 1px solid var(--echo360-panel-border-color);
        border-radius: 12px;
        padding: 14px 16px;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.5;
        box-shadow: -6px 4px 32px var(--echo360-panel-shadow);
        opacity: 0;
        transform: translateX(6px);
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      #echo360-onboarding-bubble.echo360-onboarding-visible {
        opacity: 1;
        transform: translateX(0);
      }
      #echo360-onboarding-bubble::after {
        content: "";
        position: absolute;
        top: 50%;
        right: -7px;
        width: 12px;
        height: 12px;
        margin-top: -6px;
        background: inherit;
        border-right: 1px solid var(--echo360-panel-border-color);
        border-bottom: 1px solid var(--echo360-panel-border-color);
        transform: rotate(-45deg);
      }
      .echo360-onboarding-text {
        padding-right: 18px;
      }
      #echo360-onboarding-bubble-close {
        position: absolute;
        top: 4px;
        right: 6px;
        background: transparent;
        border: 0;
        color: inherit;
        opacity: 0.5;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        padding: 4px;
      }
      #echo360-onboarding-bubble-close:hover {
        opacity: 1;
      }

      /* ===== Control panel ===== */
      /* Same reasoning as the ball above: slide via transform (compositor-only)
         instead of animating "right" (main-thread layout every frame). */
      #echo360-translator-panel {
        position: fixed;
        right: 12px;
        bottom: 80px;
        width: ${PANEL_W}px;
        z-index: 2147483647;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        background: var(--echo360-panel-bg);
        backdrop-filter: var(--echo360-panel-backdrop);
        -webkit-backdrop-filter: var(--echo360-panel-backdrop);
        border: 1px solid var(--echo360-panel-border-color);
        border-radius: 12px;
        padding: 10px;
        box-shadow: -4px 2px 24px var(--echo360-panel-shadow);
        transform: translateX(${PANEL_W + 52}px);
        will-change: transform;
        transition: transform 0.32s cubic-bezier(0.34,1.15,0.64,1);
      }
      #echo360-translator-panel.echo360-panel-visible {
        transform: translateX(0);
      }

      /* ===== Panel buttons ===== */
      .echo360-panel-btn {
        padding: 8px 10px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: var(--echo360-btn-font-weight);
        font-family: ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        background: var(--echo360-btn-bg);
        color: var(--echo360-btn-fg);
        transition: filter 0.15s, opacity 0.15s, transform 0.1s;
      }
      .echo360-panel-btn:hover:not(:disabled) {
        filter: var(--echo360-btn-hover-filter);
      }
      /* Applied by the browser on mousedown, independent of our click handler
         actually running - gives instant tactile feedback even if the real
         action is stuck waiting behind a busy main thread. */
      .echo360-panel-btn:active:not(:disabled) {
        transform: scale(0.96);
      }
      .echo360-panel-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .echo360-panel-btn--collapse {
        background: var(--echo360-btn-collapse-bg);
        color: var(--echo360-btn-collapse-fg);
        font-size: 15px;
        text-align: center;
        padding: 6px 0;
      }

      /* ===== Settings popover ===== */
      #echo360-translator-popover {
        position: fixed;
        right: ${PANEL_W + 28}px;
        bottom: 80px;
        z-index: 2147483647;
        pointer-events: auto;
        width: 280px;
        background: var(--echo360-popover-bg);
        backdrop-filter: var(--echo360-popover-backdrop);
        -webkit-backdrop-filter: var(--echo360-popover-backdrop);
        color: var(--echo360-popover-fg);
        border: 1px solid var(--echo360-popover-border-color);
        border-radius: 10px;
        padding: 12px;
        box-shadow: 0 6px 18px var(--echo360-popover-shadow);
      }
      .echo360-popover-title {
        font-weight: 600;
        margin-bottom: 8px;
      }
      .echo360-popover-provider-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        opacity: .85;
        margin-bottom: 10px;
        padding-bottom: 9px;
        border-bottom: 1px solid var(--echo360-divider-color);
      }
      .echo360-popover-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 8px 0;
        transition: opacity 0.15s;
      }
      .echo360-popover-row.is-disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .echo360-popover-block-label {
        display: block;
        margin: 8px 0;
      }
      .echo360-popover-select {
        width: 100%;
        margin-top: 4px;
      }
      .echo360-popover-divider {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid var(--echo360-divider-color);
      }
      .echo360-status-text {
        font-size: 12px;
        opacity: .9;
        margin-top: 8px;
        min-height: 18px;
      }
      .echo360-popover-link-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 0;
        background: transparent;
        color: inherit;
        font-size: 12px;
        cursor: pointer;
        padding: 2px 0;
        opacity: .6;
        transition: opacity .15s, transform 0.1s;
      }
      .echo360-popover-link-btn:hover {
        opacity: 1;
      }
      .echo360-popover-link-btn:active {
        transform: scale(0.95);
      }
      .echo360-popover-link-btn--underline {
        text-decoration: underline;
      }

      /* ===== Translation failure actions (subtitle-adjacent) ===== */
      #echo360-translator-failure-actions {
        position: fixed;
        left: 50%;
        bottom: 12%;
        transform: translateX(-50%);
        z-index: 2147483647;
        pointer-events: auto;
        display: none;
        align-items: center;
        gap: 10px;
        max-width: min(92vw, 720px);
        padding: 8px 14px;
        border-radius: 8px;
        background: rgba(20, 20, 20, 0.82);
        color: #fff;
        font-size: clamp(14px, 2.1vw, 20px);
        line-height: 1.35;
        text-align: center;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }
      .echo360-failure-label {
        font-weight: 600;
      }
      .echo360-failure-link {
        border: 0;
        background: transparent;
        color: #8ec8ff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-decoration: underline;
        padding: 0;
      }
      .echo360-failure-link:hover {
        color: #b8dcff;
      }
      .echo360-failure-link:active {
        transform: scale(0.96);
      }
      .echo360-failure-sep {
        opacity: 0.55;
        user-select: none;
      }
    `;
    document.head.appendChild(style);
  }

  ns.uiStyles = { inject, PANEL_W };
})();
