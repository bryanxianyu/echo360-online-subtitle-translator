(() => {
  const ns = window.Echo360Translator;

  // Design tokens for the in-page floating UI (ball, panel, popover).
  // `DARK` and `LIGHT` share the exact same shape on purpose: adding or
  // renaming a token in one theme forces the same change in the other, so
  // a component can never end up with a token in dark mode but not light
  // (the bug class this file exists to prevent).
  const DARK = {
    ball: {
      bg: "#111",
      fg: "#fff",
      border: "transparent",
      shadow: "rgba(0,0,0,0.45)",
      shadowHover: "rgba(0,0,0,0.6)",
    },
    surface: {
      bg: "rgba(20,20,20,0.82)",
      border: "rgba(255,255,255,0.06)",
      shadow: "rgba(0,0,0,0.5)",
      backdrop: "blur(14px) saturate(1.3)",
    },
    popoverSurface: {
      bg: "rgba(22,22,22,0.88)",
      border: "rgba(255,255,255,0.07)",
      shadow: "rgba(0,0,0,0.4)",
      backdrop: "blur(14px) saturate(1.3)",
    },
    fg: "#fff",
    button: { bg: "#444", fg: "#fff", fontWeight: 600, hoverFilter: "brightness(1.22)" },
    collapseButton: { bg: "#2b2b2b", fg: "#aaa" },
    divider: "rgba(255,255,255,0.18)",
  };

  const LIGHT = {
    ball: {
      bg: "#ffffff",
      fg: "#1a1a1a",
      border: "rgba(0,0,0,0.22)",
      shadow: "rgba(0,0,0,0.22)",
      shadowHover: "rgba(0,0,0,0.32)",
    },
    surface: {
      bg: "rgba(250,250,250,0.82)",
      border: "rgba(0,0,0,0.18)",
      shadow: "rgba(0,0,0,0.24)",
      backdrop: "blur(14px) saturate(1.8)",
    },
    popoverSurface: {
      bg: "rgba(255,255,255,0.88)",
      border: "rgba(0,0,0,0.18)",
      shadow: "rgba(0,0,0,0.2)",
      backdrop: "blur(14px) saturate(1.8)",
    },
    fg: "#1a1a1a",
    button: { bg: "#d4d4d4", fg: "#1a1a1a", fontWeight: 405, hoverFilter: "brightness(0.93)" },
    collapseButton: { bg: "#ebebeb", fg: "#666" },
    divider: "rgba(0,0,0,0.12)",
  };

  // The single place that maps a theme's token tree onto the flat
  // `--echo360-*` CSS custom properties consumed by ui_styles.js. Every
  // component reads colors through these variables instead of literal
  // values, so re-theming a surface/button only ever means editing DARK/LIGHT
  // above — never hunting through CSS or inline styles.
  function toCssVars(theme) {
    return `
        --echo360-ball-bg: ${theme.ball.bg};
        --echo360-ball-fg: ${theme.ball.fg};
        --echo360-ball-border: ${theme.ball.border};
        --echo360-ball-shadow: ${theme.ball.shadow};
        --echo360-ball-shadow-hover: ${theme.ball.shadowHover};
        --echo360-panel-bg: ${theme.surface.bg};
        --echo360-panel-border-color: ${theme.surface.border};
        --echo360-panel-shadow: ${theme.surface.shadow};
        --echo360-panel-backdrop: ${theme.surface.backdrop};
        --echo360-popover-bg: ${theme.popoverSurface.bg};
        --echo360-popover-fg: ${theme.fg};
        --echo360-popover-border-color: ${theme.popoverSurface.border};
        --echo360-popover-shadow: ${theme.popoverSurface.shadow};
        --echo360-popover-backdrop: ${theme.popoverSurface.backdrop};
        --echo360-btn-bg: ${theme.button.bg};
        --echo360-btn-fg: ${theme.button.fg};
        --echo360-btn-font-weight: ${theme.button.fontWeight};
        --echo360-btn-hover-filter: ${theme.button.hoverFilter};
        --echo360-btn-collapse-bg: ${theme.collapseButton.bg};
        --echo360-btn-collapse-fg: ${theme.collapseButton.fg};
        --echo360-divider-color: ${theme.divider};
    `;
  }

  // mode: "auto" | "light" | "dark". "auto" clears the override so the
  // `@media (prefers-color-scheme)` rule in ui_styles.js takes over.
  function applyAppearance(mode) {
    const root = document.getElementById("echo360-ui-root");
    if (!root) return;
    if (mode === "auto") {
      delete root.dataset.echo360Appearance;
    } else {
      root.dataset.echo360Appearance = mode;
    }
  }

  ns.uiTheme = { DARK, LIGHT, toCssVars, applyAppearance };
})();
