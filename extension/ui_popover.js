(() => {
  const ns = window.Echo360Translator;
  const { TARGET_OPTIONS, TARGET_LABELS, DEFAULT_SUBTITLE_SIZE, PROVIDER_LABELS, STORAGE_KEY } = ns.constants;

  function openOptionsPage() {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
  }

  function styleDisabledControl(control, disabled) {
    if (!control) return;
    control.style.opacity = disabled ? "0.45" : "";
    control.style.cursor = disabled ? "not-allowed" : "";
    control.style.filter = disabled ? "grayscale(1)" : "";
  }

  // The "翻译字幕设置" popover: per-lesson display prefs, target language,
  // and a read-only summary of the active translation provider with a link
  // out to the full options page.
  function create(root, handlers) {
    let browserModePrefs = { bilingual: false, reverseOrder: false };

    const pop = document.createElement("div");
    pop.id = "echo360-translator-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "翻译字幕设置");
    // Explicit inline display:none so the JS toggle (=== "none") works correctly.
    pop.style.display = "none";
    pop.innerHTML = `
      <div class="echo360-popover-title">翻译字幕设置</div>
      <div class="echo360-popover-provider-row">
        <span>翻译服务：<strong id="echo360-current-provider">-</strong></span>
        <button id="echo360-change-provider-btn" class="echo360-popover-link-btn echo360-popover-link-btn--underline">更改</button>
      </div>
      <label class="echo360-popover-row">
        <span>显示翻译字幕</span>
        <input id="echo360-pref-enabled" type="checkbox" />
      </label>
      <label id="echo360-pref-bilingual-label" class="echo360-popover-row">
        <span>双语字幕</span>
        <input id="echo360-pref-bilingual" type="checkbox" />
      </label>
      <label id="echo360-pref-reverse-label" class="echo360-popover-row">
        <span>反转字幕位置</span>
        <input id="echo360-pref-reverse" type="checkbox" />
      </label>
      <label class="echo360-popover-row" title="实验功能：把译文注入 Echo360 自带 CC 字幕。默认关闭，使用浏览器系统原生字幕。">
        <span>Echo360 原生 CC（Beta）</span>
        <input id="echo360-pref-echo360-native-cc" type="checkbox" />
      </label>
      <label id="echo360-pref-size-label" class="echo360-popover-block-label">字幕大小
        <select id="echo360-pref-size" class="echo360-popover-select">
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label class="echo360-popover-block-label">目标语言
        <select id="echo360-pref-target" class="echo360-popover-select">
          ${TARGET_OPTIONS.map((t) => `<option value="${t}">${(TARGET_LABELS && TARGET_LABELS[t]) || t}</option>`).join("")}
        </select>
      </label>
      <div id="echo360-status-text" class="echo360-status-text" role="status" aria-live="polite"></div>
      <div class="echo360-popover-divider"></div>
      <button id="echo360-open-options-btn" class="echo360-popover-link-btn" title="打开完整设置">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.92 2h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.47c-.12.22-.07.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94L2.86 14.12c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"/>
        </svg>
        设置
      </button>
    `;
    (root || document.body).appendChild(pop);

    const refs = {
      currentProvider: pop.querySelector("#echo360-current-provider"),
      enabled: pop.querySelector("#echo360-pref-enabled"),
      bilingual: pop.querySelector("#echo360-pref-bilingual"),
      bilingualLabel: pop.querySelector("#echo360-pref-bilingual-label"),
      reverseOrder: pop.querySelector("#echo360-pref-reverse"),
      reverseOrderLabel: pop.querySelector("#echo360-pref-reverse-label"),
      nativeCc: pop.querySelector("#echo360-pref-echo360-native-cc"),
      size: pop.querySelector("#echo360-pref-size"),
      sizeLabel: pop.querySelector("#echo360-pref-size-label"),
      target: pop.querySelector("#echo360-pref-target"),
      statusText: pop.querySelector("#echo360-status-text"),
    };

    function syncRenderModeControls() {
      const disabled = refs.nativeCc.checked;
      refs.bilingual.disabled = disabled;
      refs.reverseOrder.disabled = disabled;
      refs.size.disabled = disabled;
      styleDisabledControl(refs.bilingual, disabled);
      styleDisabledControl(refs.reverseOrder, disabled);
      styleDisabledControl(refs.size, disabled);
      refs.bilingual.checked = !!browserModePrefs.bilingual;
      refs.reverseOrder.checked = !!browserModePrefs.reverseOrder;

      for (const label of [refs.bilingualLabel, refs.reverseOrderLabel, refs.sizeLabel]) {
        label.classList.toggle("is-disabled", disabled);
      }
    }

    // Reflects the currently configured provider in the read-only "翻译服务"
    // row. Called on open, and whenever config changes elsewhere (popup /
    // options page) so the label doesn't go stale without needing a re-open.
    function applyProviderLabel(cfg) {
      const providerKey = String(cfg.provider || "google-web").toLowerCase();
      refs.currentProvider.textContent = PROVIDER_LABELS[providerKey] || cfg.provider || "未知";
    }

    ns.browserApi.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      const newConfig = changes[STORAGE_KEY].newValue;
      if (newConfig) applyProviderLabel(newConfig);
    });

    pop.querySelector("#echo360-open-options-btn").addEventListener("click", openOptionsPage);
    pop.querySelector("#echo360-change-provider-btn").addEventListener("click", openOptionsPage);
    refs.enabled.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.bilingual.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.reverseOrder.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.nativeCc.addEventListener("change", () => {
      if (refs.nativeCc.checked) {
        browserModePrefs = {
          bilingual: refs.bilingual.checked,
          reverseOrder: refs.reverseOrder.checked,
        };
      }
      syncRenderModeControls();
      handlers.onPrefsChanged?.();
    });
    refs.size.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.target.addEventListener("change", (event) => handlers.onTargetChanged?.(event));

    async function toggle() {
      const show = pop.style.display === "none";
      pop.style.display = show ? "block" : "none";
      if (!show) return;

      const prefs = await ns.storage.getPrefs();
      const cfg = await ns.storage.getConfig();
      browserModePrefs = {
        bilingual: prefs.browserBilingual ?? (prefs.useNativeSubtitles !== false ? !!prefs.bilingual : false),
        reverseOrder: prefs.browserReverseOrder ?? (prefs.useNativeSubtitles !== false ? !!prefs.reverseOrder : false),
      };
      applyProviderLabel(cfg);
      refs.enabled.checked = !!prefs.enabled;
      refs.bilingual.checked = !!browserModePrefs.bilingual;
      refs.reverseOrder.checked = !!browserModePrefs.reverseOrder;
      refs.nativeCc.checked = prefs.useNativeSubtitles === false;
      syncRenderModeControls();
      refs.size.value = prefs.size || DEFAULT_SUBTITLE_SIZE;
      refs.target.value = (cfg.target || "ZH").toUpperCase();
    }

    function readPrefs() {
      const betaEnabled = !!refs.nativeCc.checked;
      if (!betaEnabled) {
        browserModePrefs = {
          bilingual: refs.bilingual.checked,
          reverseOrder: refs.reverseOrder.checked,
        };
      }
      return {
        enabled: refs.enabled.checked,
        bilingual: betaEnabled ? true : browserModePrefs.bilingual,
        reverseOrder: betaEnabled ? false : browserModePrefs.reverseOrder,
        browserBilingual: browserModePrefs.bilingual,
        browserReverseOrder: browserModePrefs.reverseOrder,
        useNativeSubtitles: !betaEnabled,
        size: refs.size.value || DEFAULT_SUBTITLE_SIZE,
      };
    }

    return {
      el: pop,
      toggle,
      hide() {
        pop.style.display = "none";
      },
      readPrefs,
      setStatusText(text) {
        refs.statusText.textContent = text;
      },
    };
  }

  ns.uiPopover = { create };
})();
