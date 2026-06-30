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
      SIZE_MAP: { small: "62%", medium: "70%", large: "78%" },
      SAFARI_SIZE_MAP: { small: "94%", medium: "110%", large: "128%" },
      CUE_LINE_MAP: { small: "97.2%", medium: "97.2%", large: "97.2%" },
    },
    buildConfig: { buildTarget: "store", enableLocalBackend: false },
    state: { latestPageVideoSnapshot: [] },
    ...overrides,
  };
}

/** Minimal mock for extensionApi.storage.local backed by a plain object. */
export function makeStorageMock(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    get: vi.fn(async (key) => ({ [key]: store[key] })),
    set: vi.fn(async (items) => { Object.assign(store, items); }),
    remove: vi.fn(async (key) => { delete store[key]; }),
  };
}
