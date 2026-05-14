# echo360-online-subtitle-translator

[简体中文](README.md) | **English**

Chrome extension + local FastAPI backend for loading translated subtitles on Echo360 recordings.

## What It Does

1. Finds the Echo360 VTT subtitle source for the current lecture.
2. Sends the VTT text to the local backend.
3. The backend calls the existing VTT translator script:
   `translator/translate_vtt_zh_deepl_native.py`
4. The extension mounts the translated VTT back onto the active Echo360 video.

## Directory Layout

```text
backend/     FastAPI service and local translation cache
extension/   Chrome extension files
```

Extension content-script modules:

```text
constants.js       Shared defaults and option lists
vtt.js             Pure VTT parsing/formatting/bilingual rendering helpers
storage.js         Chrome storage, config, prefs, and local subtitle cache
video.js           Echo360 video discovery, media-id hints, and page-probe bridge
source_finder.js   Subtitle source discovery and subtitle-to-video matching
renderer.js        Browser subtitle track lifecycle and cue styling
ui.js              Floating control panel and status updates
backend_client.js  Backend proxy calls, async job polling, and error messages
translation_service.js  Source resolution, payload construction, cache keys, backend translation
controller.js      Translation use-case orchestration
content.js         Thin content-script entrypoint
page_probe.js      MAIN-world Echo360/React/XHR probe for media-id hints
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

On an Echo360 classroom page, the control panel appears at the bottom right. Use `加载翻译字幕` for normal loading and `重新翻译` to clear the current cache and rerun translation.

## Defaults

- provider: `deepseek`
- model: `deepseek-v4-flash`
- target: `ZH`
- max_paragraphs: `6`
- max_chars: `1200`
- concurrency: `96`
- rps: `0`
- retries: `1`
- timeout: `10`
- reasoning_effort: empty by default

Language notes:
- Extension target options include `ZH-HK` and `YUE`
- `deepl` does not support `YUE`; use an AI provider instead (`deepseek`/`openai`/`gemini`)

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
