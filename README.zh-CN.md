# echo360-online-subtitle-translator

[简体中文](README.md) | [English](README.en.md)

用于 Echo360 录播课的 Chrome 扩展和本地 FastAPI 后端，用来加载并显示翻译字幕。

## 功能概览

1. 在当前 Echo360 录播课页面中寻找 VTT 字幕源。
2. 根据配置通过扩展前端直连翻译服务，或发送到本地后端。
3. 如果启用本地后端，后端会调用仓库内的 VTT 翻译脚本：
   `translator/translate_vtt_zh_deepl_native.py`
4. 扩展将翻译后的 VTT 挂载回当前 Echo360 视频。

## 目录结构

```text
backend/     FastAPI 服务和本地翻译缓存
extension/   Chrome 扩展文件
```

扩展 content script 模块：

```text
constants.js            共享默认值和选项列表
vtt.js                  纯 VTT 解析、格式化、双语字幕渲染工具
storage.js              Chrome storage、配置、偏好和本地字幕缓存
video.js                Echo360 视频发现、media-id 线索和页面探针桥接
source_finder.js        字幕源发现和字幕到视频的匹配
renderer.js             浏览器字幕 track 生命周期和 cue 样式
ui.js                   浮动控制面板和状态更新
backend_client.js       后端代理请求、异步任务轮询和错误消息
translation_service.js  字幕源解析、payload 构造、缓存键、后端翻译
controller.js           翻译用例编排
content.js              极薄 content script 入口
page_probe.js           MAIN world 的 Echo360/React/XHR 探针，用于 media-id 线索
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

进入 Echo360 classroom 页面后，右下角会出现控制面板。正常使用点击 `加载翻译字幕`；如果需要清除当前缓存并重新翻译，点击 `重新翻译`。

## 发布构建

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

## 默认参数

- provider: `google-web`
- model: 默认空
- target: `ZH`
- max_paragraphs: `6`
- max_chars: `1200`
- concurrency: `36`
- rps: `0`
- retries: `1`
- timeout: `10`
- reasoning_effort: 默认空
- deepseek_thinking_mode: `disabled`

高级翻译参数只显示与当前 provider 相关的设置：
- OpenAI: `Reasoning Effort`
- DeepSeek: `DeepSeek Thinking`（默认关闭，减少延迟）
- DeepL: `DeepL Formality`

语言补充：
- 扩展目标语言支持 `ZH-HK` 与 `YUE`
- 当 provider 为 `deepl` 时，不支持 `YUE`（请使用 AI provider，如 `deepseek`/`openai`/`gemini`）

Google Web provider：
- `google-web` 使用非官方网页端接口，不需要 API key，适合首次安装后快速试用
- store 构建会由扩展前端直接请求；dev 构建可选择通过本地后端转发
- 后端/脚本路径会自动使用 `concurrency=36, max_chars=1200, max_paragraphs=10`
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

扩展端只保留一个本地翻译字幕缓存。双语字幕在前端渲染，因此切换双语显示不需要重新翻译。

## 说明

- `page_probe.js` 会注入页面上下文，用于读取 Echo360/React 视频 UUID 线索，从而提高字幕和视频匹配的准确性。
- 探针默认不抓取详细网络请求 body。
- 如果录播存在独立开场片段，扩展会优先使用强 media-id 映射，其次使用 timeline/state 兜底匹配。
