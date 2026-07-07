import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUiModules, makeFullNs } from "../helpers/load-module.js";

function setupUi(initialPrefs) {
  Object.defineProperty(window, "location", {
    value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
    configurable: true,
    writable: true,
  });
  document.body.innerHTML = "";
  document.head.innerHTML = "";

  window.Echo360Translator = makeFullNs({
    storage: {
      getPrefs: vi.fn(async () => initialPrefs),
      getConfig: vi.fn(async () => ({ target: "ZH" })),
    },
  });
  loadUiModules();
  window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
}

async function openSettings() {
  document.getElementById("echo360-translator-settings-btn").click();
  await Promise.resolve();
}

function changeCheckbox(id, checked) {
  const input = document.getElementById(id);
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}

describe("settings popover render mode controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("restores browser subtitle checkboxes after toggling into Echo360 native CC mode and back to forced browser track", async () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: true,
      browserBilingual: false,
      browserReverseOrder: true,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();

    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.disabled).toBe(false);
    expect(reverseOrder.disabled).toBe(false);

    // Uncheck "始终使用浏览器字幕" → switch into native CC mode; browser-mode controls
    // become disabled but keep showing their last known values.
    changeCheckbox("echo360-pref-echo360-native-cc", false);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("0.45");
    expect(reverseOrder.style.cursor).toBe("not-allowed");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("grayscale(1)");

    // Re-check it → back to forced browser track; controls re-enabled with
    // the same restored values.
    changeCheckbox("echo360-pref-echo360-native-cc", true);
    expect(bilingual.disabled).toBe(false);
    expect(reverseOrder.disabled).toBe(false);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("");
    expect(reverseOrder.style.cursor).toBe("");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("");
  });

  it("readPanelPrefs saves native CC effective values separately from browser subtitle prefs", async () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: true,
      browserBilingual: false,
      browserReverseOrder: true,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();

    // Uncheck "始终使用浏览器字幕" → switch into native CC mode.
    changeCheckbox("echo360-pref-echo360-native-cc", false);
    const prefs = window.Echo360Translator.ui.readPanelPrefs();

    expect(prefs.useNativeSubtitles).toBe(false);
    expect(prefs.bilingual).toBe(true);
    expect(prefs.reverseOrder).toBe(false);
    expect(prefs.browserBilingual).toBe(false);
    expect(prefs.browserReverseOrder).toBe(true);
  });

  it("shows saved browser subtitle checkbox states and disables them when Echo360 native CC mode is active", async () => {
    setupUi({
      enabled: true,
      bilingual: true,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: false,
      size: "large",
    });
    await openSettings();

    const forceBrowserTrack = document.getElementById("echo360-pref-echo360-native-cc");
    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");

    expect(forceBrowserTrack.checked).toBe(false);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(false);
  });
});

describe("settings popover translation service display", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the displayed translation service in real time when the config changes elsewhere", async () => {
    let changeListener;
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
      configurable: true,
      writable: true,
    });
    document.body.innerHTML = "";
    document.head.innerHTML = "";

    window.Echo360Translator = makeFullNs({
      storage: {
        getPrefs: vi.fn(async () => ({
          enabled: true,
          bilingual: false,
          reverseOrder: false,
          browserBilingual: false,
          browserReverseOrder: false,
          useNativeSubtitles: true,
          size: "medium",
        })),
        getConfig: vi.fn(async () => ({ target: "ZH", provider: "google-web" })),
      },
      browserApi: {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
          onChanged: {
            addListener: vi.fn((listener) => { changeListener = listener; }),
            removeListener: vi.fn(),
          },
        },
      },
    });
    loadUiModules();
    window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
    await openSettings();

    const providerLabel = document.getElementById("echo360-current-provider");
    expect(providerLabel.textContent).toBe("Google Translate");

    // Simulate the options page (or popup) writing a new provider while this
    // popover stays open — no re-open needed for the label to refresh.
    changeListener(
      { echo360TranslatorConfig: { newValue: { target: "ZH", provider: "deepseek" } } },
      "local"
    );

    expect(providerLabel.textContent).toBe("DeepSeek");
  });

  it("ignores storage changes outside the local area or unrelated keys", async () => {
    let changeListener;
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
      configurable: true,
      writable: true,
    });
    document.body.innerHTML = "";
    document.head.innerHTML = "";

    window.Echo360Translator = makeFullNs({
      storage: {
        getPrefs: vi.fn(async () => ({ enabled: true, size: "medium", useNativeSubtitles: true })),
        getConfig: vi.fn(async () => ({ target: "ZH", provider: "google-web" })),
      },
      browserApi: {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
          onChanged: {
            addListener: vi.fn((listener) => { changeListener = listener; }),
            removeListener: vi.fn(),
          },
        },
      },
    });
    loadUiModules();
    window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
    await openSettings();

    const providerLabel = document.getElementById("echo360-current-provider");
    expect(providerLabel.textContent).toBe("Google Translate");

    changeListener({ echo360TranslatorConfig: { newValue: { provider: "deepseek" } } }, "sync");
    expect(providerLabel.textContent).toBe("Google Translate");

    changeListener({ someOtherKey: { newValue: {} } }, "local");
    expect(providerLabel.textContent).toBe("Google Translate");
  });
});
