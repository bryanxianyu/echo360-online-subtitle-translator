# echo360-online-subtitle-translator

**简体中文** | [English](README.en.md)

用于 Echo360 录播课的 Chrome/Safari 扩展，用来加载并显示翻译字幕；本地 FastAPI 后端保留为开发调试、fallback 和批处理路径。

当前扩展版本：**1.4.3**

## 功能概览

1. 在当前 Echo360 录播课页面中寻找 VTT 字幕源（播放器 CC、网络抓取、`transcript-file` API 等）。
2. 默认通过扩展前端直连翻译服务（`direct_translator.js`）；dev 构建也可以发送到本地后端。
3. 如果启用本地后端，后端会调用仓库内的 VTT 翻译脚本作为 fallback/批处理工具：
   `translator/translate_vtt_zh_deepl_native.py`
4. 扩展将翻译后的 VTT 显示在当前 Echo360 视频上；默认优先注入 Echo360 原生 CC（Beta），本课程没有原生字幕位时自动回退到浏览器 `<track>` 字幕轨。
5. **边翻译边显示**（1.3.0）：点击翻译后立即挂载字幕，未完成的 cue 显示 `正在翻译中...`，随批次完成逐步替换为译文。
6. **按 provider 分别保存 API Key**；popup 与 options 页实时同步，切换 provider 时自动带出对应 Key。

## 字幕源发现

`source_finder.js` 会按优先级尝试多种来源，并把字幕与当前视频匹配：

- 播放器已挂载的 CC / `<track>` VTT
- 页面探针与网络层抓到的 VTT URL
- **Transcript 面板专用路径**（1.2.2）：当播放器没有可用 CC 时，调用  
  `/api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/transcript-file?format=vtt`

若所有策略都失败，控制面板会提示「未找到可用字幕源」。

## 翻译与显示流程

**直连翻译路径**（store 构建默认、dev 未开本地后端时）：

1. 点击 `加载翻译字幕` → 若可挂载，立刻显示字幕（未完成 cue 为 `正在翻译中...`）。
2. 翻译进行中 → 每批 partial VTT 热更新已译 cue；状态栏显示 `翻译中 X/Y（已开始显示）`。
3. 全部完成 → 用最终 VTT 做一次增量收尾，无需重新挂载。

**限制：**

- 增量预览目前仅支持扩展内直连翻译（`direct_translator.js` → background job）；本地 FastAPI 后端路径仍等整份 VTT 返回后再显示。
- 命中本地翻译缓存时直接显示完整字幕，不会走增量流程。

## 字幕渲染方式

默认策略（1.4.0 起）是 **Beta 优先、浏览器字幕轨兜底**（`renderer.js` + `bilingual_dom_renderer.js`）：

1. 尝试把译文注入 Echo360 播放器自带 CC 区域（英文在上、中文在下），外观与原生字幕一致。
   - 1.2.1 起改进了 DOM 匹配与注入时序，可与 Echo360 原生 CC 同帧更新。
   - 1.3.0 起同样支持**边翻译边显示**：通过 `updateTranslatedVtt()` 热更新 cue，无需等整份 VTT。
   - **1.4.1 性能修复**：1.4.0 把 Beta 设为默认后，`bilingual_dom_renderer.js` 在每个视频帧（`requestVideoFrameCallback`，通常 60Hz+）都会做一次 DOM 子树查询 + `JSON.stringify` 写入调试信息，播放期间持续占用主线程，导致播放器按钮、插件悬浮球动画等全页面卡顿。现改为用已缓存的锚点元素做 O(1) 判断，并把调试信息节流到最多每 250ms 写一次。
   - **1.4.2 性能修复**：定位到两处与 Beta 无关、只要打开课程页面就会一直跑的开销——① `video.js` 的 `querySelectorAllDeep()`（几乎所有视频/字幕轨查找的底层实现）每次调用都会对整个 `document` 做 `querySelectorAll("*")` 来找 shadow root，而这在每 1.2s 的 `trackSyncTimer` 里每 tick 触发好几次；② `page_probe.js` 每 1.5s 对页面里每个 `<video>` 做一次 React fiber 树的深度遍历（`reactHints`）。这两处都不需要那么高的实时性，现在分别改成带 TTL 缓存（3s）和按需（默认关闭，仅在真正解析字幕源时才做一次深度遍历）。
   - **1.4.3**：经排查，部分课程播放卡顿的根因其实是 **Echo360 播放器自身**（其 CSS-in-JS 样式在播放过程中持续 `insertRule` + 强制样式重算，与本扩展无关，暂停播放卡顿即消失），这部分无法从扩展侧修复。但扩展自身的悬浮球/控制面板动画（滑入滑出、脉冲提示环）之前是基于 `right`/`box-shadow` 做的，这类属性的动画需要在主线程上逐帧重新布局/绘制——一旦 Echo360 把主线程占满，我们的动画也会跟着一起掉帧。现改为只用 `transform`/`opacity`，交给合成线程处理，即使宿主页面主线程很忙，扩展自己的界面动画也能保持流畅；同时给面板按钮、悬浮球、弹层链接按钮加上了纯 CSS 的按下反馈（`:active` 缩放），点击时不必等待 JS 处理完才有视觉反馈。
2. `hasNativeCaptionCapability()`（`source_finder.js`）区分"这节课本来就没有原生字幕位"和"用户/Echo360 只是当前没打开 CC"。Echo360 自己的 CC 是通过自定义 DOM 渲染的，并不会往 `video.textTracks` 里塞真实 cue，所以主要信号是播放器控制栏里那颗 **"Toggle Captions" 按钮是否存在**（`aria-label`/`title` 不随界面语言变化，比它当前 `aria-pressed` 状态或易变的生成 class 名更稳定）；`<track>`/`TextTrack` 存在时也算有能力，作为兼容信号一起判断：
   - 播放器控制栏里连"Toggle Captions"按钮都没有，也没有 `<track>`/`TextTrack` → 判定为没有能力，挂载时立刻改用浏览器字幕轨，不会先空等一轮才切换。
   - 按钮存在但当前是关闭状态（`aria-pressed="false"`，一直匹配不到 DOM）→ 视为用户主动选择，保持沉默，不强行覆盖。
   - 兜底：即使挂载时误判为"有能力"，每个 cue 的匹配宽限期结束后仍会再确认一次，一旦确认没有能力会自动切到浏览器字幕轨（这次切换不会写入已保存的偏好，下节课依然优先尝试 Beta）。

可以在设置 popover 勾选 **始终使用浏览器字幕**（`ui_popover.js`）来关闭上述自动尝试，强制只用浏览器 `<track>` 字幕轨：

- 单语模式直接挂载翻译 VTT。
- 双语模式由 `subtitle_strategy.js` 按浏览器选择策略：Safari 使用单 cue 双语 VTT，Chrome / Edge 等使用分 cue 双语 VTT。
- 双语、顺序、大小等选项仅在此模式下可编辑；Beta 模式下这些选项会被强制为双语、非 reverse 顺序。

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
config_keys.js            popup/options 共用的 per-provider API Key 逻辑
constants.js              共享默认值和选项列表
vtt.js                    纯 VTT 解析、格式化、双语与增量预览工具
subtitle_strategy.js      浏览器检测与双语 VTT 构建策略
storage.js                配置、偏好和本地字幕缓存
video.js                  Echo360 视频发现、media-id 线索和页面探针桥接
source_finder.js          字幕源发现（含 transcript-file API）和字幕到视频匹配
bilingual_dom_renderer.js Echo360 原生 CC DOM 双语注入（Beta）
renderer.js               浏览器字幕 track / Beta DOM 渲染编排与 cue 样式
direct_translator.js      扩展内直连翻译与 partial VTT 回调（store 默认路径）
ui.js                     页面 UI 门面（组装 ball / panel / popover / onboarding）
ui_ball.js                右下角收纳球入口
ui_panel.js               滑出式翻译面板
ui_popover.js             显示与渲染偏好 popover
ui_onboarding.js          首次安装引导气泡
ui_styles.js / ui_theme.js 页面 UI 样式与浅色/深色主题
backend_client.js         后端代理、直连任务轮询（含 partial_vtt）和错误消息
translation_service.js    payload 构造、缓存键与翻译编排
controller.js             翻译用例编排（含增量预览挂载）
content.js                content script 入口
page_probe.js             MAIN world 的 Echo360/React/XHR 探针
background.js             service worker（直连翻译 job 与 partial_vtt 存储）
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

进入 Echo360 classroom 页面后，右下角会出现**收纳球**；点击展开滑出式翻译面板，齿轮按钮打开显示/渲染偏好 popover。首次安装会显示一次性引导气泡。也可通过扩展图标弹窗（`popup.html`）或选项页（`options.html`）配置 provider 与 API Key（各 provider 的 Key 分别保存，切换 provider 时自动切换）。正常使用点击 `加载翻译字幕`；如果需要清除当前缓存并重新翻译，点击 `重新翻译`。

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
- 仅 Transcript 面板、无播放器 CC 的课时依赖 `transcript-file` API（1.2.2）；这类页面没有 Echo360 原生 CC DOM 可注入，会被 `hasNativeCaptionCapability()` 判定为无能力并直接使用浏览器字幕轨。
- 增量预览的 partial VTT 由 `direct_translator.js` 每批产出并经 `background.js` job 轮询；`buildIncrementalPreviewVtt()` 负责把未译 cue 替换为占位文案。
