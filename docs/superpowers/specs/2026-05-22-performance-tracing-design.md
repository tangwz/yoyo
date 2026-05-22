# Performance Tracing Design

## 1. Goal

当前目标是在不引入完整 telemetry 系统的前提下，为页面翻译首屏、lazy 滚动翻译和划词翻译增加低侵入耗时埋点。重点验证慢点是否来自 LLM/provider 调用，并能进一步区分网络、模型首响应、流式输出、JSON 解析、重试、Chrome Built-in AI 初始化或 offscreen 往返。

这个设计只面向开发诊断。默认不记录用户原文、prompt、译文、API key、Authorization header、完整 URL 或其他敏感内容。

## 2. Scope

本次覆盖三条用户感知慢路径：

- 页面翻译首屏：点击翻译后到首批译文插入页面。
- Lazy 滚动翻译：新内容进入 viewport 后到对应译文插入页面。
- 划词翻译：触发划词翻译后到结果面板展示。

本次不做：

- 持久化 telemetry。
- popup/options 诊断 UI。
- 远程上报。
- 性能优化本身。
- 大规模重构 provider 或 task orchestrator。

## 3. Recommended Approach

采用结构化 console tracing。新增一个小型 tracing helper，统一输出 `[yoyo:perf]` 前缀和结构化 metadata。调用点只记录耗时、计数、provider 类型、模型名、状态码、错误码、taskId、batchId、attempt 等安全字段。

相比 `performance.mark()`，console tracing 更适合当前跨 content script、background service worker、offscreen document 的排查场景。相比内置 telemetry buffer，它更轻，不需要 UI、存储或隐私文案变更。

## 4. Trace Helper

新增 `src/utils/perfTrace.ts`，提供两个能力：

- `tracePerf(eventName, metadata)`：输出单条结构化性能事件。
- `measurePerf(eventName, metadata, operation)`：包装 async 操作，自动记录 success/error、durationMs。

启用策略：

- 开发构建默认启用。
- 生产构建默认关闭。
- 首版不增加运行时开关，避免引入 storage 或 UI 变更。后续如需要 beta 用户诊断，再增加显式 opt-in debug flag。

metadata 必须先经过 allowlist/redaction。helper 不接受任意大对象直接透传，避免把 request、profile、prompt 或 Error cause 原样打到 console。

建议事件格式：

```ts
type PerfTraceMetadata = {
  taskId?: string;
  batchId?: string;
  attempt?: number;
  providerType?: "openai-compatible" | "chrome-built-in-ai";
  model?: string;
  status?: number;
  errorCode?: string;
  durationMs?: number;
  segmentCount?: number;
  sourceCharCount?: number;
  outputCharCount?: number;
  chunkCount?: number;
  candidateIndex?: number;
  promptCharCount?: number;
  returnedCount?: number;
  missingCount?: number;
};
```

## 5. LLM and Provider Tracing

LLM/provider 是主观测面。

### 5.1 OpenAI-Compatible Provider

在 `src/provider/openAiCompatible.ts` 和 `src/provider/openAiTranslationAdapter.ts` 增加以下事件：

- `llm.request.start`
  - 记录 model candidate、candidateIndex、timeoutMs、stream、promptCharCount、segmentCount、sourceCharCount。
- `llm.fetch.response`
  - fetch 返回 headers 后记录 durationMs、status、model candidate。
- `llm.response.json.done`
  - 非流式响应 JSON 读取和解析完成后记录 durationMs、outputCharCount、model。
- `llm.stream.firstChunk`
  - 流式首个有效 chunk 到达时记录 durationMs、model。
- `llm.stream.done`
  - 流式完成时记录 total durationMs、chunkCount、outputCharCount。
- `llm.response.parsed`
  - 翻译 JSON 解析完成后记录 expectedSegmentCount、returnedSegmentCount、missingCount、durationMs。
- `llm.retry.modelCandidate`
  - model candidate fallback 时记录 candidateIndex、nextCandidateIndex、errorCode、status。
- `llm.request.error`
  - 请求失败时记录 durationMs、errorCode、status、model candidate、stream。

这些事件用于回答：

- 是否在 fetch 前就慢。
- 是否服务端首响应慢。
- 是否首 chunk 快但完整输出慢。
- 是否输出格式导致解析或 missing segment retry。
- 是否 model candidate fallback 消耗额外时间。

### 5.2 Chrome Built-in AI Provider

在 `src/provider/chromeBuiltInAi.ts` 和 `src/provider/chromeBuiltInAiOffscreenClient.ts` 增加以下事件：

- `localAi.availability.done`
  - 记录 sourceLanguage、targetLanguage、availability、durationMs。
- `localAi.createTranslator.done`
  - 记录 durationMs、sourceLanguage、targetLanguage。
- `localAi.translate.segment.done`
  - 记录 segmentId、segmentOrder、sourceCharCount、durationMs。
- `localAi.translate.batch.done`
  - 记录 segmentCount、sourceCharCount、durationMs。
- `localAi.detectLanguage.done`
  - 记录 sourceCharCount、detectedLanguage、durationMs。
- `localAi.offscreen.ensureDocument.done`
  - 记录 durationMs、createdDocument。
- `localAi.offscreen.request.done`
  - 记录 requestType、durationMs、success。
- `localAi.request.error`
  - 记录 requestType、durationMs、errorName。

这些事件用于区分：

- 模型是否需要下载或初始化。
- translator create 是否慢。
- 单段 translate 是否慢。
- offscreen document 创建或 port 往返是否慢。
- 语言检测是否拖慢划词或首批 lazy 翻译。

## 6. Orchestrator Tracing

在 `src/background/taskOrchestrator.ts` 增加聚合事件：

- `translation.task.start`
  - 页面翻译任务创建时记录 taskId、translationMode。
- `translation.collect.done`
  - content segment collection 返回后记录 segmentCount、sourceCharCount、durationMs。
- `translation.detectLanguage.done`
  - source language resolve 完成后记录 durationMs、sourceLanguage。
- `translation.batch.start`
  - 每个 provider batch 开始时记录 taskId、batchId、attempt、providerType、segmentCount、sourceCharCount、currentConcurrency。
- `translation.batch.done`
  - batch 完成时记录 durationMs、returnedCount、missingCount。
- `translation.batch.missing`
  - provider 返回缺段时记录 missingCount、segmentCount、attempt。
- `translation.batch.retry`
  - batch retry 或 degrade retry 时记录 attempt、reason、segmentCount。
- `translation.batch.apply.done`
  - provider 返回后发送 content apply 并收到结果时记录 durationMs、appliedCount、failedCount。
- `translation.concurrency.changed`
  - rate limit/backoff 调整并发时记录 previousConcurrency、nextConcurrency、reason。

这些事件把 provider 的细粒度日志和用户任务串起来，便于按 taskId/batchId 追踪。

## 7. Content-Side Boundary Tracing

content 侧只做辅助边界，不作为主观测面：

- `content.collectSegments.done`
  - 在 `collectSegments` 返回前记录 durationMs、segmentCount、sourceCharCount、translationMode、visibleRangeOnly。
- `content.queue.flush.start`
  - lazy queue flush 前记录 pending segment 数、retry 数、failed report 数。
- `content.queue.flush.done`
  - background enqueue 返回后记录 durationMs、response state。
- `content.applyTranslations.done`
  - DOM 注入完成后记录 durationMs、itemCount、appliedCount、failedCount。
- `content.selectionPanel.done`
  - 划词结果面板渲染完成后记录 durationMs、success。

这些事件用于排除 DOM 抽取、消息往返和注入渲染问题。

## 8. Selection Translation Flow

`src/background/selectionTranslation.ts` 单独增加划词链路事件：

- `selection.translate.start`
  - 记录 sourceCharCount、sourceLanguage、targetLanguage。
- `selection.profile.done`
  - active profile 获取完成。
- `selection.detectLanguage.done`
  - Chrome Built-in AI auto source language 检测完成。
- `selection.prepareLocalAi.done`
  - Chrome Built-in AI translator 预热完成。
- `selection.provider.done`
  - provider `translateText` 完成。
- `selection.showResult.done`
  - content panel message 完成。
- `selection.translate.error`
  - 失败时记录 stage、durationMs、errorCode。

## 9. Privacy and Safety

禁止记录：

- `sourceText`
- `translatedText`
- prompt
- API key
- Authorization header
- cookies
- 完整 provider URL
- 完整 Error cause 或 request object

允许记录：

- 字符数。
- segment 数量。
- provider type。
- model 名称。
- HTTP status。
- error code/name/status。
- durationMs。
- taskId、batchId、segmentId。

如果后续发现 model 名称或 provider display name 也有隐私风险，可以仅记录 provider type 和 preset id。

## 10. Testing Strategy

单元测试：

- `perfTrace` helper 默认关闭、显式开启、metadata redaction。
- OpenAI-compatible 非流式成功路径输出 start、fetch response、json done、parsed done。
- OpenAI-compatible 流式路径输出 firstChunk 和 stream done。
- OpenAI-compatible model candidate retry 输出 retry 事件。
- Chrome Built-in AI provider 输出 availability、create、segment、batch 事件。
- selection translation 输出按 stage 拆分的事件。

手动验证：

- 页面翻译首屏：确认 console 能按 taskId 看到 collect、batch、LLM、apply 的阶段耗时。
- Lazy 滚动：滚动后确认 queue flush、enqueue、LLM batch、apply 能串起来。
- 划词翻译：确认 detect language、prepare local AI、provider、show result 能串起来。
- 隐私检查：console 中不出现原文、译文、prompt、API key 或 Authorization。

## 11. Expected Diagnostic Outcome

完成后，慢查询可以被归类到以下路径之一：

- DOM/content 慢：`content.collectSegments.done` 或 `content.applyTranslations.done` 明显高。
- background 编排慢：`translation.batch.start` 之前有长空白，或 runtime queue flush 等待明显。
- LLM 首响应慢：`llm.fetch.response` 或 `llm.stream.firstChunk` 明显高。
- LLM 输出慢：first chunk 正常但 `llm.stream.done` 或非流式总耗时高。
- LLM 格式问题：`llm.response.parsed`、`translation.batch.missing`、retry 事件频繁。
- Chrome Built-in AI 初始化慢：`localAi.availability.done`、`localAi.createTranslator.done`、`localAi.offscreen.ensureDocument.done` 明显高。
- Chrome Built-in AI 单段慢：`localAi.translate.segment.done` 中某些段耗时高。

## 12. Rollout

先以开发诊断方式落地，不改变用户可见行为。实现后优先在本地复现 B、C、D 三条路径，确认日志能定位 LLM/provider 具体慢点。若后续需要面向 beta 用户收集诊断，再基于这个 helper 扩展为显式 opt-in 的诊断导出，而不是直接远程上报。
