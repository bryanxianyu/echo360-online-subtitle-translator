/**
 * Helpers for loading extension IIFE modules into a jsdom test environment.
 *
 * Each extension module is an IIFE that registers itself onto
 * `window.Echo360Translator`. We:
 *  1. Set up the namespace with required constants/deps.
 *  2. Call `evalModule(filename)` — reads the source file from disk
 *     (so Stryker's instrumented copy is picked up in mutation runs)
 *     and executes it via `new Function`, which runs in global scope
 *     where jsdom's `window` is available.
 *  3. Tests then access the registered functions from the namespace.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstrumenter } from "istanbul-lib-instrument";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (repo root). */
export const PROJECT_ROOT = resolve(__dirname, "../..");

/** Absolute path to the extension source directory. */
export const EXT_DIR = resolve(PROJECT_ROOT, "extension");

let instrumenter;

function getInstrumenter() {
  if (!instrumenter) {
    instrumenter = createInstrumenter({
      coverageVariable: "__VITEST_COVERAGE__",
      esModules: true,
      autoWrap: false,
    });
  }
  return instrumenter;
}

/** Instrument during vitest runs; skip Stryker workers (they have their own instrumentation). */
function shouldInstrumentForCoverage() {
  return process.env.VITEST === "true" && !process.env.STRYKER_MUTATOR_WORKER;
}

/**
 * Read an extension source file from disk and execute its IIFE in the
 * current global scope. Any mutations applied by Stryker to the source
 * file will be reflected here because we read at runtime.
 *
 * Under vitest, the source is istanbul-instrumented first so branch/line
 * hits are attributed back to extension/*.js (plain v8 cannot track code
 * executed via `new Function()`).
 */
export function evalModule(filename) {
  const filepath = resolve(EXT_DIR, filename);
  let code = readFileSync(filepath, "utf-8");
  if (shouldInstrumentForCoverage()) {
    const coveragePath = relative(PROJECT_ROOT, filepath);
    code = getInstrumenter().instrumentSync(code, coveragePath);
  }
  // eslint-disable-next-line no-new-func
  new Function(code)();
}

/** Minimal namespace stub for modules that only need vtt constants. */
export function makeVttNs() {
  return {
    constants: {
      DEFAULT_SUBTITLE_SIZE: "medium",
      CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
      SUBTITLE_PENDING_LABEL: "正在翻译中...",
      SUBTITLE_FAILURE_LABEL: "[翻译失败]",
    },
  };
}

/** Full namespace stub — defaults to store build (extension-only, no local backend). */
export function makeFullNs(overrides = {}) {
  return {
    constants: {
      STORAGE_KEY: "echo360TranslatorConfig",
      CACHE_KEY: "echo360TranslatedVttCache",
      PREFS_KEY_PREFIX: "echo360TranslatorPrefs::",
      ONBOARDING_KEY: "echo360TranslatorOnboardingSeen",
      PROVIDER_LABELS: {
        "google-web": "Google Translate",
        deepseek: "DeepSeek",
        gemini: "Gemini",
        openai: "OpenAI",
        deepl: "DeepL",
      },
      TARGET_OPTIONS: ["ZH", "ZH-HK", "YUE", "EN", "JA"],
      TARGET_LABELS: {
        ZH: "简体中文",
        "ZH-HK": "繁体中文（香港）",
        YUE: "粤语（繁体）",
        EN: "英语 (English)",
        JA: "日语 (日本語)",
      },
      DEFAULT_SUBTITLE_SIZE: "medium",
      SUBTITLE_PENDING_LABEL: "正在翻译中...",
      SUBTITLE_FAILURE_LABEL: "[翻译失败]",
      SIZE_MAP: { small: "62%", medium: "70%", large: "78%" },
      SAFARI_SIZE_MAP: { small: "94%", medium: "110%", large: "128%" },
      CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
    },
    buildConfig: { buildTarget: "store", enableLocalBackend: false },
    state: { latestPageVideoSnapshot: [] },
    // Minimal browserApi stub — enough for modules (e.g. ui_popover.js) that
    // just register a storage.onChanged listener without exercising it.
    browserApi: {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    },
    ...overrides,
  };
}

/**
 * Loads the ui_*.js modules plus ui.js, in the same dependency order the
 * manifest's content_scripts list uses. Use this instead of
 * `evalModule("ui.js")` directly — ui.js is now a thin facade over
 * ui_theme/ui_styles/ui_ball/ui_onboarding/ui_panel/ui_popover.
 */
export function loadUiModules() {
  for (const filename of [
    "ui_theme.js",
    "ui_styles.js",
    "ui_ball.js",
    "ui_onboarding.js",
    "ui_panel.js",
    "ui_popover.js",
    "ui_failure_actions.js",
    "ui.js",
  ]) {
    evalModule(filename);
  }
}

/**
 * Minimal mock for extensionApi.storage.local backed by a plain object.
 * Mirrors chrome.storage.local.get's real signature: a single key, an array
 * of keys, or null/undefined to fetch the entire store (used by storage.js's
 * one-time legacy-prefs migration scan).
 */
export function makeStorageMock(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    get: vi.fn(async (key) => {
      if (key === null || key === undefined) return { ...store };
      if (Array.isArray(key)) {
        const result = {};
        for (const k of key) if (k in store) result[k] = store[k];
        return result;
      }
      return { [key]: store[key] };
    }),
    set: vi.fn(async (items) => { Object.assign(store, items); }),
    remove: vi.fn(async (key) => { delete store[key]; }),
  };
}
