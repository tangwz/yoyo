# Chrome Built-in AI Provider Design

## 背景

Yoyo Reading Assistant 当前是 Chrome / Edge MV3 阅读翻译插件，核心能力是用户配置 OpenAI-compatible provider 后，手动触发全文翻译、渐进式注入译文，并保持明确的隐私边界。现有 provider 抽象主要围绕远端 LLM 的 `generateText` 能力设计。

Chrome Built-in AI 不是一个统一的远端 LLM endpoint，而是一组浏览器内置能力。对当前 Yoyo 主链路最相关的是 Chrome `Translator API`；未来 `Prompt API` 可以用于总结、问答、改写等能力，但不进入第一版实现范围。

本设计目标是新增一个零配置、本地-only 的 `Chrome Built-in AI` provider，使全文翻译和划词翻译可以在支持的桌面 Chrome 中使用本地翻译能力，同时保留未来接入 `Prompt API` 的抽象空间。

## 目标

- 新增 `Chrome Built-in AI` 作为独立 provider，与 OpenAI-compatible provider 并列。
- `Chrome Built-in AI` 不要求用户填写 Base URL、API Key、model name 或其他模型参数。
- 第一版通过 Chrome `Translator API` 支持全文翻译和划词翻译。
- 划词翻译第一阶段通过 context menu 触发；浮动按钮只预留架构，不实现完整 UI 生命周期。
- Built-in AI provider 是 local-only：不可用时失败，不自动 fallback 到远端 provider。
- Provider 页面明确提示：需要桌面 Chrome 138 或更高版本。
- 任务执行前检查 API、浏览器、语言对和模型下载状态。
- 引入 capability-based provider 边界，避免把 `Translator API` 强行包装成 `generateText(prompt)`。

## 非目标

- 不实现 `Prompt API` 的总结、问答、改写能力。
- 不实现图片翻译、视频字幕翻译。
- 不实现自动远端 fallback。
- 不实现自动后台模型下载。
- 不新增 Built-in AI 专属语言配置。
- 不实现浮动划词按钮的完整交互。
- 不支持移动端 Chrome。
- 不承诺 Edge 支持，除非后续实测确认对应 API 可用。
- 自动化测试不依赖真实 Chrome 本地模型。

## 用户体验

Provider 页面新增一个 provider card：

```text
Chrome Built-in AI
Runs locally in Chrome when supported. No API key required.
Requires desktop Chrome 138 or later.
```

如果当前浏览器不满足基本条件，卡片应不可选或显示明确不可用状态：

```text
Chrome Built-in AI is unavailable.
Requires desktop Chrome 138 or later.
```

选择 `Chrome Built-in AI` 后，不展示配置表单，只展示能力状态：

```text
Status: Checking / Available / Needs model download / Unsupported / Language pair unavailable
```

Popup 中的 provider status 应强调 local-only 语义：

```text
Provider: Chrome Built-in AI
Mode: Local only
Status: Ready / Not available for this language pair / Model download required
```

当 Built-in AI 不可用、语言对不支持或模型下载失败时，UI 必须明确说明没有使用远端 provider。

## 架构

### Provider 类型

现有 provider type 从单一 OpenAI-compatible 扩展为两类：

```ts
type ProviderType = "openai-compatible" | "chrome-built-in-ai";
```

建议将 provider profile 建模为 discriminated union：

```ts
type OpenAiCompatibleProviderProfile = {
  id: string;
  displayName: string;
  presetId?: string;
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  textModel: string;
  visionModel?: string;
  requestParams?: ProviderRequestParams;
};

type ChromeBuiltInAiProviderProfile = {
  id: string;
  displayName: string;
  type: "chrome-built-in-ai";
};

type ProviderProfile = OpenAiCompatibleProviderProfile | ChromeBuiltInAiProviderProfile;
```

`chrome-built-in-ai` profile 不应包含 `baseURL`、`apiKey`、`textModel` 或 `visionModel`。这些字段如果以空字符串存在，会让校验、UI、readiness 和隐私文案变得脆弱。

### Capability-based provider

不要把所有 provider 都统一成 `generateText(prompt)`。第一版应引入窄接口：

```ts
type TranslationProvider = {
  translateText(request: TranslateTextRequest): Promise<TranslateTextResponse>;
  translateBatch?(request: TranslateBatchRequest): Promise<TranslateBatchResponse>;
};

type TextGenerationProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
  streamText?(request: StreamTextRequest): AsyncGenerator<StreamTextChunk>;
};
```

再通过 resolver 根据 profile type 返回翻译 capability：

```ts
type TranslationProviderResolver = {
  getTranslationProvider(profile: ProviderProfile): TranslationProvider;
};
```

- `openai-compatible` 返回 `OpenAiTranslationAdapter`，内部继续构造 translation prompt、调用 `generateText`、解析 JSON。
- `chrome-built-in-ai` 返回 `ChromeBuiltInTranslatorProvider`，直接调用 Chrome `Translator API`。
- 未来 `Prompt API` 可以作为 `TextGenerationProvider` 或新的 capability 接入，不影响当前翻译 provider。

### 任务编排边界

`TranslationTaskOrchestrator` 不应直接依赖 `OpenAiCompatibleProvider`。它应依赖 `TranslationProviderResolver` 或更窄的 `TranslationProvider`，只关心：

- 输入 page segments；
- source language 和 target language；
- active provider profile；
- batch、concurrency、cancellation；
- 输出 `TranslationResultItem[]`；
- 进度、失败计数和 UI 错误摘要。

底层是 OpenAI-compatible JSON prompt、Chrome Translator API，还是未来其他本地翻译能力，不应泄漏到 orchestrator 主流程。

### Built-in AI adapter

`ChromeBuiltInTranslatorProvider` 负责：

- 检测当前 runtime 是否存在 Chrome `Translator API`；
- 检查 source/target language pair 是否可用；
- 处理 `available`、`downloadable`、`downloading`、`unavailable` 等状态；
- 在用户确认后触发本地模型下载；
- 将每个输入 segment 映射为一个输出 translation item；
- 将 Chrome API 错误映射为本地 provider 错误。

第一版不建议把多个 segment 拼成一个大文本再拆分。`Translator API` 不提供 JSON schema 约束，拼接再拆分容易引入边界错误。更稳的策略是按 segment 调用，必要时在 adapter 内部使用小并发，并保证输入输出一一对应。

### Selection translation

划词翻译不应复用全文翻译的 DOM segment pipeline。它是一条轻量链路：

```text
User selects text
  -> context menu "Translate selection"
  -> background receives selected text and tabId
  -> get active provider profile
  -> resolve TranslationProvider
  -> check source/target availability
  -> translate selected text
  -> send result to content script
  -> content script renders lightweight result panel near selection
```

浮动按钮后续复用同一条 background API：

```text
content script detects selection
  -> shows floating action button
  -> user clicks
  -> same translateSelection background request
```

第一阶段只实现 context menu 触发。消息协议和 content-side result panel 应预留给后续 floating button 复用。

## 数据流

### 全文翻译

```text
Popup / context menu
  -> background translatePage
  -> get active provider profile
  -> collectSegments in content script
  -> resolve TranslationProvider
  -> check source/target availability
  -> translate batches
  -> applyTranslations in content script
  -> emit progress to popup
```

OpenAI-compatible provider：

```text
segments -> JSON prompt -> generateText -> parse JSON -> TranslationResultItem[]
```

Chrome Built-in AI provider：

```text
segments -> Translator API translate() -> TranslationResultItem[]
```

### 划词翻译

```text
Context menu
  -> background translateSelection
  -> resolve active TranslationProvider
  -> translate selected text
  -> content script showSelectionTranslation
```

Selection translation 使用 active provider。若 active provider 是 `chrome-built-in-ai`，它必须遵守 local-only 语义，不调用远端 provider。

## 浏览器版本与可用性

`Chrome Built-in AI` provider 的第一层门槛是桌面 Chrome 138 或更高版本。

判断策略：

- Chrome `< 138`：不可选择，展示版本要求。
- Desktop Chrome `>= 138`：允许进入 runtime detection。
- Firefox：不可选择。
- Edge：默认不可选择或显示 unsupported，除非后续实测确认相关 API 可用。
- 无法可靠读取版本：允许展示卡片，但必须标记为需要 runtime check；选择后如果检测失败，给出明确原因。

版本判断不能替代 runtime detection。任务开始前仍必须检查：

- `Translator API` 是否存在；
- 当前 source/target language pair 是否支持；
- 本地模型是否可用；
- 是否需要下载；
- 下载是否成功；
- 当前任务是否已取消。

## 模型下载策略

当 Chrome API 返回 `downloadable` 时，第一版不自动后台下载模型。UI 应提示用户：

```text
Chrome needs to download a local translation model before translating this language pair.
```

只有用户确认后才触发下载。原因是模型下载可能消耗网络、磁盘和时间；而选择 Built-in AI 的用户通常更关注本地行为和隐私边界。

下载失败时任务失败，不 fallback 到远端 provider。

## 错误模型

新增本地 AI 错误类型，不复用 HTTP provider error：

```ts
type LocalAiErrorCode =
  | "browserUnsupported"
  | "apiUnavailable"
  | "languagePairUnavailable"
  | "modelDownloadRequired"
  | "modelDownloadFailed"
  | "textTooLong"
  | "aborted"
  | "unknown";
```

UI 文案原则：

- 不说 `Provider request failed`，因为没有远端 request。
- 不说 `Network error`，除非确实发生在模型下载阶段。
- 必须明确 `No remote provider was used`。
- 划词翻译失败时在 selection result panel 中直接展示短错误。

示例：

```text
Chrome Built-in AI is not available for English -> Chinese on this browser.
No remote provider was used.
```

## 失败行为

全文翻译：

- Task-level readiness 失败：任务直接进入 `failed`，不继续发送 provider request。
- 模型下载失败：任务进入 `failed`，错误摘要提示下载失败。
- 部分 segment 失败：沿用 `completedWithErrors`。
- 用户取消：任务进入 `cancelled`。
- 第一版 Built-in AI 翻译并发应为 `1` 或很小的值，避免本地模型资源占用和取消语义不稳定。

划词翻译：

- API 不可用、语言对不可用或文本过长时，在 selection panel 显示短错误。
- 文本过长时提示用户缩短选择范围。
- 不在后台静默 fallback 到 OpenAI-compatible provider。

## 模块边界

建议实现时按职责拆分：

```text
src/provider/
  types.ts
  localAiErrors.ts
  chromeBuiltInAi.ts
  translationProvider.ts
  openAiTranslationAdapter.ts
  resolver.ts

src/background/
  taskOrchestrator.ts
  selectionTranslation.ts
  contextMenu.ts
  providerStatus.ts

src/messaging/
  contracts.ts

src/content/
  selection.ts
  selectionPanel.ts

src/storage/
  repositories.ts
  defaults.ts
```

这些文件名是推荐边界，不要求一次性全部新增。核心原则是：

- Chrome raw API detection 和调用集中在 `chromeBuiltInAi.ts`。
- 翻译 capability 定义集中在 `translationProvider.ts`。
- OpenAI-compatible 的 prompt 翻译适配集中在 `openAiTranslationAdapter.ts`。
- 划词翻译由 `selectionTranslation.ts` 单独编排，不污染全文 task orchestrator。
- content-side selection result panel 后续可被 floating button 复用。

## 测试策略

单元测试：

- `chrome-built-in-ai` profile validation 不要求 API Key、Base URL 或 model name。
- readiness 覆盖 Chrome 137、Chrome 138、Firefox、Edge 和 unknown browser。
- translation provider resolver 根据 provider type 返回正确 adapter。
- local AI error 映射为正确 UI 文案。
- selection translation message contract。

集成测试：

- mock `Translator API` 为 `available`，验证全文 translation item 与 input segment 一一对应。
- mock `downloadable`，验证不会自动调用远端 provider，也不会 silent fallback。
- mock language pair unavailable，验证任务失败原因。
- mock selection translation，验证 context menu 链路返回结果。

人工验证命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

浏览器验收：

- Chrome 137 或更低版本：Provider 卡片不可选，并提示 Chrome 138+。
- Chrome 138+ 且 API 可用：可选择 Built-in AI。
- Firefox / Edge：Built-in AI 不可选或显示 unsupported。
- Built-in AI active 时，即使远端 provider 未配置，全文和划词翻译也只依赖本地能力。
- Built-in AI 不可用时不会调用 OpenAI-compatible provider。

## 验收标准

- 用户能在 Provider 页面看到 `Chrome Built-in AI` 和 Chrome 138+ 要求。
- 不支持浏览器不能选择 Built-in AI，或选择后立即得到明确不可用状态。
- 选择 Built-in AI 后无需填写任何配置。
- Built-in AI active 时，全文翻译不会调用 OpenAI-compatible provider。
- 语言对不可用时给出明确错误，不自动 fallback。
- 右键划词翻译复用 active provider。
- Built-in AI active 时，右键划词翻译走本地 Translator API。
- 测试通过 mock adapter 覆盖主要状态，不依赖真实 Chrome 本地模型。

## 关键决策记录

- Built-in AI 作为独立 provider，而不是 Translation 设置里的 engine。
- 第一版采用 local-only 策略，不做 silent fallback。
- 第一版支持全文翻译和右键划词翻译。
- 浮动按钮只预留架构，不进入第一版实现。
- `Translator API` 是一等 translation capability，不强行包装成 `generateText(prompt)`。
- `Prompt API` 只作为未来 capability 预留。
