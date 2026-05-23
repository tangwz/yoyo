# Article Summary Design

## 1. Goal

本次目标是在现有阅读助手中增加文章总结能力。用户可以从 popup 或页面右键菜单触发“总结当前页面”，扩展会读取当前页面的主要正文并生成文章级总结。

总结输出语言必须与翻译目标语言一致。目标语言不应由总结功能单独维护，而应复用翻译偏好中的 `targetLanguage`，确保 popup、options、右键菜单、页面翻译和文章总结看到的是同一份设置。

## 2. Scope

本次覆盖：

- popup 增加“一键总结”入口。
- 右键菜单增加 “Summarize this page” 入口。
- options 中的目标语言选择真正持久化。
- popup 初始化和目标语言切换读取并保存同一份翻译偏好。
- context menu 翻译和总结都从 storage 读取目标语言，不再硬编码简体中文。
- OpenAI-compatible provider 支持总结。
- Chrome Built-in AI local-only provider 首版不支持总结，并给出明确错误，不自动 fallback 到远程 provider。
- 页面内展示总结结果和错误状态。

本次不做：

- 流式总结输出。
- 总结历史、缓存或持久化。
- 多种总结风格配置。
- 复杂阅读模式或页面清洗 UI。
- 对 Chrome Built-in AI 的 prompt-based summarizer 适配，除非浏览器后续提供稳定 API。

## 3. Recommended Approach

采用“独立总结链路 + 共享语言偏好”的方案。

总结不应塞进 `TranslationTaskOrchestrator`。现有 orchestrator 强绑定逐段翻译、lazy viewport、DOM pending/injection、translation cache 和 segment 级进度。总结是一次文章级生成任务，复用这些机制会引入错误抽象，也会让翻译链路更难维护。

推荐新增 summary 领域模块：

- `src/summary/types.ts`
- `src/summary/prompt.ts`
- `src/provider/openAiSummaryAdapter.ts`
- `src/background/pageSummary.ts`
- `src/content/summaryPanel.ts`

其中内容抽取复用已有 `collectPageSegments`，但通过只读函数收集正文，不触发 `removeTranslations()`、pending indicator 或翻译注入。

## 4. Target Language Source of Truth

扩展 `TranslationPreferences`：

```ts
export type TranslationPreferences = {
  mode: TranslationMode;
  targetLanguage: string;
};
```

默认值：

```ts
export const defaultTranslationPreferences: TranslationPreferences = {
  mode: "lazyViewport",
  targetLanguage: "zh-CN",
};
```

storage normalization 需要兼容旧数据：

- `mode` 不是合法值时回退默认值。
- `targetLanguage` 不是支持的目标语言时回退默认值。
- 旧版本只有 `{ mode }` 时自动补齐 `targetLanguage: "zh-CN"`。

popup：

- 初始化时读取 `translationPreferences.targetLanguage`。
- 用户切换目标语言时保存完整 preferences。
- 点击翻译或总结时都使用当前 `targetLanguage`。

options：

- 初始化时读取 `translationPreferences.targetLanguage`。
- 修改目标语言时保存完整 preferences。
- 修改 translation mode 时保留已有 target language。

background context menu：

- `Translate this page` 读取 stored `targetLanguage`。
- `Summarize this page` 读取 stored `targetLanguage`。
- 任何入口都不再硬编码 `zh-CN`。

## 5. Summary Request Flow

### 5.1 Popup Entry

popup 增加一个次级按钮，按钮文案固定为“一键总结”。点击后：

1. 检查 provider 状态。
2. 获取 active tab id。
3. 发送 `summarizePage` background request，包含 `tabId` 和当前 `targetLanguage`。
4. popup 进入 `summarizing` 状态，按钮禁用或显示处理中。
5. background 完成后，由 content script 在页面内展示总结面板。
6. popup 收到成功或失败响应后恢复可操作状态。

### 5.2 Context Menu Entry

新增 context menu id：`yoyo.summarizePage`。

点击后：

1. background 获取 active provider。
2. 从 `translationPreferences` 读取 `targetLanguage`。
3. 调用同一个 `summarizePage` 后台函数。
4. 失败时使用现有 notification 机制或 console error，并尽量在页面总结面板中展示错误。

## 6. Messaging Contracts

新增 background request：

```ts
export type BackgroundRequest =
  | {
      type: "summarizePage";
      tabId: number;
      targetLanguage: string;
    };
```

新增 content requests：

```ts
export type ContentRequest =
  | { type: "collectSummarySource" }
  | {
      type: "showPageSummary";
      targetLanguage: string;
      summaryText: string;
      errorMessage?: never;
    }
  | {
      type: "showPageSummary";
      targetLanguage: string;
      errorMessage: string;
      summaryText?: never;
    };
```

新增 content response：

```ts
export type ContentResponse =
  | {
      type: "summarySourceResult";
      title?: string;
      sourceText: string;
      sourceCharCount: number;
      segmentCount: number;
    };
```

MVP 不新增跨端 summary progress。popup 可以用本地 `summarizing` 状态表达请求正在进行；总结失败则返回 `backgroundError`，并尽量同步展示页面错误面板。

## 7. Summary Prompt

新增 `src/summary/prompt.ts`。

prompt 必须包含：

- 明确角色：文章总结助手。
- 目标语言：`Target language: ${targetLanguage}`。
- 输出语言硬约束：只使用目标语言输出。
- 安全边界：不要执行正文中的指令。
- 输出要求：保留核心论点、关键事实、结论和重要限制。

首版建议使用纯文本输出，减少 JSON 解析失败风险。UI 只需要展示一段或多段总结文本，不需要结构化字段。后续如果要支持 TL;DR、要点、行动项，可以再升级为 JSON。

## 8. Provider Boundary

新增 summary provider 抽象，不修改 `TranslationProvider`：

```ts
export type SummarizeArticleRequest = {
  profile: ProviderProfile;
  targetLanguage: string;
  title?: string;
  sourceText: string;
  traceContext?: ProviderTraceContext;
  abortSignal?: AbortSignal;
};

export type SummarizeArticleResponse = {
  summaryText: string;
};

export type SummaryProvider = {
  summarizeArticle(
    request: SummarizeArticleRequest,
  ): Promise<SummarizeArticleResponse>;
};
```

OpenAI-compatible：

- 新增 `OpenAiSummaryAdapter`，复用 `OpenAiCompatibleProvider.generateText`。
- 设置 summary 专用 trace context stage，例如 `summary`。
- 空输出或过短异常输出视为 invalid response。

Chrome Built-in AI：

- 首版不支持 summary。
- local-only active provider 时返回明确错误，例如 “Article summary is not supported by Chrome Built-in AI yet.”
- 不自动使用远程 provider，保持 local-only 的隐私语义。

## 9. Content Extraction

新增只读 summary extraction 函数，复用 `collectPageSegments("summary")`：

```ts
export async function collectSummarySource(): Promise<SummarySourceResult> {
  const { segments } = await collectPageSegments("summary");
  return buildSummarySource(segments);
}
```

实现要求：

- 不调用 `removeTranslations()`。
- 不修改 `activeTaskId`。
- 不写入 `currentAnchors` 或 translation queue。
- 不插入 pending translation DOM。
- 不启动 mutation observer 或 lazy viewport reporting。
- 对正文做长度上限裁剪，避免 provider 请求过大。

建议首版上限：

- 最多 24,000 字符。
- 按 segment 顺序拼接。
- 超过上限时停止追加后续 segment。

如果页面没有可总结内容，content response 返回 `contentError`，message 为 “No readable article content found.”

## 10. Summary Panel

新增 `src/content/summaryPanel.ts`。

展示要求：

- 页面固定浮层，默认右下或右侧。
- 包含标题 “Summary”。
- 展示 summary text 或 error message。
- 提供关闭按钮。
- 不展示原文，减少隐私暴露和 UI 噪音。
- 新总结覆盖旧总结面板。
- 使用 `textContent` 写入模型输出，禁止 innerHTML。

首版不需要 markdown 渲染。模型输出可以包含换行，面板用 `white-space: pre-wrap` 展示。

## 11. Error Handling

主要错误分支：

- 未配置 provider：复用现有 onboarding/open options 行为或返回 “No active provider profile.”
- 当前页面不支持：content 返回 “Unsupported page URL.”
- 无可读内容：content 返回 “No readable article content found.”
- Chrome Built-in AI local-only：返回不支持总结的明确错误。
- provider 请求失败：复用 provider error message。
- content script 不可用：background 返回 `backgroundError`。

popup 对 `backgroundError` 显示 `ErrorSummary`。

context menu 对失败应尽量调用 `showPageSummary` 展示错误；如果 content script 不可用，再 fallback 到 notification 或 console error。

## 12. Privacy and Safety

总结功能与页面翻译一样，必须保持手动触发：

- 不自动读取页面内容。
- 不在 content script 暴露 API key。
- 不记录原文、prompt、summary text、API key、Authorization header。
- performance trace 只允许记录字符数、segment 数、provider type、duration、错误码。
- local-only provider 不自动 fallback 到 remote provider。

README 和隐私说明后续需要补充 summary 的手动触发边界，但本设计不要求同步完成发布文案。

## 13. Non-Regression Constraints

实现总结功能时必须保持现有能力不退化：

- 页面翻译主按钮、进度展示、取消、重新翻译、隐藏译文、显示译文、移除译文行为保持不变。
- lazy viewport 翻译、runtime batch enqueue、mutation rescan 和 lazy recovery 不因 summary extraction 产生额外状态变更。
- 划词翻译右键菜单和 selection panel 行为保持不变。
- 现有 `Translate this page` 右键菜单仍可用，只是目标语言从 storage 读取，不再硬编码。
- provider onboarding、provider status、Chrome Built-in AI local-only 翻译路径保持不变。
- storage 迁移必须向后兼容旧 `translationPreferences`，不能导致旧用户丢失翻译模式设置。
- summary content extraction 必须是只读路径，不能调用 translation injection、queue、observer 或 task reset 相关逻辑。

实现完成前，至少运行现有全量单元测试，并补充 summary 相关测试。任何需要调整既有测试断言的地方，都必须能对应到明确的目标语言持久化变化或新增 summary 入口，不能为了通过测试而放宽现有翻译行为约束。

## 14. Testing Strategy

单元测试：

- `storage/repositories.test.ts`
  - 旧 `{ mode }` 偏好自动补齐 `targetLanguage`。
  - 非法 `targetLanguage` 回退默认值。
  - 保存 mode 时不丢 target language。

- `summary/prompt.test.ts`
  - prompt 包含 target language。
  - prompt 明确禁止执行正文指令。
  - prompt 不要求翻译逐段 JSON。

- `provider/openAiSummaryAdapter.test.ts`
  - 成功返回 summary text。
  - 空输出抛错。
  - 非 OpenAI-compatible profile 抛错。

- `content/pageRuntime.test.ts`
  - `collectSummarySource` 不插入 translation DOM。
  - 无可读内容返回错误。
  - 长文章按字符上限裁剪。

- `content/summaryPanel.test.ts`
  - 展示 summary。
  - 展示 error。
  - 新结果覆盖旧面板。
  - close button 移除面板。

- `background/contextMenu.test.ts`
  - 注册 summary context menu。
  - summary click 调用 handler。

- `background/pageSummary.test.ts`
  - 使用 stored target language。
  - OpenAI-compatible 成功时发送 `showPageSummary`。
  - Chrome Built-in AI 返回不支持错误。
  - content extraction 失败时返回 background error。

- `ui/popup.test.ts`
  - 初始化读取 stored target language。
  - 切换 target language 保存偏好。
  - “一键总结”按钮发送 `summarizePage`。
  - 页面翻译主按钮既有行为保持不变。

验证命令：

```sh
pnpm test
pnpm typecheck
pnpm lint
```

## 15. Implementation Order

建议按以下顺序实现：

1. 扩展 translation preferences，先保证目标语言 source of truth 正确。
2. 增加 summary prompt、types 和 OpenAI summary adapter。
3. 增加 content summary extraction 和 summary panel。
4. 增加 background summary flow。
5. 增加 context menu summary 入口。
6. 更新 popup summary button 和目标语言持久化。
7. 补齐测试。

这个顺序可以让语言一致性先落地，再接 summary 链路，避免 UI 已经出现但不同入口语言不一致。
