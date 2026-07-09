(() => {
  const ns = window.Echo360Translator;

  // Facade over the ui_* modules: wires the ball, slide-out panel, settings
  // popover and first-run onboarding together, and exposes the same small
  // public surface controller.js has always depended on. Each concern
  // (theme tokens, stylesheet, ball, panel, popover, onboarding) lives in
  // its own file — see extension/ui_*.js.
  let handlers = {
    onTranslate: null,
    onForceTranslate: null,
    onPrefsChanged: null,
    onTargetChanged: null,
  };

  let activePanel = null;
  let activePopover = null;
  let activeFailureActions = null;

  function ensurePanel(nextHandlers) {
    handlers = { ...handlers, ...(nextHandlers || {}) };
    if (!location.hostname.includes("echo360.")) return;
    if (document.getElementById("echo360-translator-panel")) return;

    ns.uiStyles.inject();

    // Root wrapper — scopes CSS variable inheritance and keeps all UI elements
    // grouped. pointer-events:none is set in CSS; children re-enable as needed.
    const root = document.createElement("div");
    root.id = "echo360-ui-root";
    document.body.appendChild(root);

    function showPanel() {
      onboarding.dismiss();
      ball.hide();
      panel.show();
    }

    function hidePanel() {
      popover.hide();
      panel.hide();
      ball.show();
    }

    const ball = ns.uiBall.create(root, { onActivate: showPanel });
    const onboarding = ns.uiOnboarding.create(root, ball);
    const panel = ns.uiPanel.create(root, handlers, {
      onCollapse: hidePanel,
      onToggleSettings: () => popover.toggle(),
    });
    const popover = ns.uiPopover.create(root, handlers);
    activeFailureActions = ns.uiFailureActions.create(root);

    activePanel = panel;
    activePopover = popover;

    onboarding.maybeShow();

    // Apply stored appearance preference (async; safe to be slightly deferred).
    ns.storage.getConfig().then((cfg) => ns.uiTheme.applyAppearance(cfg.appearance || "auto")).catch(() => {});

    console.log("[echo360-translator] translate panel injected");
  }

  // -------------------------------------------------------------------------
  // Public API (surface unchanged)
  // -------------------------------------------------------------------------
  function readPanelPrefs() {
    return activePopover?.readPrefs();
  }

  function setStatusText(text) {
    activePopover?.setStatusText(text);
  }

  function updateActionButtons(text, disabled = false) {
    activePanel?.updateActionButtons(text, disabled);
  }

  function showTranslationFailureActions(handlers) {
    activeFailureActions?.show(handlers);
  }

  function hideTranslationFailureActions() {
    activeFailureActions?.hide();
  }

  ns.ui = {
    ensurePanel,
    readPanelPrefs,
    setStatusText,
    updateActionButtons,
    showTranslationFailureActions,
    hideTranslationFailureActions,
  };
})();
