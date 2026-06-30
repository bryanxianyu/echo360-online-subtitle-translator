(() => {
  const ns = window.Echo360Translator;
  const { TARGET_OPTIONS, TARGET_LABELS, DEFAULT_SUBTITLE_SIZE, PROVIDER_LABELS } = ns.constants;

  let handlers = {
    onTranslate: null,
    onForceTranslate: null,
    onPrefsChanged: null,
    onTargetChanged: null,
  };
  let browserModePrefs = {
    bilingual: false,
    reverseOrder: false,
  };

  const PANEL_W = 164;

  // Light-theme CSS custom property values.
  // Declared as a JS string so we can interpolate it into two separate CSS
  // rule blocks without repeating every line — one block for the explicit
  // [data-echo360-appearance="light"] override and one for the @media query
  // (CSS doesn't allow @media nesting in non-nesting-aware parsers).
  const LIGHT_VARS = `
        --echo360-ball-bg: #ffffff;
        --echo360-ball-fg: #1a1a1a;
        --echo360-ball-border: rgba(0,0,0,0.18);
        --echo360-btn-font-weight: 405;
        --echo360-ball-shadow: rgba(0,0,0,0.18);
        --echo360-ball-shadow-hover: rgba(0,0,0,0.28);
        --echo360-panel-bg: rgba(250,250,250,0.82);
        --echo360-panel-border-color: rgba(0,0,0,0.1);
        --echo360-panel-shadow: rgba(0,0,0,0.14);
        --echo360-panel-backdrop: blur(14px) saturate(1.8);
        --echo360-btn-primary-bg: #d4d4d4;
        --echo360-btn-primary-fg: #1a1a1a;
        --echo360-btn-secondary-bg: #d4d4d4;
        --echo360-btn-secondary-fg: #1a1a1a;
        --echo360-btn-tertiary-bg: #d4d4d4;
        --echo360-btn-tertiary-fg: #1a1a1a;
        --echo360-btn-collapse-bg: #ebebeb;
        --echo360-btn-collapse-fg: #666;
        --echo360-btn-hover-filter: brightness(0.93);
        --echo360-popover-bg: rgba(255,255,255,0.88);
        --echo360-popover-fg: #1a1a1a;
        --echo360-popover-border-color: rgba(0,0,0,0.1);
        --echo360-popover-shadow: rgba(0,0,0,0.1);
        --echo360-popover-backdrop: blur(14px) saturate(1.8);
  `;

  // -------------------------------------------------------------------------
  // CSS injection
  // -------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("echo360-ui-styles")) return;
    const style = document.createElement("style");
    style.id = "echo360-ui-styles";
    style.textContent = `
      /* ===== Theme-variable container ===== */
      /* #echo360-ui-root is pointer-events:none so it never intercepts clicks;
         interactive children re-enable pointer-events individually. */
      #echo360-ui-root {
        pointer-events: none;

        /* Dark theme (default) */
        --echo360-ball-bg: #111;
        --echo360-ball-fg: #fff;
        --echo360-ball-border: transparent;
        --echo360-ball-shadow: rgba(0,0,0,0.45);
        --echo360-ball-shadow-hover: rgba(0,0,0,0.6);
        --echo360-btn-font-weight: 600;
        --echo360-panel-bg: rgba(20,20,20,0.82);
        --echo360-panel-border-color: rgba(255,255,255,0.06);
        --echo360-panel-shadow: rgba(0,0,0,0.5);
        --echo360-panel-backdrop: blur(14px) saturate(1.3);
        --echo360-btn-primary-bg: #444;
        --echo360-btn-primary-fg: #fff;
        --echo360-btn-secondary-bg: #444;
        --echo360-btn-secondary-fg: #fff;
        --echo360-btn-tertiary-bg: #444;
        --echo360-btn-tertiary-fg: #fff;
        --echo360-btn-collapse-bg: #2b2b2b;
        --echo360-btn-collapse-fg: #aaa;
        --echo360-btn-hover-filter: brightness(1.22);
        --echo360-popover-bg: rgba(22,22,22,0.88);
        --echo360-popover-fg: #fff;
        --echo360-popover-border-color: rgba(255,255,255,0.07);
        --echo360-popover-shadow: rgba(0,0,0,0.4);
        --echo360-popover-backdrop: blur(14px) saturate(1.3);
      }

      /* Light theme – explicit "light" override */
      #echo360-ui-root[data-echo360-appearance="light"] {
        ${LIGHT_VARS}
      }

      /* Light theme – auto mode (follow system, unless "dark" is forced) */
      @media (prefers-color-scheme: light) {
        #echo360-ui-root:not([data-echo360-appearance="dark"]) {
          ${LIGHT_VARS}
        }
      }

      /* ===== Floating ball ===== */
      #echo360-translator-ball {
        position: fixed;
        right: -26px;
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
        transition: right 0.28s cubic-bezier(0.34,1.4,0.64,1),
                    opacity 0.2s ease,
                    box-shadow 0.2s;
        user-select: none;
        outline: none;
      }
      #echo360-translator-ball:hover {
        right: 6px;
        box-shadow: -5px 4px 22px var(--echo360-ball-shadow-hover);
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
        right: -64px;
        opacity: 0;
        pointer-events: none;
      }

      /* ===== First-run onboarding ===== */
      @keyframes echo360-ball-pulse-ring {
        0% { box-shadow: 0 0 0 0 var(--echo360-ball-shadow-hover); }
        70% { box-shadow: 0 0 0 14px rgba(0,0,0,0); }
        100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
      }
      #echo360-translator-ball.echo360-ball-pulse {
        animation: echo360-ball-pulse-ring 1.6s ease-out 3;
      }
      #echo360-onboarding-bubble {
        position: fixed;
        right: 70px;
        bottom: 122px;
        z-index: 2147483647;
        pointer-events: auto;
        max-width: 168px;
        background: var(--echo360-panel-bg);
        backdrop-filter: var(--echo360-panel-backdrop);
        -webkit-backdrop-filter: var(--echo360-panel-backdrop);
        color: var(--echo360-popover-fg);
        border: 1px solid var(--echo360-panel-border-color);
        border-radius: 10px;
        padding: 9px 11px;
        font-size: 12.5px;
        line-height: 1.45;
        box-shadow: -4px 2px 18px var(--echo360-panel-shadow);
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
        right: -6px;
        width: 10px;
        height: 10px;
        margin-top: -5px;
        background: inherit;
        border-right: 1px solid var(--echo360-panel-border-color);
        border-bottom: 1px solid var(--echo360-panel-border-color);
        transform: rotate(-45deg);
      }
      #echo360-onboarding-bubble-close {
        position: absolute;
        top: 2px;
        right: 5px;
        background: transparent;
        border: 0;
        color: inherit;
        opacity: 0.5;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        padding: 3px;
      }
      #echo360-onboarding-bubble-close:hover {
        opacity: 1;
      }

      /* ===== Control panel ===== */
      #echo360-translator-panel {
        position: fixed;
        right: -${PANEL_W + 40}px;
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
        transition: right 0.32s cubic-bezier(0.34,1.15,0.64,1);
      }
      #echo360-translator-panel.echo360-panel-visible {
        right: 12px;
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
        transition: filter 0.15s, opacity 0.15s;
      }
      .echo360-panel-btn:hover:not(:disabled) {
        filter: var(--echo360-btn-hover-filter);
      }
      .echo360-panel-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }

      /* Per-button colors pulled from theme variables */
      #echo360-translator-btn {
        background: var(--echo360-btn-primary-bg);
        color: var(--echo360-btn-primary-fg);
      }
      #echo360-translator-force-btn {
        background: var(--echo360-btn-secondary-bg);
        color: var(--echo360-btn-secondary-fg);
      }
      #echo360-translator-settings-btn {
        background: var(--echo360-btn-tertiary-bg);
        color: var(--echo360-btn-tertiary-fg);
      }
      #echo360-translator-collapse-btn {
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
    `;
    document.head.appendChild(style);
  }

  // -------------------------------------------------------------------------
  // Appearance
  // -------------------------------------------------------------------------
  function applyAppearance(mode) {
    const root = document.getElementById("echo360-ui-root");
    if (!root) return;
    if (mode === "auto") {
      delete root.dataset.echo360Appearance;
    } else {
      root.dataset.echo360Appearance = mode; // "light" or "dark"
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function styleDisabledControl(control, disabled) {
    if (!control) return;
    control.style.opacity = disabled ? "0.45" : "";
    control.style.cursor = disabled ? "not-allowed" : "";
    control.style.filter = disabled ? "grayscale(1)" : "";
  }

  function syncRenderModeControls() {
    const echo360NativeCc = document.getElementById("echo360-pref-echo360-native-cc");
    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");
    const subtitleSize = document.getElementById("echo360-pref-size");
    if (!echo360NativeCc || !bilingual || !reverseOrder || !subtitleSize) return;

    const disabled = echo360NativeCc.checked;
    bilingual.disabled = disabled;
    reverseOrder.disabled = disabled;
    subtitleSize.disabled = disabled;
    styleDisabledControl(bilingual, disabled);
    styleDisabledControl(reverseOrder, disabled);
    styleDisabledControl(subtitleSize, disabled);
    bilingual.checked = !!browserModePrefs.bilingual;
    reverseOrder.checked = !!browserModePrefs.reverseOrder;

    for (const id of [
      "echo360-pref-bilingual-label",
      "echo360-pref-reverse-label",
      "echo360-pref-size-label",
    ]) {
      const label = document.getElementById(id);
      if (label) {
        label.style.opacity = disabled ? "0.5" : "1";
        label.style.cursor = disabled ? "not-allowed" : "";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ball ↔ panel toggle
  // -------------------------------------------------------------------------
  function showPanel() {
    dismissOnboarding();
    document.getElementById("echo360-translator-ball")?.classList.add("echo360-ball-hidden");
    document.getElementById("echo360-translator-panel")?.classList.add("echo360-panel-visible");
  }

  function hidePanel() {
    const pop = document.getElementById("echo360-translator-popover");
    if (pop) pop.style.display = "none";
    document.getElementById("echo360-translator-panel")?.classList.remove("echo360-panel-visible");
    document.getElementById("echo360-translator-ball")?.classList.remove("echo360-ball-hidden");
  }

  // -------------------------------------------------------------------------
  // First-run onboarding
  // -------------------------------------------------------------------------
  let onboardingAutoHideTimer = null;

  function dismissOnboarding() {
    if (onboardingAutoHideTimer) {
      clearTimeout(onboardingAutoHideTimer);
      onboardingAutoHideTimer = null;
    }
    document.getElementById("echo360-translator-ball")?.classList.remove("echo360-ball-pulse");
    const bubble = document.getElementById("echo360-onboarding-bubble");
    if (bubble) {
      bubble.classList.remove("echo360-onboarding-visible");
      setTimeout(() => bubble.remove(), 260);
    }
  }

  // Shown at most once per install: a small speech bubble + pulsing ring on
  // the ball, so first-time users notice the (intentionally subtle) docked
  // icon. Marks itself seen as soon as it's scheduled to display, so it
  // won't re-trigger from other lesson tabs opened around the same time.
  async function maybeShowOnboarding(root) {
    let seen = true;
    try {
      seen = await ns.storage.getOnboardingSeen();
    } catch {
      seen = true;
    }
    if (seen) return;
    ns.storage.setOnboardingSeen().catch(() => {});

    const bubble = document.createElement("div");
    bubble.id = "echo360-onboarding-bubble";
    bubble.setAttribute("role", "status");
    bubble.innerHTML = `
      <button id="echo360-onboarding-bubble-close" aria-label="关闭提示" title="关闭提示">×</button>
      <div style="padding-right:14px;">点这里展开字幕翻译面板</div>
    `;
    root.appendChild(bubble);
    document.getElementById("echo360-onboarding-bubble-close").addEventListener("click", dismissOnboarding);

    setTimeout(() => {
      bubble.classList.add("echo360-onboarding-visible");
      document.getElementById("echo360-translator-ball")?.classList.add("echo360-ball-pulse");
    }, 900);
    onboardingAutoHideTimer = setTimeout(dismissOnboarding, 8000);
  }

  // -------------------------------------------------------------------------
  // Panel & ball creation
  // -------------------------------------------------------------------------
  const BALL_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M4 6h16v2H4zm0 5h10v2H4zm0 5h7v2H4z"/>
  </svg>`;

  function ensurePanel(nextHandlers) {
    handlers = { ...handlers, ...(nextHandlers || {}) };
    if (!location.hostname.includes("echo360.")) return;
    if (document.getElementById("echo360-translator-panel")) return;

    injectStyles();

    // Root wrapper — scopes CSS variable inheritance and keeps all UI elements
    // grouped. pointer-events:none is set in CSS; children re-enable as needed.
    const root = document.createElement("div");
    root.id = "echo360-ui-root";
    document.body.appendChild(root);

    // -- Ball --
    const ball = document.createElement("button");
    ball.id = "echo360-translator-ball";
    ball.innerHTML = BALL_ICON;
    ball.title = "Echo360 字幕翻译";
    ball.setAttribute("aria-label", "展开字幕翻译控制面板");
    ball.addEventListener("click", showPanel);
    root.appendChild(ball);
    maybeShowOnboarding(root);

    // -- Panel --
    const panel = document.createElement("div");
    panel.id = "echo360-translator-panel";
    panel.setAttribute("role", "toolbar");
    panel.setAttribute("aria-label", "字幕翻译控制面板");

    const collapseBtn = document.createElement("button");
    collapseBtn.id = "echo360-translator-collapse-btn";
    collapseBtn.className = "echo360-panel-btn";
    collapseBtn.innerHTML = "›";
    collapseBtn.title = "收起控制面板";
    collapseBtn.setAttribute("aria-label", "收起控制面板");
    collapseBtn.addEventListener("click", hidePanel);

    const translateBtn = document.createElement("button");
    translateBtn.id = "echo360-translator-btn";
    translateBtn.className = "echo360-panel-btn";
    translateBtn.textContent = "加载翻译字幕";
    translateBtn.title = "加载或复用当前录播的翻译字幕";
    translateBtn.setAttribute("aria-label", "加载翻译字幕");
    translateBtn.addEventListener("click", () => handlers.onTranslate?.());

    const forceBtn = document.createElement("button");
    forceBtn.id = "echo360-translator-force-btn";
    forceBtn.className = "echo360-panel-btn";
    forceBtn.textContent = "重新翻译";
    forceBtn.title = "清除当前字幕缓存并重新翻译";
    forceBtn.setAttribute("aria-label", "重新翻译字幕");
    forceBtn.addEventListener("click", () => handlers.onForceTranslate?.());

    const settingsBtn = document.createElement("button");
    settingsBtn.id = "echo360-translator-settings-btn";
    settingsBtn.className = "echo360-panel-btn";
    settingsBtn.textContent = "字幕设置";
    settingsBtn.title = "打开字幕显示设置";
    settingsBtn.setAttribute("aria-label", "打开字幕设置");
    settingsBtn.addEventListener("click", toggleSettingsPopover);

    panel.appendChild(collapseBtn);
    panel.appendChild(translateBtn);
    panel.appendChild(forceBtn);
    panel.appendChild(settingsBtn);
    root.appendChild(panel);

    ensureSettingsPopover(root);

    // Apply stored appearance preference (async; safe to be slightly deferred).
    ns.storage.getConfig().then((cfg) => applyAppearance(cfg.appearance || "auto")).catch(() => {});

    console.log("[echo360-translator] translate panel injected");
  }

  // -------------------------------------------------------------------------
  // Settings popover
  // -------------------------------------------------------------------------
  function ensureSettingsPopover(root) {
    if (document.getElementById("echo360-translator-popover")) return;
    const pop = document.createElement("div");
    pop.id = "echo360-translator-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "翻译字幕设置");
    // Explicit inline display:none so the JS toggle (=== "none") works correctly.
    pop.style.display = "none";
    pop.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">翻译字幕设置</div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;opacity:.85;margin-bottom:10px;padding-bottom:9px;border-bottom:1px solid currentColor;border-color:rgba(128,128,128,0.25);">
        <span>翻译服务：<strong id="echo360-current-provider" style="font-weight:600;">-</strong></span>
        <button id="echo360-change-provider-btn" style="
          border:0;background:transparent;color:inherit;
          font-size:12px;opacity:.8;cursor:pointer;padding:2px 0;
          text-decoration:underline;
        ">更改</button>
      </div>
      <label style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>显示翻译字幕</span>
        <input id="echo360-pref-enabled" type="checkbox" />
      </label>
      <label id="echo360-pref-bilingual-label" style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>双语字幕</span>
        <input id="echo360-pref-bilingual" type="checkbox" />
      </label>
      <label id="echo360-pref-reverse-label" style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>反转字幕位置</span>
        <input id="echo360-pref-reverse" type="checkbox" />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;" title="实验功能：把译文注入 Echo360 自带 CC 字幕。默认关闭，使用浏览器系统原生字幕。">
        <span>Echo360 原生 CC（Beta）</span>
        <input id="echo360-pref-echo360-native-cc" type="checkbox" />
      </label>
      <label id="echo360-pref-size-label" style="display:block;margin:8px 0;">字幕大小
        <select id="echo360-pref-size" style="width:100%;margin-top:4px;">
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label style="display:block;margin:8px 0;">目标语言
        <select id="echo360-pref-target" style="width:100%;margin-top:4px;">
          ${TARGET_OPTIONS.map((t) => `<option value="${t}">${(TARGET_LABELS && TARGET_LABELS[t]) || t}</option>`).join("")}
        </select>
      </label>
      <div id="echo360-status-text" role="status" aria-live="polite" style="font-size:12px;opacity:.9;margin-top:8px;min-height:18px;"></div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid currentColor;opacity:.25;"></div>
      <button id="echo360-open-options-btn" title="打开完整设置" style="
        display:inline-flex;align-items:center;gap:5px;
        margin-top:2px;padding:4px 8px 4px 6px;
        border:0;border-radius:6px;
        background:transparent;color:inherit;
        font-size:12px;cursor:pointer;opacity:.55;
        transition:opacity .15s;
      ">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.92 2h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.47c-.12.22-.07.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94L2.86 14.12c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"/>
        </svg>
        设置
      </button>
    `;
    (root || document.body).appendChild(pop);

    document.getElementById("echo360-open-options-btn").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
    });
    document.getElementById("echo360-open-options-btn").addEventListener("mouseenter", (e) => { e.currentTarget.style.opacity = "1"; });
    document.getElementById("echo360-open-options-btn").addEventListener("mouseleave", (e) => { e.currentTarget.style.opacity = ".55"; });
    document.getElementById("echo360-change-provider-btn").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
    });
    document.getElementById("echo360-pref-enabled").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-bilingual").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-reverse").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-echo360-native-cc").addEventListener("change", () => {
      const echo360NativeCc = document.getElementById("echo360-pref-echo360-native-cc");
      if (echo360NativeCc?.checked) {
        browserModePrefs = {
          bilingual: document.getElementById("echo360-pref-bilingual").checked,
          reverseOrder: document.getElementById("echo360-pref-reverse").checked,
        };
      }
      syncRenderModeControls();
      handlers.onPrefsChanged?.();
    });
    document.getElementById("echo360-pref-size").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-target").addEventListener("change", (event) => handlers.onTargetChanged?.(event));
  }

  async function toggleSettingsPopover() {
    const pop = document.getElementById("echo360-translator-popover");
    const show = pop.style.display === "none";
    pop.style.display = show ? "block" : "none";
    if (!show) return;
    const prefs = await ns.storage.getPrefs();
    const cfg = await ns.storage.getConfig();
    browserModePrefs = {
      bilingual: prefs.browserBilingual ?? (prefs.useNativeSubtitles !== false ? !!prefs.bilingual : false),
      reverseOrder: prefs.browserReverseOrder ?? (prefs.useNativeSubtitles !== false ? !!prefs.reverseOrder : false),
    };
    const providerKey = String(cfg.provider || "google-web").toLowerCase();
    document.getElementById("echo360-current-provider").textContent = PROVIDER_LABELS[providerKey] || cfg.provider || "未知";
    document.getElementById("echo360-pref-enabled").checked = !!prefs.enabled;
    document.getElementById("echo360-pref-bilingual").checked = !!browserModePrefs.bilingual;
    document.getElementById("echo360-pref-reverse").checked = !!browserModePrefs.reverseOrder;
    document.getElementById("echo360-pref-echo360-native-cc").checked = prefs.useNativeSubtitles === false;
    syncRenderModeControls();
    document.getElementById("echo360-pref-size").value = prefs.size || DEFAULT_SUBTITLE_SIZE;
    document.getElementById("echo360-pref-target").value = (cfg.target || "ZH").toUpperCase();
  }

  // -------------------------------------------------------------------------
  // Public API (surface unchanged)
  // -------------------------------------------------------------------------
  function readPanelPrefs() {
    const echo360NativeCc = document.getElementById("echo360-pref-echo360-native-cc");
    const betaEnabled = !!echo360NativeCc.checked;
    if (!betaEnabled) {
      browserModePrefs = {
        bilingual: document.getElementById("echo360-pref-bilingual").checked,
        reverseOrder: document.getElementById("echo360-pref-reverse").checked,
      };
    }
    return {
      enabled: document.getElementById("echo360-pref-enabled").checked,
      bilingual: betaEnabled ? true : browserModePrefs.bilingual,
      reverseOrder: betaEnabled ? false : browserModePrefs.reverseOrder,
      browserBilingual: browserModePrefs.bilingual,
      browserReverseOrder: browserModePrefs.reverseOrder,
      useNativeSubtitles: !betaEnabled,
      size: document.getElementById("echo360-pref-size").value || DEFAULT_SUBTITLE_SIZE,
    };
  }

  function setStatusText(text) {
    const el = document.getElementById("echo360-status-text");
    if (el) el.textContent = text;
  }

  function updateActionButtons(text, disabled = false) {
    const ids = ["echo360-translator-btn", "echo360-translator-force-btn", "echo360-translator-settings-btn"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (id === "echo360-translator-btn") el.textContent = text;
      el.disabled = disabled;
      el.style.opacity = disabled ? "0.75" : "1";
    }
  }

  ns.ui = {
    ensurePanel,
    readPanelPrefs,
    setStatusText,
    updateActionButtons,
  };
})();
