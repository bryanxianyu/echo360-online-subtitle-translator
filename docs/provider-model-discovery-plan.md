# Provider 模型发现与自动验证：GPT-6 Luna 实施说明

本文保留为原始实施方案，部分交互已在后续迭代中调整。当前实现以代码为准：API Key 或 Endpoint 变更后自动发现目录；若当前目录未返回已选模型，则保留原选择并跳过自动翻译验证，提示用户重新选择模型。目录中存在所选模型时，才对当前配置自动验证一次；切换模型只保存并标记为尚未测试，用户可手动验证。OpenAI 兼容服务支持按 Provider 保存 Responses 或 Chat Completions 协议。设置页和 popup 自动保存配置。

## 1. 目标与范围

用户选择翻译服务、填写 API Key 后，自动获取服务返回的模型列表；用户选定模型后，自动完成一次短文本翻译验证。模型列表支持搜索、刷新、手动输入，无需用户查找模型 ID。

本轮覆盖现有 `openai`、`deepseek`、`gemini`、`deepl`、`google-web`。设置页和 popup 使用同一套逻辑。保留每个 provider 的独立设置、旧配置、扩展直连和开发版本地后端功能。

本轮不增加其他 provider、Chrome 本地翻译、远程配置服务器或价格数据库；不改 Google 批量翻译与 429 重试策略；不承诺模型列表中的模型都已获账户调用权限。页面使用“服务返回的模型”，只有实际测试成功的当前配置标记为“翻译测试通过”。

先阅读仓库适用的 AGENTS.md 和当前实现。工作区已经有未提交修改，包括 Google 批量翻译及按 provider 保存性能参数；这些是现有工作基础，不得 reset、覆盖或回滚。不要创建新任务或调用其他代理；在当前任务中按阶段完成。

## 2. 用户流程与界面

设置页顺序：翻译服务 → API Key 与认证状态 → 模型搜索/选择 → 翻译测试结果 → 保存设置。目标语言继续保留。Endpoint 和已有性能参数放到高级设置。

模型区域提供搜索框、单选结果列表、“刷新模型”、“显示全部”和“手动输入模型 ID”。优先复用原生控件；若做自定义 combobox，必须支持键盘选择、Escape、焦点及无障碍标签。不做多选、全选、导入模型清单。

popup 将 `provider|model|endpoint` 的写死预设下拉拆成 provider 下拉和模型选择；同样支持填写 Key、查看验证状态及手动输入模型，完整高级配置仍在设置页。不要另外维护一份发现或验证逻辑。

具体规则：

- Key 停止输入 1000 ms 后自动发现模型；blur 可以提前触发，但必须去重。空 Key 不请求。
- provider、Key、Endpoint 变化时立即作废当前验证状态，取消旧任务或丢弃其结果。
- Endpoint 编辑期间先作废状态，等 blur 或用户点击验证时校验完整地址并提交；不要在用户输入一半的地址上发送凭据。
- 原配置已有模型：拉取列表后保留选择，并对当前完整配置执行一次翻译测试。
- 尚未选择模型：显示“请选择模型”，不自动选择列表第一项、最新或最贵的模型。用户选择后自动测试一次。
- 刷新只更新模型列表，不切换当前模型、不自动重新进行已完成的计费测试。
- 列表中找不到原模型：继续显示“已保存／手动模型”，允许测试，不清空或替换。
- 点击“重新验证”可主动重试。页面初始化只展示缓存与“上次验证时间”，不在每次打开 popup 时自动产生计费用量。
- Key 区域注明：Key 保存在浏览器本地，仅发送给所选服务地址。模型测试区域注明：自动验证会使用少量 API 用量。
- 检查失败不禁止保存草稿。缺少 AI 模型时正式翻译应提示先选模型，不能偷偷使用旧 hardcode 默认模型。
- 显示加载、无匹配、返回空列表、缓存过期、发现失败等状态；验证中禁用重复操作，不锁住整个表单。
- 不用一条几秒后消失的全局提示代替长期存在的认证状态和模型测试状态。

## 3. 每个服务的适配

实现前重新核对文末官方文档，尤其是认证、分页、错误码和参数支持。以下是接口方向，不是可忽略官方变化的永久常量。

| provider | 发现/认证检查 | 翻译验证 | UI |
| --- | --- | --- | --- |
| OpenAI | `GET https://api.openai.com/v1/models`，Bearer Key | 按每个 OpenAI 配置选择 Responses 或 Chat Completions | 搜索模型、手动模型、协议选择 |
| DeepSeek | 官方基础地址下的 `GET /models`，Bearer Key | 复用当前 Chat Completions 翻译路径 | 搜索模型、手动模型 |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models`，Key 放认证头 | 复用当前 generateContent 翻译路径 | 搜索模型、手动模型 |
| DeepL | 对实际使用的 Free/Pro 地址请求 `GET /v2/usage`，DeepL-Auth-Key | 复用当前文本翻译路径 | 隐藏模型选择，显示认证/额度状态 |
| Google 免费接口 | 无 Key、无公开模型发现流程 | 用户点击“测试连接”时发一次短文本翻译 | 隐藏 Key 和模型选择 |

Gemini 必须处理全部 `nextPageToken`，避免只展示第一页；去重并防止重复 token 无限循环。`models/xxx` 的显示 ID、存储 ID和调用路径要一致，避免拼出 `models/models/xxx`。

DeepL Free/Pro 地址的解析应在验证和正式翻译中一致。显式配置的 Endpoint 优先，默认规则按官方文档解析；不要验证一个地址而正式翻译另一个地址。额度查询成功只表示该查询获得授权，不代表文本翻译一定成功。

若模型列表接口返回 403/404，不应直接认定 Key 无效。可能是没有列表权限、代理不提供该接口或地址不匹配；保留手动输入和直接测试所选模型的入口。

## 4. 模型筛选与请求兼容性

统一返回结构建议：

```js
{
  id: "provider-model-id",
  displayName: "Optional readable name",
  eligibility: "candidate", // candidate | unknown | incompatible
  reason: "",
  supportedMethods: []
}
```

`candidate` 只代表可作为文本翻译候选，不代表验证通过。不要从名字推测价格、账户权限、速度、地区可用性或模型最新程度。

优先使用服务提供的能力元数据。Gemini 的 generateContent 支持可用于筛选，但单独这个字段不能保证模型支持所需文本输入/输出。OpenAI/DeepSeek 返回的基本模型信息未必足以确定全部能力，未知模型必须保留为待验证候选，不能依靠一份已知模型白名单把新模型全部排除。

可以用保守的规则标记明确的 embedding、语音识别、TTS、图像生成等不兼容模型。默认隐藏明确不兼容项，“显示全部”可查看原因；不要删除未知模型。模型名称和错误内容以 textContent 等安全方式渲染，不插入远端 HTML。

模型发现本身不会自动解决请求参数兼容性。检查 `direct_translator.js` 的 `resolveModel`、`allowedReasoningForModel`、`resolveOpenAiReasoningEffort`：

- UI 路径不再依赖 `gpt-5-nano` 等写死 fallback；旧配置中明确保存的 ID 完整保留。
- “自动” reasoning 设置不应对未知模型强塞 `low` 等参数；与正式翻译使用同一解析逻辑。
- 用户明确选择而服务不支持的高级参数，返回“当前参数不兼容”，不要误报 Key 错误，也不要测试时静默去掉、正式翻译又发送。
- 本轮不通过逐个尝试多个协议或参数组合来探测模型；未知能力由一次实际测试确认，失败后明确提示。

## 5. 配置模型及旧配置迁移

保留现有 `apiKeys` 和 `providerSettings`，扩展现有 providerSettings，避免另起一份同义配置。建议结构：

```js
{
  configVersion: 2,
  provider: "openai",
  apiKeys: { openai: "...", deepseek: "..." },
  providerSettings: {
    openai: {
      model: "用户选择的模型",
      endpoint: "",
      reasoningEffort: "",
      maxParagraphs: 6,
      maxChars: 1200,
      concurrency: 96,
      rps: 0,
      retries: 1,
      timeout: 10,
      fallbackMode: "immediate",
      repairConcurrency: 1,
      slowSplitThreshold: 0
    }
  }
  // 原有 target/appearance/backendUrl/useLocalBackend 等继续保留。
  // 顶层 model/endpoint/性能字段继续镜像当前 provider，兼容现有调用方。
  // legacy apiKey 在过渡期保留当前 provider 的镜像。
}
```

示例中的性能值只是现有配置示意，不代表新的安全参数推荐。DeepSeek thinking 与 DeepL formality 也分别存入各自 provider 设置。target 和 appearance 保持全局。

迁移须幂等：仅将旧顶层字段迁到当时选中的 provider；已存在的嵌套字段优先。其他 provider 用其现有性能默认值，模型和 Endpoint 不从当前 provider 继承。旧 Key 只迁到原 provider，不能作为其他 provider Key 的 fallback。明确清空 Key 后不能被 legacy apiKey 再次恢复。

使用共享配置模块统一默认值、迁移、active profile 解析及保存合并。只合并当前界面真正修改的字段，保留未知字段和其他 provider 数据，避免整个旧内存 map 覆盖较新的存储值。

必须修复本次涉及的现有问题：

1. `options.js` 切换服务时 model/endpoint 会沿用前一服务的值，需完整保存和恢复各自配置。
2. `persistApiKeysOnly()` 触发 storage.onChanged 后，`handleExternalConfigChange()` 会重建 localProviderSettings，可能丢掉本地草稿。使用字段 dirty 标记及定向合并，自己的写入也不能清空草稿。
3. 商店版构建会移除性能输入框；读不到 DOM 元素时必须保留该 provider 当前存储值，不能写入 1/100/0 等回退值。
4. popup 切换 provider 时也必须完成旧配置迁移并同步顶层镜像，不能把 Google 的性能参数或另一个服务的 Endpoint 带过去。

## 6. 代码结构与文件修改

沿用当前项目的普通脚本/IIFE 方式，不引入 UI 框架或新的打包体系。

建议新增模块，具体命名可调整：

| 文件 | 职责 |
| --- | --- |
| `extension/provider_config.js` | 配置默认值、迁移、按 provider 解析与合并；供 options/popup/storage 使用 |
| `extension/provider_catalog.js` | 服务地址解析、模型列表获取/分页/标准化、DeepL usage、错误分类；运行在后台 |
| `extension/provider_setup.js` | options/popup 共用的防抖、草稿状态、发现/验证请求和模型选择 UI 逻辑 |
| `extension/options.html` / `options.js` | 完整配置 UI，接入共享模块 |
| `extension/popup.html` / `popup.js` | provider 与动态模型分开，移除固定 modelPresets |
| `extension/background.js` | 新消息路由、来源校验、诊断请求执行、取消、缓存 |
| `extension/direct_translator.js` | 暴露单次诊断入口，保留正式翻译协议和解析复用；结构化 HTTP 错误 |
| `extension/storage.js` / `config_keys.js` | 新配置解析、Key 迁移与清空语义兼容 |
| `extension/manifest.json` | 仅在需要时补充共享脚本加载顺序；不扩大默认网络权限 |

使用 `browser_api.js` 提供的 runtime/storage 封装，popup 不再新增另一份 callback/promise 包装。检查 options/popup 的 script 顺序、background 的 importScripts 顺序、content_scripts 的依赖顺序。正常构建会复制 extension 文件；确认商店版裁剪标记没有包住新模型/验证 UI。

## 7. 消息、凭据和地址处理

建议三个消息类型：`provider-discover`、`provider-verify`、`provider-cancel`。每次请求带 `requestId`、provider、当前草稿快照和修订号。

尚未保存的 Key 可从设置页/popup 通过扩展内部消息一次性传入后台，在内存中使用；不要为了验证而先覆盖用户已保存配置。延续已有失焦保存 Key 的产品行为时，也必须通过共享定向合并，不影响其他字段。

后台新增消息只接受本扩展的 options/popup 页面：检查 sender.id 和解析后的 sender.url；仅检查 sender.id 不足以排除 content script。不要把凭据、模型目录或探测结果放进页面 DOM、content script 消息或网页 postMessage。

后台按可信 provider 适配器构造请求，不能提供可任意指定 URL/headers/body 的通用带 Key 代理。Endpoint 使用 URL 解析，拒绝用户名密码、含凭据查询参数和不支持的协议；认证头发送到用户明确配置的服务地址。拒绝诊断请求重定向，避免认证被带到意外目标。

自定义 Endpoint 必须同时影响模型发现和验证。区分基础地址与完整 `/responses`、`/chat/completions`、`/models/...:generateContent`、`/translate` 路径，按服务有针对性转换，保留代理所需前缀，不盲目追加 `/v1`。

第一版沿用现有 manifest 已授权的 host 范围。用户配置未授权的第三方域名时保留地址和草稿，明确显示“当前扩展未获此地址访问权限”；不要偷偷换回官方地址，也不要为此增加 `<all_urls>`。若要完整支持任意代理，作为后续独立的按域名可选权限功能处理。

## 8. 自动验证、并发与错误

认证检查和翻译验证各自有状态：`idle / checking / success / failed`，其中失败带具体类型。模型目录另有 `loading / ready / empty / stale / unavailable`。取消旧请求属于取消，不能显示为网络错误。

验证上下文至少包含 provider、规范化 Endpoint、Key 指纹、model、target、影响请求的高级参数和执行方式。每个页面实例持有递增修订号；响应携带 requestId。处理结果前再次确认修订号与当前上下文匹配，否则丢弃，不更新状态或配置。

同一页面相同上下文一次只允许一个请求；防抖和 blur 不应产生两次翻译。切换 provider/Key/Endpoint 后通过 AbortController 取消旧诊断；后台取消消息必须校验请求所有者，不能取消其他页面的任务。页面关闭时尽力取消，后台超时仍须保证资源释放。

建议模型发现单请求超时 10 秒、全分页过程总上限 30 秒；翻译测试上限 30 秒。所有错误及时恢复 UI。

自动检查不做重试、不做递归拆分、不对目录内每个模型发翻译请求。429/额度错误保留原状态上下文与重试提示，等待手动重试；若有 Retry-After，显示建议等待时间。

结构化错误建议 `{ category, httpStatus, providerCode, message, retryAfterSeconds }`。基于服务响应语义分类，不能仅靠 HTTP 状态或字符串猜测：

| 分类 | 用户提示 |
| --- | --- |
| invalid_key | Key 无效或已失效 |
| permission_denied | 无权使用此接口/模型，或受到访问限制 |
| quota_exceeded | 账户额度不足、配额耗尽或计费受限 |
| rate_limited | 服务暂时限流，请稍后重试 |
| model_unavailable | 当前模型不可用或不支持所选接口 |
| invalid_configuration | 服务地址或高级参数不兼容 |
| discovery_unavailable | 无法获取模型列表，可手动输入并测试 |
| network_error / timeout | 连接失败，尚不能判断 Key 是否有效 |
| invalid_response | 服务返回了无法识别的响应 |

403 不等于 Key 无效；429 可能是速率或额度问题。无法明确区分时展示谨慎的通用解释。远端 HTML 不展示全文，错误消息要截断、脱敏；任何日志不能包含 Key、Authorization、带 Key 的 URL 或完整请求体。

## 9. 翻译验证的实现要求

不要直接调用 `translateVtt()` 然后以 Promise resolve 判断成功：当前翻译流程可能保留原文并附 warning，还可能把认证错误变成 translation cancelled。这会产生假阳性或错误提示。

在 direct_translator 中提供类似 `probeTranslation(config, { signal })` 的单次入口，复用实际 provider 请求构造和返回解析，禁用重试、递归拆分、JSON 二次请求及“保留原文算成功”。一次验证最多一个翻译请求。

使用固定、非用户内容的短句；通常用英文，目标为英语时换一个非英语源句。使用当前目标语言与高级参数。验证响应可解析、数量正确、文本非空；对能可靠检测的目标做基本检查，避免把空响应或服务原样回显标成成功。不要求译文精确匹配某个字符串；测试通过也不是翻译质量评分。

如需约束输出用量，按当前协议支持的参数设置合理预算；不能把推理模型预算压到只返回空结果。发生参数错误时提示不兼容，不自动消耗多次请求试错。

开发版启用本地后端时，第一版可仍从扩展执行服务诊断，但必须在状态旁明确写“服务直连测试；未验证本地后端”。执行方式变化会作废当前测试展示；不要把这个结果宣传为完整后端链路已通过。后端连接保持原有健康检查流程。正式翻译入口需要校验必需的模型配置后再分流。

## 10. 缓存

模型目录缓存在独立的 storage.local key，避免目录更新触发整份配置重建。按 provider + 规范化 Endpoint + Key 的 SHA-256 指纹隔离；缓存项及索引不存第二份原始 Key。Key 更换不能读到原账号模型列表。

建议 TTL 24 小时、最多 20 个目录，记录 fetchedAt。优先展示有效缓存，用户可手动刷新；过期缓存标明时间。拉取失败保留相同上下文的旧列表并标为过期，部分分页失败不能冒充完整刷新成功。

模型列表缓存与认证/翻译验证结果分开。历史成功必须显示“上次测试成功”，不能显示成刚刚验证成功。Key、Endpoint、模型或请求参数变化时立即失效。模型发现成功不能将翻译测试状态设为成功。

## 11. 实施顺序

1. 统一配置解析与迁移，修复 provider 切换、草稿丢失及商店版字段被覆盖；先让现有功能保持正常。
2. 实现模型发现适配器、分页、地址解析、结构化错误、目录缓存和后台消息边界。
3. 增加单次翻译验证入口，处理参数兼容性、取消和过期响应；复用正式翻译路径。
4. 完成设置页 UI 和共享 setup 控制器，接入自动发现/验证。
5. popup 接入相同模块，替换固定模型预设；核对正式翻译 payload 使用选定模型。
6. 执行针对性测试、完整测试与双版本构建，整理结果及未能实测的服务。

按阶段推进，但不要完成一阶段就结束任务或反复问是否继续。遇到真实外部阻塞时完成其余独立工作并报告具体限制。不得发布、上传扩展或自行读取浏览器配置提取 Key。

## 12. 验收和测试

使用现有 Vitest + jsdom + fetch/runtime/storage mock，不添加新的测试框架。重点覆盖行为和实际回归风险：

- 三种模型 API 成功、空列表、分页、重复模型/分页 token；不兼容项与未知模型处理。
- 401、403、不同类型的 429、404、超时、网络异常、非 JSON、恶意模型名称及错误脱敏。
- 一个 Key 输入过程只有一次有效发现；选择模型只发生一次短文本翻译请求；刷新目录不触发计费测试。
- Key A 的慢响应晚于 Key B：不能覆盖 B 的模型列表或验证状态。切换 provider/Endpoint 和关闭 popup 的行为同样覆盖。
- 两个页面同时修改不同 provider 的 Key、模型或性能参数，互不覆盖；storage.onChanged 不破坏当前 dirty 草稿。
- 旧配置迁移两次结果一致；清空 Key 后不会复活；模型、Endpoint 和性能参数按 provider 恢复。
- 商店版不存在性能 DOM 控件时保存不会改坏配置；popup 切换不会继承上一 provider 参数。
- 测试失败不会把正式模型换成 hardcode fallback；列表不包含手动模型时仍能测试和使用。
- 验证入口认证失败、空结果或原文回显不会出现成功状态；没有递归、自动重试和批量模型探测。
- 不可信 content script 发新诊断消息被拒绝；非法地址/跨目标重定向不能携带凭据继续访问。
- 目录缓存按 Key/Endpoint 隔离；过期数据和历史验证显示准确。
- 实际翻译 payload、配置签名与缓存键使用用户当前 provider/model/endpoint；更换模型不会命中旧模型译文。
- 未设置 AI 模型时先提示选择；Google/DeepL 不被模型必填校验错误拦住。

执行 `npm test`、`npm run build`、`git diff --check`。检查 `dist/extension-store` 和 `dist/extension-dev` 都包含正确脚本和新 UI；模型发现不得只在 dev build 可见。

浏览器检查至少覆盖：正常输入与选择、无匹配、Key 错误、网络错误、过期响应、provider 切换、设置页/popup 同步、商店版保存。若自动化浏览器不允许操作某页面，不绕过限制，也不把 mock 当作真实 API 实测。

真实服务调用仅使用用户为此明确提供/指定的 Key，通过界面执行短文本诊断，不读取无关凭据。缺少真实 Key 时仍完成 mock、构建和可执行 UI；交付时逐个注明哪些服务有真实测试、哪些仅 mock 覆盖。

最终交付：实现文件清单、配置迁移说明、测试/构建结果、真实服务测试范围、开发版和商店版产物路径、任何仍有影响的限制。不应以“已获取模型列表”代替“翻译可用”验收。

## 13. 官方参考

- OpenAI 模型 API：https://developers.openai.com/api/reference/resources/models
- DeepSeek 模型列表：https://api-docs.deepseek.com/api/list-models/
- Gemini 模型 API 与分页：https://ai.google.dev/api/models
- DeepL 用量与额度：https://developers.deepl.com/api-reference/usage-and-quota/check-usage-and-limits

新模型名字、最新推荐和账户可用性以执行时的官方接口及实际测试为准；不要把文档示例模型 ID 当作新的硬编码默认值。
