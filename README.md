# echo360-online-subtitle-translator

**简体中文** | [English](README.en.md)

用于 Echo360 录播课的 Chrome/Safari 扩展，用来加载并显示翻译字幕；本地 FastAPI 后端保留为开发调试、fallback 和批处理路径。

## 功能概览

1. 在当前 Echo360 录播课页面中寻找 VTT 字幕源。
2. 默认通过扩展前端直连翻译服务（`direct_translator.js`）；dev 构建也可以发送到本地后端。
3. 如果启用本地后端，后端会调用仓库内的 VTT 翻译脚本作为 fallback/批处理工具：
   `translator/translate_vtt_zh_deepl_native.py`
4. 扩展将翻译后的 VTT 显示在当前 Echo360 视频上，支持浏览器字幕轨或 Echo360 原生 CC（Beta）两种渲染方式。

## 字幕渲染方式

默认使用 **浏览器 `<track>` 字幕轨**（`renderer.js`）：

- 单语模式直接挂载翻译 VTT。
- 双语模式由 `subtitle_strategy.js` 按浏览器选择策略：Safari 使用单 cue 双语 VTT，Chrome / Edge 等使用分 cue 双语 VTT。

可选开启 **Echo360 原生 CC（Beta）**（控制面板勾选，`bilingual_dom_renderer.js`）：

- 仅在双语模式下生效，尝试把译文注入 Echo360 播放器自带 CC 区域。
- 实验功能，默认关闭；若播放器未开启 Echo360 原声 CC，或页面结构变化导致匹配失败，Beta 模式不会额外挂载浏览器字幕轨。

切换显示偏好（双语、顺序、大小）不需要重新翻译；扩展端只缓存一份翻译 VTT，在前端渲染。

## 目录结构

```text
backend/      FastAPI 开发/fallback 服务和本地翻译缓存
extension/    Chrome/Safari 扩展源码
translator/   VTT 翻译脚本（后端/fallback 调用）
scripts/      扩展构建脚本
tests/        Vitest 单元测试（覆盖 extension 核心逻辑）
```

扩展主要模块：

```text
build_config.js           构建目标（dev/store）与本地后端开关
browser_api.js            Chrome / Safari storage 与 runtime API 抽象
constants.js              共享默认值和选项列表
vtt.js                    纯 VTT 解析、格式化、双语字幕工具
subtitle_strategy.js      浏览器检测与双语 VTT 构建策略
storage.js                配置、偏好和本地字幕缓存
video.js                  Echo360 视频发现、media-id 线索和页面探针桥接
source_finder.js          字幕源发现和字幕到视频的匹配
bilingual_dom_renderer.js Echo360 原生 CC DOM 双语注入（Beta）
renderer.js               浏览器字幕 track 生命周期和 cue 样式
direct_translator.js      扩展内直连翻译（store 构建默认路径）
ui.js                     页面浮动控制面板和状态更新
backend_client.js         后端代理、直连任务轮询和错误消息
translation_service.js    payload 构造、缓存键与翻译编排
controller.js             翻译用例编排
content.js                content script 入口
page_probe.js             MAIN world 的 Echo360/React/XHR 探针
background.js             service worker
popup.js / options.js     扩展弹窗与选项页
```

## 后端启动

先进入仓库根目录：

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

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

Windows (PowerShell) 健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8765/health
```

## 扩展安装

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 点击 `加载已解压的扩展程序`。
4. 选择当前仓库下的 `extension/` 目录。

进入 Echo360 classroom 页面后，右下角会出现浮动控制面板；也可通过扩展图标弹窗（`popup.html`）或选项页（`options.html`）配置 provider 与 API Key。正常使用点击 `加载翻译字幕`；如果需要清除当前缓存并重新翻译，点击 `重新翻译`。

## 发布构建

先在仓库根目录安装 Node 依赖：

```bash
npm install
```

源码默认保留本地后端开关，方便开发测试。上传 Chrome Web Store 时请使用 store 构建：

```bash
npm run build:store
```

构建产物：
- `dist/extension-store/`
- `dist/echo360-online-subtitle-translator-store.zip`

store 构建会禁用并隐藏本地后端入口，同时从 `manifest.json` 移除 `localhost` / `127.0.0.1` 权限。

本地开发测试可使用：

```bash
npm run build:dev
```

dev 构建保留本地后端入口和 localhost 权限。

## 测试

单元测试覆盖 `extension/` 中的 VTT 解析、字幕策略、存储、翻译 payload 与错误处理逻辑：

```bash
npm install
npm test
npm run test:coverage
```

测试文件位于 `tests/unit/`；配置见 `vitest.config.js`。

## 默认参数

- provider: `google-web`
- model: 默认空（Gemini 预设为 `gemini-3.1-flash-lite`）
- target: `ZH`
- max_paragraphs: `6`
- max_chars: `1200`
- concurrency: `96`
- rps: `0`
- retries: `1`
- timeout: `10`
- reasoning_effort: 默认空
- deepseek_thinking_mode: `disabled`

支持的 provider：`google-web`、`deepseek`、`openai`、`gemini`、`deepl`。除 `google-web` 外均需填写 API Key。

目标语言选项：`ZH`、`ZH-HK`、`YUE`、`EN`、`JA`、`KO`、`FR`、`DE`、`ES`、`IT`、`PT`、`RU`、`AR`、`HI`。

Chrome 商店版的高级翻译参数只显示与当前 provider 相关的设置：
- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking`（默认关闭，减少延迟）
- Gemini: 默认模型 `gemini-3.1-flash-lite`
- DeepL: `DeepL Formality`

dev 构建会额外保留本地后端调试参数，例如 `maxParagraphs`、`maxChars`、`concurrency`、`rps`、`retries`、`timeout`、`fallbackMode`、`repairConcurrency` 和 `slowSplitThreshold`。

语言补充：
- 当 provider 为 `deepl` 时，不支持 `YUE`（请使用 AI provider，如 `deepseek`/`openai`/`gemini`）

Google Translate provider：
- `google-web` 使用非官方网页端接口，不需要 API key，适合首次安装后快速试用
- store 构建会由扩展前端直接请求；dev 构建可选择通过本地后端转发
- 后端/脚本路径会自动使用 `concurrency=96, max_chars=1200, max_paragraphs=10`
- 该接口非官方，稳定性、可用性和翻译质量不保证
- 如果重视字幕翻译质量，建议改用 AI/API provider（如 `deepseek`/`openai`/`gemini`/`deepl`）并填写自己的 API Key

## 隐私

详见 [PRIVACY.md](PRIVACY.md)。扩展会将字幕文本发送到用户选择的翻译服务；API Key 与字幕缓存保存在 Chrome 本地 storage。

## 后端翻译脚本调用方式

后端直接构造参数列表，不通过 shell 拼接命令。默认调用方式：

```text
python translator/translate_vtt_zh_deepl_native.py input.vtt --out translated.vtt --key ... --provider deepseek --model deepseek-v4-flash --target ZH
```

可选环境变量覆盖：

```bash
export TRANSLATOR_SCRIPT=/absolute/path/to/translate_vtt_zh_deepl_native.py
export TRANSLATOR_PYTHON_BIN=/absolute/path/to/python
```

翻译脚本来自上游仓库 [bryanxianyu/VTT-Translator](https://github.com/bryanxianyu/VTT-Translator)，当前仓库内为 vendor 快照（`translator/translate_vtt_zh_deepl_native.py`）。

后端会检测翻译脚本是否支持以下可选参数：

- `--request-timeout`
- `--openai-reasoning-effort`

如果当前翻译脚本不支持某个可选参数，后端会跳过并输出 warning，而不是强行传入导致失败。

## 缓存策略

后端会将翻译后的 VTT 存到 `backend/.cache/`，该目录已被 git 忽略。

后端缓存身份基于会影响内容的输入：

- 原始 VTT 文本
- provider/model/endpoint
- 目标语言
- max paragraphs/chars
- 后端双语模式
- reasoning effort

并发数、RPS、重试次数、timeout 这类只影响性能的参数不参与内容缓存键。

扩展端只保留一个本地翻译字幕缓存。双语显示在前端渲染，因此切换双语显示不需要重新翻译。

## 说明

- `page_probe.js` 会注入页面上下文，用于读取 Echo360/React 视频 UUID 线索，从而提高字幕和视频匹配的准确性。
- 探针默认不抓取详细网络请求 body。
- 如果录播存在独立开场片段，扩展会优先使用强 media-id 映射，其次使用 timeline/state 兜底匹配。
