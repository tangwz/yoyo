# Yoyo Reading Assistant Browser Extension MVP Design

## 1. 整体架构与模块边界

“悠悠阅读助手”第一版采用 **WXT + Vue 3 + TypeScript**。扩展优先支持 Chrome / Edge 的 Manifest V3，架构上通过薄适配层预留 Firefox / Safari，但第一版不实现这些浏览器的发布与兼容验证。

第一版不是空骨架，也不是完整大平台，而是 **分层平台骨架 + 简化全文翻译垂直切片**。用户可见能力只聚焦手动触发当前页面正文翻译；平台能力覆盖 provider、配置存储、任务编排、content script 页面运行时、popup/options UI、站点规则和隐私边界。

核心模块如下：

- **Extension Shell**：负责 WXT 入口、manifest 权限、background service worker、content script、popup、options page 和右键菜单注册。它只做扩展生命周期和入口编排，不承载业务规则。
- **Browser API Adapter**：封装 `chrome.*` / future `browser.*` 差异。业务模块不直接散落调用浏览器原始 API。
- **Storage & Settings**：负责 provider profile、默认语言、翻译样式、实验开关、site rule 和 UI 偏好。对外提供 typed repository，不让 UI 或任务层直接操作原始 storage key。
- **Provider Layer**：第一版只有 OpenAI-compatible adapter。Provider 只做协议适配，暴露通用文本生成能力，不理解“翻译”业务。
- **Task Orchestrator**：位于 background service worker，负责全文翻译任务、batch、prompt、重试、降级、进度、取消、状态广播和会话缓存。
- **Page Translation Runtime**：位于 content script，负责 root 识别、DOM walker、segment/anchor 生成、硬跳过规则、译文注入、隐藏/显示/移除和页面状态上报。
- **UI Layer**：popup 是当前页面任务控制台，options page 是配置与隐私中心，右键菜单是辅助入口。第一版不做页面常驻悬浮按钮。

模块边界原则：

- content script 管页面，不碰 API key。
- background 管任务和模型调用。
- provider 只管协议，不管翻译语义。
- storage 管配置持久化。
- UI 管用户意图和状态呈现。

后续能力的演进方向：

- 总结复用正文提取、任务编排和 provider。
- 图片翻译复用 provider profile 中的 `visionModel` 配置槽，并新增 image task。
- 视频翻译新增 video task 和可能的 offscreen document，不污染全文翻译主链路。
- 自动翻译扩展 site rule，不改变手动翻译的核心数据流。

## 2. 全文翻译数据流与状态模型

全文翻译以一次显式任务执行。任务必须在收集页面段落之前创建，这样 popup 可以立即显示“正在解析页面”，`collecting` 状态也有真实承载对象。

定稿数据流：

1. 用户从 popup 或右键菜单触发 `translatePage`。
2. background 立即创建 `TranslationTask`，状态为 `collecting`。
3. background 向当前 tab 的 content script 发送 `collectSegments(taskId)`。
4. content script 检查页面是否可处理，做 root 识别和 DOM walker。
5. content script 生成 `PageSegment[]`，内部保存 `segmentId -> anchor` 映射，并返回 segments。
6. background 校验 provider 配置。
7. background 对命中会话缓存的 segment 直接回传译文。
8. background 对未命中部分按字符/token 预算组 batch。
9. Task Orchestrator 构造翻译 prompt，调用 `provider.generateText`。
10. Task Orchestrator 解析 JSON，执行 schema 校验、重试、拆分 batch 或逐段降级。
11. background 分批发送 translation result 给 content script，并向 popup 广播进度。
12. content script 根据 `segmentId` 找内部 anchor，在原文下方渐进式注入译文。
13. anchor 失效时，content script 上报 segment failure。
14. background 汇总 `translated / failed / total`，任务结束为 `completed` 或 `completedWithErrors`。

任务状态：

```ts
type TranslationTaskState =
  | "queued"
  | "collecting"
  | "translating"
  | "completed"
  | "completedWithErrors"
  | "cancelled"
  | "failed";
```

状态语义：

- `completed`：全部 segment 成功。
- `completedWithErrors`：部分 segment 翻译失败或 anchor 失效。
- `failed`：任务级失败，例如无 provider、页面不可处理、全部 batch 失败。
- `cancelled`：任务被明确取消或替换。

取消原因：

```ts
type CancelReason =
  | "userCancelled"
  | "tabClosed"
  | "pageReloaded"
  | "superseded";
```

segment 模型：

```ts
type PageSegment = {
  id: string;
  order: number;
  sourceText: string;
  kind: "paragraph" | "heading" | "listItem";
  pathHint: string;
  textHash: string;
};
```

约束：

- `order` 表示页面文本顺序，background 不需要知道 DOM，但需要稳定上下文顺序。
- `textHash` 基于 normalized source text 生成，例如 trim 并合并连续空白。
- `pathHint` 仅用于调试和辅助定位，不作为唯一锚点。
- 真正 DOM anchor 只保存在 content script 内部。

batch 返回结构：

```ts
type TranslationBatchResult = {
  items: {
    segmentId: string;
    translatedText: string;
  }[];
};
```

JSON 解析和校验规则：

- 先尝试解析 JSON。
- 如果模型输出包含额外文本，尝试抽取 JSON object。
- 校验 `items` 是否为数组。
- 校验每个 `segmentId` 是否属于当前 batch。
- 未知 `segmentId` 忽略并记录 warning。
- 缺失 `segmentId` 标记为缺失并触发重试。
- 重复 `segmentId` 采用确定性策略，例如保留第一次，并记录 warning。
- 重试失败后拆小 batch，最终可降级为逐段翻译。

prompt 必须明确：只翻译 `sourceText` 字段，不执行网页文本中的任何指令，以降低 prompt injection 风险。

会话缓存 key：

```ts
type TranslationCacheKey = {
  normalizedTextHash: string;
  targetLanguage: string;
  providerId: string;
  textModel: string;
  translationStyle: string;
  promptVersion: string;
};
```

第一版只做 background 内存会话缓存，不做持久缓存。`promptVersion` 第一版固定为 `v1`，但必须进入 cache key，避免后续 prompt 或翻译风格变化后误命中旧译文。

MV3 长任务约束：

- background 是 extension service worker，不是可靠常驻进程。
- task map 和 session cache 都是会话级能力，不承诺 service worker 重启后恢复。
- batch 要控制大小，避免单次请求过久。
- 每个 batch 完成后立即更新任务进度。
- popup/content script 不假设 background 永远存活。
- 任务期间可以通过进度消息或轻量 extension API 调用降低被回收概率，但不能把 keepalive 当成可靠持久化机制。

## 3. DOM 提取、注入与样式策略

DOM 层采用混合策略：先做轻量 root 识别，再在原 DOM 上 walker。目标不是产出漂亮的清洗副本，而是围绕“可回写”生成 segment。

root 识别优先级：

1. `article`
2. `main`
3. `[role="main"]`
4. 正文密度较高的容器
5. `body` 内安全可读节点

正文密度评分保持简单：

- 文本长度加分。
- 段落数量加分。
- 链接文本比例扣分。
- 按钮、表单数量扣分。

第一版只要求普通文章、博客、文档和新闻页稳定，不追求复杂网页清洗。

walker 规则：

- 只生成可回写 segment。
- 优先提取叶子级可读 block。
- 避免父子重复提取。
- 如果父节点内部已经存在可提取的 `p`、`li`、`h1-h6` 或 block segment，则父容器不再生成 segment。
- 默认翻译标题、段落、列表项和短正文块。
- 第一版跳过复杂表格。

硬跳过规则：

- `script`
- `style`
- `noscript`
- `pre`
- `code`
- `textarea`
- `input`
- `button`
- `select`
- `contenteditable`
- `svg`
- `canvas`
- `iframe`
- `video`
- `audio`
- `table`
- `thead`
- `tbody`
- `tr`
- `td`
- `th`
- `[hidden]`
- `[aria-hidden="true"]`
- 不可见节点
- 扩展自身注入节点
- `chrome://`
- `edge://`
- `about:*`
- `chrome-extension://`
- `file://`，除非后续用户显式授权

译文注入不改写原文，只在原节点后插入统一包裹结构。注入节点不复制原节点的 class list，避免触发站点样式或脚本的副作用；但会在注入时读取原节点的 computed style，并将关键排版属性写入译文节点的 CSS variables 或 inline style，使译文尽量保持与原段落一致的视觉设计。

```html
<div
  data-yoyo-translation
  data-yoyo-segment-id="seg_xxx"
  data-yoyo-task-id="task_xxx"
>
  <div data-yoyo-translation-inner>
    Translated text...
  </div>
</div>
```

默认样式遵循 source-compatible 原则：

- 译文位于原文下方。
- 译文默认复用原节点的关键 computed style，包括 `font-family`、`font-size`、`font-weight`、`font-style`、`line-height`、`letter-spacing`、`color`、`text-align` 和 `writing-mode`。
- 当原节点有非透明背景色、边框圆角或 padding 时，译文节点可以镜像这些计算值，以适配深色背景、彩色块、引用块等复杂阅读环境。
- 不使用扩展自己的品牌色作为网页内译文颜色。
- 不默认降低 opacity，避免在深色背景或低对比页面上损害可读性。
- 间距只做最小必要调整，优先基于原节点行高和 margin 计算。
- 使用 `white-space: pre-wrap`，保留模型返回中的换行。
- 不使用明显竖杠。
- 不使用大色块、卡片化、fixed 悬浮或强边框。
- 隐藏状态通过 `data-yoyo-hidden="true"` 控制。

扩展的视觉风格只用于 popup 和 options page；网页内译文应融入原页面阅读环境，而不是展示扩展品牌。

content script 内部运行态：

```ts
type SegmentRuntimeAnchor = {
  segmentId: string;
  sourceNode: Element;
  taskId: string;
  insertedNode?: HTMLElement;
};
```

恢复操作语义：

- `hideTranslations`：不删除节点，只隐藏已有译文，不重新请求模型。
- `showTranslations`：恢复显示已有译文，不重新请求模型。
- `removeTranslations`：删除译文节点并清理当前页面运行态。

重复翻译策略：

- 用户重新触发翻译时，旧任务按 `superseded` 取消。
- 删除旧译文节点。
- 清理旧 anchor 运行态。
- 重新 collect segments。
- 启动新任务。

tab 刷新后 content script 运行态自然丢失，第一版不做恢复。

## 4. Provider、配置与隐私边界

第一版 provider 采用 OpenAI-compatible adapter。用户通过 provider profile 配置模型服务。Provider preset 只是填表模板，运行时只使用用户创建的 provider profile。

Provider preset：

```ts
type ProviderPreset = {
  id: string;
  name: string;
  type: "openai-compatible";
  defaultBaseUrl: string;
  defaultTextModel?: string;
  defaultVisionModel?: string;
};
```

Provider profile：

```ts
type ProviderProfile = {
  id: string;
  displayName: string;
  presetId?: string;
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  textModel: string;
  visionModel?: string;
  requestParams?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
};
```

存储策略：

- `chrome.storage.local` 保存 provider profiles、active provider、API key、baseURL、models、request params、site rules 和 experimental flags。
- `chrome.storage.sync` 只保存低敏 UI 偏好，例如 UI language、theme、popup display preference。
- site rule 默认放 local，因为域名规则可能暴露用户访问习惯。

`chrome.storage.local` 只表示本地保存和不跨设备同步，不代表系统级加密保险箱。第一版不实现额外密钥加密，也不声称 API key 已加密保存。options page 中必须明确说明：API key 保存在浏览器扩展本地存储，不跨设备同步；当用户发起翻译时，API key 仅用于请求用户配置的模型服务商。

Provider Layer 只做协议适配：

- request URL
- headers
- body
- timeout
- abort signal
- response normalization
- provider-level error mapping

Provider 层接口：

```ts
interface ProviderAdapter {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
}
```

后续可扩展 vision 接口，但第一版不实现图片翻译链路：

```ts
interface VisionCapableProviderAdapter extends ProviderAdapter {
  generateVision?(request: GenerateVisionRequest): Promise<GenerateTextResponse>;
}
```

翻译语义不进入 Provider Layer。以下逻辑属于 Task Orchestrator：

- segment batching
- translation prompt
- target language
- JSON schema instruction
- JSON tolerant parsing
- retry / split batch / single segment fallback
- translation result mapping
- session cache
- task progress and cancellation

标准化 provider 错误：

```ts
type ProviderErrorCode =
  | "unauthorized"
  | "rateLimited"
  | "quotaExceeded"
  | "timeout"
  | "networkError"
  | "invalidResponse"
  | "serverError"
  | "aborted"
  | "unknown";
```

UI 不直接展示原始 HTTP 错误，而是根据标准错误给出可理解提示，例如 API key 无效、请求超时、模型服务限流、额度耗尽或服务端异常。

第一版暴露的请求参数只包括：

- `timeoutMs`
- `temperature`
- `maxTokens`

不暴露 `top_p`、penalty、seed、response format、reasoning effort 等高级参数。

隐私默认策略：

- 只有用户手动触发时才提取并发送当前页文本。
- 第一版不自动翻译。
- site rule 模型预留白名单自动翻译，但 UI 不启用自动翻译。
- 内置黑名单和受限页面跳过。
- options page 明确提示：翻译会把提取出的网页文本发送到用户配置的 provider。
- popup 在触发前展示本次页面预估发送段落数和目标 provider/baseURL 摘要。
- API key 不进入 content script。
- API key 不注入页面上下文。
- 不做账号系统。
- 不做自有云同步。
- 不做持久翻译缓存。

## 5. UI 与设置页设计

第一版 UI 分为 popup、右键菜单和 options page。页面内不做常驻悬浮按钮，避免在所有网站注入可见 UI。

### Popup

popup 是当前 tab 的任务状态视图，不作为任务状态的唯一来源。打开 popup 时同时查询：

1. background：当前 tab 是否有 task。
2. content script：当前页面是否已有 yoyo 注入节点。

这样即使 MV3 service worker 回收导致 background task map 丢失，只要页面上仍有译文，popup 仍可显示：

- 已检测到当前页面存在译文。
- 隐藏译文。
- 移除译文。
- 重新翻译。

popup 状态：

- 未配置 provider。
- 页面不可翻译。
- 可翻译。
- 翻译中。
- 已完成。
- 完成但有错误。

popup 内部区域：

- `PageStatusCard`
- `LanguageSelector`
- `ProviderInfo`
- `ActionButtonGroup`
- `ProgressView`
- `ErrorSummary`
- `PopupFooter`

未配置 provider 时，主按钮变为“打开设置”。可翻译时，主按钮为“翻译当前页面”。

popup 的默认可翻译态采用 Reader Focus v5 布局：

1. 标题：`悠悠阅读助手`。
2. 语言选择：源语言下拉、方向箭头、目标语言下拉。
3. 翻译服务：显示 active provider profile 的名称和 baseURL 摘要。
4. 主按钮：大号 `翻译当前页面`。
5. 底部工具栏：左侧 `设置`，中间显示版本号，右侧 `更多` 下拉。

语言选择区必须是控件形态，而不是静态信息卡：

- 源语言第一版默认为 `自动检测`，但 UI 预留下拉选择。
- 目标语言第一版默认为 `简体中文`，并通过下拉选择预留多语言支持。
- 源语言和目标语言中间显示方向箭头。
- 语言控件不需要在第一版实现完整语言管理系统，但组件边界要支持后续扩展语言列表。

popup 不显示右上角状态 pill。当前页面是否可翻译通过主按钮状态、错误摘要和任务状态区域表达。

popup 打开时或用户进入 popup 时，可以执行轻量估算，只返回：

```ts
type PageTranslationEstimate = {
  canTranslate: boolean;
  estimatedSegments: number;
  estimatedChars: number;
};
```

轻量估算不建立正式 anchor，不返回完整 `PageSegment[]`。正式 anchor 只在用户触发翻译后的 `collectSegments(taskId)` 阶段生成。

触发前 popup 显示透明提示，例如：

- 将发送约 32 段文本。
- 翻译服务：OpenAI Compatible / api.example.com。

这不是强确认弹窗。

翻译中显示：

- `translated / total / failed`
- 取消按钮

完成后操作层级：

- 主按钮：重新翻译
- 底部工具栏左侧：隐藏译文 / 显示译文
- 更多菜单：移除译文、重新翻译、打开设置等次级操作

底部工具栏语义：

- 左侧是当前主要辅助动作。默认可翻译态为 `设置`；翻译完成后可变为 `隐藏译文` 或 `显示译文`。
- 中间固定展示扩展版本号，例如 `0.1.0`。
- 右侧 `更多` 打开次级菜单。
- `隐私说明` 不作为 popup 主体按钮出现；隐私信息放在 options page 的 Privacy 区域，必要时可从 `更多` 进入。

`completedWithErrors` 展示简短摘要，例如：

- 翻译完成，3 段失败。
- 原因：部分段落解析失败 / 页面内容变化 / 请求超时。

第一版不在 popup 展示完整日志。

### 右键菜单

右键菜单只提供辅助入口：

- `Translate this page`

第一版不做划词翻译入口。右键菜单触发成功后直接开始任务；失败时用轻量 notification 提示，例如当前页面无法翻译或请先配置 provider。扩展图标 badge 可以作为 V0.2 选项，不压进 MVP。

### Options Page

options page 采用分区单页，不做多路由。

#### Provider

能力：

- 创建 provider profile。
- 编辑 provider profile。
- 使用 preset 填表。
- 测试连接。

测试连接只发送固定短文本，不读取网页内容。测试状态包括：

- 未测试。
- 测试中。
- 测试成功。
- 测试失败：API key 无效 / 请求超时 / 模型不存在 / 服务端异常。

API key 旁边必须明确说明：保存在浏览器扩展本地存储，不跨设备同步，不声称加密。

#### Translation

第一版配置：

- 源语言默认自动检测，popup 中以可下拉控件展示。
- 目标语言默认简体中文，popup 中以可下拉控件展示。
- 显示方式：原文下方显示译文，并尽量保持与原段落一致的排版样式。
- `translationStyle = "default"`，用于 cache key 和后续扩展。

#### Privacy

隐私说明控制在清晰短句：

- 只有你手动触发翻译时，扩展才会提取当前页面文本。
- 提取出的文本会发送到你配置的模型服务商。
- API key 保存在浏览器扩展本地存储，不跨设备同步。
- API key 不会进入 content script，也不会注入网页。
- 扩展不提供账号系统，不上传配置到自有云端。
- 第一版不保存持久翻译缓存。

Privacy 区域提供 site blacklist 管理。site whitelist auto-translate 只在数据模型预留，第一版不启用自动翻译 UI。

#### Advanced

第一版 Advanced 保持克制：

- `timeoutMs`
- `temperature`
- `maxTokens`
- 扩展翻译更多可见文本的实验开关
- prompt version
- 清理当前会话状态

“清理当前会话状态”只清理 background 内存任务状态、当前 tab 译文状态和会话缓存，不表示清理持久缓存。

视觉方向：

- popup 和 options page 使用 Reader Focus v5 方向：现代浅色、紫蓝主按钮、清晰控件边界。
- 网页内译文不使用 popup 的品牌色，继续遵循 source-compatible 样式镜像。
- 工具型。
- 克制。
- 信息密度适中。
- 不做营销页。
- 不做夸张卡片化布局。
- 按钮使用明确动作文案。

## 6. 测试、验收与非目标范围

第一版验收目标：在 Chrome / Edge 上，用户能配置 OpenAI-compatible provider，手动触发当前页面正文翻译，看到译文渐进式插入到原文下方，并能隐藏、显示、移除、重新翻译。失败时任务不会静默卡死，popup 能给出可理解状态。

### Unit Tests

覆盖纯逻辑模块：

- provider profile validation
- storage repository key mapping
- provider error normalization
- normalized text hash
- batch splitting
- JSON tolerant parsing and schema validation
- cache key composition with `translationStyle` and `promptVersion`
- task state transitions
- cancel reasons

### DOM Runtime Tests

用 DOM fixture 覆盖 content script 关键逻辑：

- root selection priority
- skip rules，包括 `code`、`table`、`svg`、`iframe`、hidden、aria-hidden
- parent/child duplicate extraction prevention
- segment order stability
- translation node injection structure
- source-compatible style mirroring, including dark background and custom article style fixtures
- injected translation does not use extension brand color inside webpage content
- hide/show/remove semantics
- repeated translate removes old nodes before new collect

### Integration Tests

用 mocked provider 跑端到端：

- popup or command triggers task
- background creates task before collect
- content script returns segments
- background batches and returns translations
- progressive injection works
- `completedWithErrors` when some segments fail
- `superseded` when user starts translate again
- provider request timeout leads to `failed` or `completedWithErrors`
- user cancellation aborts in-flight provider request through `AbortController`

### Manual Browser QA

至少检查真实页面：

- popup 默认态包含源语言下拉、方向箭头、目标语言下拉、翻译服务、大号主按钮和底部版本号工具栏。
- 普通博客文章。
- 技术文档页。
- 新闻文章。
- 长文章页面，确认 batch、进度、渐进式注入和取消正常。
- GitHub README 或 issue 页。
- 含代码块页面，确认代码不被翻译。
- 含表单页面，确认输入区域不被翻译。
- 受限页面，确认提示可理解。

### Security / Privacy Checks

检查项：

- API key 不出现在 content script message payload。
- content script 不直接发 provider 请求。
- popup 预估不读取或保存完整 segment anchor。
- provider test 只发送固定测试文本。
- `chrome.storage.sync` 不保存 provider profile、site rule 或 API key。
- 日志中不打印 API key。
- 日志中不打印完整 provider profile。
- 日志中不打印完整网页正文。

### Engineering Acceptance

工程级验收：

- `pnpm typecheck` 通过。
- `pnpm lint` 通过。
- `pnpm test` 通过。
- `pnpm build` 通过。
- Chrome MV3 打包产物可加载。
- Edge 可加载同一构建产物或兼容构建产物。

### Non-goals

第一版明确不做：

- 自动翻译。
- 划词翻译。
- 图片翻译。
- 视频翻译。
- 全文总结。
- 持久翻译缓存。
- 多 provider adapter。
- 页面悬浮按钮。
- 复杂表格翻译。
- 替换原文模式。
- Safari 实现。
- Firefox 实现。
- 账号系统。
- 自有云同步。
- 后端服务。
- 系统级密钥链或额外加密。
- service worker 重启后的任务恢复。
- 浏览器刷新后的任务恢复。

### Known Risks

已知风险：

- MV3 service worker 可能中止长任务；MVP 通过小 batch、进度消息和会话级状态降低风险，但不承诺重启恢复。
- DOM 提取对复杂 SPA 和非文章页面不保证完美；默认模式优先稳定可撤销。
- source-compatible 样式镜像无法覆盖所有站点 CSS 和动态主题变化；MVP 只镜像关键 computed style，不复制站点 class，不承诺像原站原生内容一样参与所有响应式规则。
- OpenAI-compatible 不代表所有 provider 行为一致；通过标准化错误、JSON 容错和 batch 降级缓解。
- LLM 可能误译或返回不完整结构；第一版做工程容错，不承诺翻译质量完全一致。
- `storage.local` 不等同于系统级密钥保险箱；第一版只承诺本地保存和不跨设备同步。

### Acceptance Criteria

验收标准：

- 无 provider 时，用户能清楚进入设置页配置。
- popup 默认态包含源语言下拉、方向箭头、目标语言下拉、翻译服务、大号主按钮和底部工具栏；底部工具栏左侧为设置，中间为版本号，右侧为更多。
- provider 测试成功后，普通文章页可以完成翻译。
- 翻译过程中 popup 能显示进度并取消。
- provider timeout 有明确状态，不会静默卡死。
- 用户取消能中断进行中的 provider 请求。
- 翻译完成后，hide/show/remove/retranslate 都可用。
- 网页内译文不使用扩展品牌色，能在普通浅色文章、深色文章和彩色内容块中保持与原段落接近的排版和对比度。
- 代码块、表格、表单和隐藏内容不被翻译。
- API key 只存 local，且不进入 content script。
- 右键菜单能发起翻译；失败时有 notification。
- 部分失败时结束为 `completedWithErrors`，不是整体卡死。
- Chrome / Edge 能加载构建产物并完成主流程手工 QA。

## References

- [Chrome Extensions: Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome Extensions: Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
