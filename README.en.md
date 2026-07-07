# echo360-online-subtitle-translator

[简体中文](README.md) | **English**

Chrome/Safari extension for loading translated subtitles on Echo360 recordings; the local FastAPI backend is kept as a development, fallback, and batch-processing path.

Current extension version: **1.4.0**

## What It Does

1. Finds the Echo360 VTT subtitle source for the current lecture (player CC, network capture, `transcript-file` API, etc.).
2. Translates directly from the extension frontend by default (`direct_translator.js`); dev builds can also proxy through the local backend.
3. If the local backend is enabled, the backend calls the bundled VTT translator script as a fallback/batch tool:
   `translator/translate_vtt_zh_deepl_native.py`
4. Displays translated subtitles on the active Echo360 video; by default it tries Echo360 native CC injection (Beta) first, and automatically falls back to a browser `<track>` when the lesson has no native caption slot.
5. **Incremental display while translating** (1.3.0): subtitles mount immediately on click; pending cues show `正在翻译中...` until each batch completes.
6. **Per-provider API keys** with real-time sync between the popup and options page; switching providers loads the matching key automatically.

## Subtitle Source Discovery

`source_finder.js` tries multiple strategies in priority order and maps subtitles to the active video:

- CC / `<track>` VTT already attached to the player
- VTT URLs captured via the page probe and network layer
- **Transcript-panel fallback** (1.2.2): when the player has no usable CC, call  
  `/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

If every strategy fails, the control panel reports that no usable subtitle source was found.

## Translation and Display Flow

**Direct translation path** (default in store builds; dev builds when the local backend is off):

1. Click `加载翻译字幕` → if mountable, subtitles appear immediately (pending cues show `正在翻译中...`).
2. While translating → each partial VTT hot-updates completed cues; status shows `翻译中 X/Y（已开始显示）`.
3. On completion → a final incremental refresh applies the full VTT without tearing down the renderer.

**Limits:**

- Incremental preview is only available on the in-extension direct path (`direct_translator.js` → background job). The local FastAPI backend still waits for the full VTT before display.
- A local translation cache hit mounts the complete subtitles immediately (no incremental flow).

## Subtitle Rendering

The default strategy (since 1.4.0) is **Beta first, browser track as fallback** (`renderer.js` + `bilingual_dom_renderer.js`):

1. Try injecting translated text into Echo360's built-in CC area (English on top, Chinese below), matching the native look.
   - Since 1.2.1, DOM matching and injection timing are improved for same-frame updates with native CC.
   - Since 1.3.0, this also supports **incremental display** via `updateTranslatedVtt()` cue hot updates.
   - **Performance**: with Beta as the default, `bilingual_dom_renderer.js` no longer queries the DOM every frame (debug snapshots throttled to 250ms); `video.js` caches shadow-root discovery for 3s; `page_probe.js` stops periodic `reactHints()` walks (on-demand only when resolving a subtitle source).
   - **UI**: profiling showed playback jank on some lessons comes from **Echo360's own player** (CSS-in-JS `insertRule` + style recalculation throughout playback; pausing stops it; not fixable from this extension). Our UI now animates the floating ball and panel with `transform`/`opacity` on the compositor thread and adds `:active` press feedback on buttons, so extension controls stay smooth even when the host page saturates the main thread.
   - **Bug fixes**: Beta fallback to the browser `<track>` renderer now respects the user's saved `browserBilingual`/`browserReverseOrder`; `renderCurrentCue()` bails out safely when `onNoCaptionCapability` synchronously unmounts mid-call.
2. `hasNativeCaptionCapability()` (`source_finder.js`) distinguishes "this lesson never had a native caption slot" from "the user/Echo360 simply has CC turned off right now". Echo360's own CC is rendered through a custom DOM overlay rather than populating `video.textTracks`, so the primary signal is the **existence of the player's "Toggle Captions" button** (its `aria-label`/`title` stay in English regardless of UI language, unlike its `aria-pressed` state or the volatile generated class names); a real `<track>`/`TextTrack` also counts as capability when present, as a compatibility signal:
   - No "Toggle Captions" button in the player controls, and no `<track>`/`TextTrack` either → treated as no capability; falls back to the browser track immediately on mount instead of waiting out a grace period first.
   - The button exists but is currently off (`aria-pressed="false"`, the DOM never matches) → treated as an intentional choice; stays silent instead of overriding it.
   - Safety net: even if the mount-time check was a false positive, each cue's matching grace period re-checks capability once more and still falls back automatically once it's confirmed absent (this fallback isn't persisted, so the next lesson still tries Beta first).

Check **始终使用浏览器字幕** (always use browser subtitles) in the settings popover (`ui_popover.js`) to disable the above and force the browser `<track>` renderer:

- Single-language mode mounts the translated VTT directly.
- Bilingual mode is built by `subtitle_strategy.js`: Safari uses a single-cue bilingual VTT; Chrome / Edge use split-cue bilingual VTT.
- Bilingual/order/size are only editable in this mode; in Beta mode they're forced to bilingual with non-reverse order.

Display preferences (bilingual, order, size) do not require retranslation. The extension caches one translated VTT and renders client-side.

## Directory Layout

```text
backend/      FastAPI dev/fallback service and local translation cache
extension/    Chrome/Safari extension source
translator/   VTT translator script (backend/fallback path)
scripts/      Extension build scripts
tests/        Vitest unit tests for core extension logic
```

Main extension modules:

```text
build_config.js           Build target (dev/store) and local-backend switch
browser_api.js            Chrome / Safari storage and runtime API abstraction
config_keys.js            Shared per-provider API key logic for popup/options
constants.js              Shared defaults and option lists
vtt.js                    Pure VTT parsing, formatting, bilingual, and incremental preview helpers
subtitle_strategy.js      Browser detection and bilingual VTT build strategy
storage.js                Config, prefs, and local subtitle cache
video.js                  Echo360 video discovery, media-id hints, and page-probe bridge
source_finder.js          Subtitle source discovery (incl. transcript-file API) and video matching
bilingual_dom_renderer.js Echo360 native CC DOM bilingual injection (Beta)
renderer.js               Browser track / Beta DOM render orchestration and cue styling
direct_translator.js      In-extension direct translation and partial VTT callbacks (default store path)
ui.js                     In-page UI facade (ball / panel / popover / onboarding)
ui_ball.js                Bottom-right dock ball entry point
ui_panel.js               Slide-out translation panel
ui_popover.js             Display and render preference popover
ui_onboarding.js          First-run onboarding bubble
ui_styles.js / ui_theme.js In-page UI styles and light/dark theming
backend_client.js         Backend proxy, direct job polling (incl. partial_vtt), and error messages
translation_service.js    Payload construction, cache keys, and translation orchestration
controller.js             Translation orchestration (incl. incremental preview mounting)
content.js                Content-script entrypoint
page_probe.js             MAIN-world Echo360/React/XHR probe
background.js             Service worker (direct jobs and partial_vtt storage)
popup.js / options.js     Extension popup and options page
```

## Backend Setup

First, go to the repo root:

```bash
cd /path/to/echo360-online-subtitle-translator
```

macOS / Linux:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Windows (PowerShell):

```powershell
cd backend
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

Windows (PowerShell) health check:

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```

## Extension Setup

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select the `extension/` directory in this repository.

On an Echo360 classroom page, a **dock ball** appears at the bottom right; click it to open the slide-out translation panel, and use the gear button for the display/render popover. First-time installs see a one-time onboarding bubble. You can also configure the provider and API key from the extension popup (`popup.html`) or options page (`options.html`); keys are stored per provider and switch automatically when you change provider. Use `加载翻译字幕` for normal loading and `重新翻译` to clear the current cache and rerun translation.

## Release Builds

Install Node dependencies at the repo root first:

```bash
npm install
```

The source tree keeps the local backend switch available for development. Use the store build for Chrome Web Store submission:

```bash
npm run build:store
```

Build outputs:
- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

The store build disables and hides the local backend entry, and removes `localhost` / `127.0.0.1` permissions from `manifest.json`.

For local development:

```bash
npm run build:dev
```

The dev build keeps the local backend entry and localhost permissions.

## Testing

Unit tests cover VTT parsing, subtitle strategy, storage, translation payloads, and error handling in `extension/`:

```bash
npm install
npm test
npm run test:coverage
```

Test files live under `tests/unit/`; see `vitest.config.js` for configuration.

## Defaults

- provider: `google-web`
- model: empty by default (Gemini preset: `gemini-3.1-flash-lite`)
- target: `ZH`
- max_paragraphs: `6`
- max_chars: `1200`
- concurrency: `96`
- rps: `0`
- retries: `1`
- timeout: `10`
- reasoning_effort: empty by default
- deepseek_thinking_mode: `disabled`

Supported providers: `google-web`, `deepseek`, `openai`, `gemini`, `deepl`. All except `google-web` require an API key.

Target language options: `ZH`, `ZH-HK`, `YUE`, `EN`, `JA`, `KO`, `FR`, `DE`, `ES`, `IT`, `PT`, `RU`, `AR`, `HI`.

In the Chrome Web Store build, advanced translation settings only show provider-specific options:
- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking` (disabled by default to reduce latency)
- Gemini: default model `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`

The dev build also keeps local-backend tuning controls such as `maxParagraphs`, `maxChars`, `concurrency`, `rps`, `retries`, `timeout`, `fallbackMode`, `repairConcurrency`, and `slowSplitThreshold`.

Language notes:
- `deepl` does not support `YUE`; use an AI provider instead (`deepseek`/`openai`/`gemini`)

Google Translate provider:
- `google-web` uses an unofficial web endpoint and does not require an API key, so it is useful for quick first-run testing
- The store build calls it directly from the extension frontend; the dev build can optionally proxy it through the local backend
- The backend/script path caps it at `concurrency=96, max_chars=1200, max_paragraphs=10`
- This endpoint is unofficial, so stability, availability, and translation quality are not guaranteed
- For better subtitle translation quality, use an AI/API provider such as `deepseek`, `openai`, `gemini`, or `deepl` with your own API key

## Privacy

See [PRIVACY.md](PRIVACY.md). The extension sends subtitle text to the translation provider selected by the user; API keys and subtitle cache are stored in Chrome local storage.

## Backend Translator Invocation

The backend builds an argument list directly instead of shell-parsing a command string. By default it uses:

```text
python translator/translate_vtt_zh_deepl_native.py input.vtt --out translated.vtt --key ... --provider deepseek --model deepseek-v4-flash --target ZH
```

Optional environment overrides:

```bash
export TRANSLATOR_SCRIPT=/absolute/path/to/translate_vtt_zh_deepl_native.py
export TRANSLATOR_PYTHON_BIN=/absolute/path/to/python
```

The translator script comes from [bryanxianyu/VTT-Translator](https://github.com/bryanxianyu/VTT-Translator), and this repository keeps a vendored snapshot at `translator/translate_vtt_zh_deepl_native.py`.

The backend detects support for optional translator flags:

- `--request-timeout`
- `--openai-reasoning-effort`

Unsupported optional flags are skipped with a warning instead of being sent to the translator.

## Caching

The backend stores translated VTT files in `backend/.cache/`, which is ignored by git.

Cache identity is based on content-affecting inputs:

- source VTT text
- provider/model/endpoint
- target language
- max paragraphs/chars
- bilingual backend mode
- reasoning effort

Performance-only settings such as concurrency, RPS, retries, and timeout are not part of the content cache key.

The extension keeps one local translated VTT cache entry. Bilingual display is rendered client-side, so toggling bilingual subtitles does not require retranslating.

## Notes

- `page_probe.js` is still injected in the page context to read Echo360/React video UUID hints for better subtitle-to-video mapping.
- Detailed network body capture in the probe is disabled by default.
- If a separated intro clip exists, the extension prefers strong media-id mapping first and timeline/state matching as fallback.
- Transcript-panel-only lessons without player CC rely on the `transcript-file` API (1.2.2); those pages have no native CC DOM to inject into, so `hasNativeCaptionCapability()` detects that and uses the browser track directly.
- Incremental preview partial VTT is emitted per batch by `direct_translator.js`, polled via `background.js` jobs; `buildIncrementalPreviewVtt()` replaces untranslated cues with placeholder text.
