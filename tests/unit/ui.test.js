import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

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
  evalModule("ui.js");
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

  it("restores browser subtitle checkboxes after toggling Echo360 native CC beta off", async () => {
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

    changeCheckbox("echo360-pref-echo360-native-cc", true);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("0.45");
    expect(reverseOrder.style.cursor).toBe("not-allowed");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("grayscale(1)");

    changeCheckbox("echo360-pref-echo360-native-cc", false);
    expect(bilingual.disabled).toBe(false);
    expect(reverseOrder.disabled).toBe(false);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("");
    expect(reverseOrder.style.cursor).toBe("");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("");
  });

  it("readPanelPrefs saves beta effective values separately from browser subtitle prefs", async () => {
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

    changeCheckbox("echo360-pref-echo360-native-cc", true);
    const prefs = window.Echo360Translator.ui.readPanelPrefs();

    expect(prefs.useNativeSubtitles).toBe(false);
    expect(prefs.bilingual).toBe(true);
    expect(prefs.reverseOrder).toBe(false);
    expect(prefs.browserBilingual).toBe(false);
    expect(prefs.browserReverseOrder).toBe(true);
  });

  it("shows saved browser subtitle checkbox states when Echo360 native CC beta is already enabled", async () => {
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

    const beta = document.getElementById("echo360-pref-echo360-native-cc");
    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");

    expect(beta.checked).toBe(true);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(false);
  });
});
