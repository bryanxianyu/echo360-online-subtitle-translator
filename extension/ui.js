(() => {
  const ns = window.Echo360Translator;
  const {
    TARGET_OPTIONS,
    DEFAULT_SUBTITLE_SIZE,
  } = ns.constants;

  let handlers = {
    onTranslate: null,
    onForceTranslate: null,
    onPrefsChanged: null,
    onTargetChanged: null,
  };

  function styleButton(btn, bg) {
    btn.style.padding = "10px 14px";
    btn.style.background = bg;
    btn.style.color = "#fff";
    btn.style.border = "0";
    btn.style.borderRadius = "8px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "14px";
  }

  function ensurePanel(nextHandlers) {
    handlers = { ...handlers, ...(nextHandlers || {}) };
    if (!location.hostname.includes("echo360.")) return;
    if (document.getElementById("echo360-translator-panel")) return;

    const panel = document.createElement("div");
    panel.id = "echo360-translator-panel";
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "16px";
    panel.style.zIndex = "2147483647";
    panel.style.display = "flex";
    panel.style.gap = "8px";

    const translateBtn = document.createElement("button");
    translateBtn.id = "echo360-translator-btn";
    translateBtn.textContent = "加载翻译字幕";
    translateBtn.title = "加载或复用当前录播的翻译字幕";
    translateBtn.setAttribute("aria-label", "加载翻译字幕");
    styleButton(translateBtn, "#111");
    translateBtn.addEventListener("click", () => handlers.onTranslate?.());

    const forceBtn = document.createElement("button");
    forceBtn.id = "echo360-translator-force-btn";
    forceBtn.textContent = "重新翻译";
    forceBtn.title = "清除当前字幕缓存并重新翻译";
    forceBtn.setAttribute("aria-label", "重新翻译字幕");
    styleButton(forceBtn, "#333");
    forceBtn.addEventListener("click", () => handlers.onForceTranslate?.());

    const settingsBtn = document.createElement("button");
    settingsBtn.id = "echo360-translator-settings-btn";
    settingsBtn.textContent = "字幕设置";
    settingsBtn.title = "打开字幕显示设置";
    settingsBtn.setAttribute("aria-label", "打开字幕设置");
    styleButton(settingsBtn, "#444");
    settingsBtn.addEventListener("click", toggleSettingsPopover);

    panel.appendChild(translateBtn);
    panel.appendChild(forceBtn);
    panel.appendChild(settingsBtn);
    document.body.appendChild(panel);
    ensureSettingsPopover();
    console.log("[echo360-translator] translate panel injected");
  }

  function ensureSettingsPopover() {
    if (document.getElementById("echo360-translator-popover")) return;
    const pop = document.createElement("div");
    pop.id = "echo360-translator-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "翻译字幕设置");
    pop.style.position = "fixed";
    pop.style.right = "16px";
    pop.style.bottom = "64px";
    pop.style.zIndex = "2147483647";
    pop.style.width = "280px";
    pop.style.background = "#1f1f1f";
    pop.style.color = "#fff";
    pop.style.borderRadius = "10px";
    pop.style.padding = "12px";
    pop.style.display = "none";
    pop.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    pop.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">翻译字幕设置</div>
      <label style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>显示翻译字幕</span>
        <input id="echo360-pref-enabled" type="checkbox" />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>双语字幕</span>
        <input id="echo360-pref-bilingual" type="checkbox" />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
        <span>反转字幕位置</span>
        <input id="echo360-pref-reverse" type="checkbox" />
      </label>
      <label style="display:block;margin:8px 0;">字幕大小
        <select id="echo360-pref-size" style="width:100%;margin-top:4px;">
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label style="display:block;margin:8px 0;">目标语言
        <select id="echo360-pref-target" style="width:100%;margin-top:4px;">
          ${TARGET_OPTIONS.map((t) => `<option value="${t}">${t}</option>`).join("")}
        </select>
      </label>
      <div id="echo360-status-text" role="status" aria-live="polite" style="font-size:12px;opacity:.9;margin-top:8px;min-height:18px;"></div>
    `;
    document.body.appendChild(pop);

    document.getElementById("echo360-pref-enabled").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-bilingual").addEventListener("change", () => handlers.onPrefsChanged?.());
    document.getElementById("echo360-pref-reverse").addEventListener("change", () => handlers.onPrefsChanged?.());
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
    document.getElementById("echo360-pref-enabled").checked = !!prefs.enabled;
    document.getElementById("echo360-pref-bilingual").checked = !!prefs.bilingual;
    document.getElementById("echo360-pref-reverse").checked = !!prefs.reverseOrder;
    document.getElementById("echo360-pref-size").value = prefs.size || DEFAULT_SUBTITLE_SIZE;
    document.getElementById("echo360-pref-target").value = (cfg.target || "ZH").toUpperCase();
  }

  function readPanelPrefs() {
    return {
      enabled: document.getElementById("echo360-pref-enabled").checked,
      bilingual: document.getElementById("echo360-pref-bilingual").checked,
      reverseOrder: document.getElementById("echo360-pref-reverse").checked,
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
