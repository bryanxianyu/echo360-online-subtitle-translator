(() => {
  const ns = window.Echo360Translator;

  // The slide-out control panel (collapse / translate / re-translate /
  // settings buttons). Holds direct references to its own button elements so
  // `updateActionButtons()` never has to re-query the DOM by id.
  function create(root, handlers, { onCollapse, onToggleSettings } = {}) {
    const panel = document.createElement("div");
    panel.id = "echo360-translator-panel";
    panel.setAttribute("role", "toolbar");
    panel.setAttribute("aria-label", "字幕翻译控制面板");

    const collapseBtn = document.createElement("button");
    collapseBtn.id = "echo360-translator-collapse-btn";
    collapseBtn.className = "echo360-panel-btn echo360-panel-btn--collapse";
    collapseBtn.innerHTML = "›";
    collapseBtn.title = "收起控制面板";
    collapseBtn.setAttribute("aria-label", "收起控制面板");
    collapseBtn.addEventListener("click", () => onCollapse?.());

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
    settingsBtn.addEventListener("click", () => onToggleSettings?.());

    panel.appendChild(collapseBtn);
    panel.appendChild(translateBtn);
    panel.appendChild(forceBtn);
    panel.appendChild(settingsBtn);
    root.appendChild(panel);

    const actionButtons = [translateBtn, forceBtn, settingsBtn];

    return {
      el: panel,
      show() {
        panel.classList.add("echo360-panel-visible");
      },
      hide() {
        panel.classList.remove("echo360-panel-visible");
      },
      updateActionButtons(text, disabled = false) {
        for (const btn of actionButtons) {
          if (btn === translateBtn) btn.textContent = text;
          btn.disabled = disabled;
          btn.style.opacity = disabled ? "0.75" : "1";
        }
      },
    };
  }

  ns.uiPanel = { create };
})();
