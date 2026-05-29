# Kiss-like Hardening Milestone Design

## 背景

Yoyo 已经具备完整的阅读助手主干：普通网页翻译、动态页面 runtime、Provider 编排、划词翻译、文章总结和 YouTube 字幕翻译。前面对 `fishjar/kiss-translator` 的能力对比显示，真正值得吸收的不是“复制全部功能”，而是把现有能力打磨成更稳定的三条链路：

- 动态网页翻译 runtime；
- Provider pipeline；
- YouTube 字幕翻译。

这轮不是从零开发 P0-P2，而是把已有实现从“功能已经存在”推进到“行为稳定、边界明确、可验证”。划词翻译不属于 YouTube 字幕链路；如后续继续改进划词翻译，应作为普通网页选择文本入口单独规划。

## 目标

- P0：强化动态网页翻译 runtime，让信息流、短文本、SPA 增量内容在手动翻译任务内稳定被发现、排队、翻译和注入。
- P1：强化 Provider pipeline，让流式、批量、缓存、重试、降级和限流行为有清晰边界和测试保障。
- P2：强化 YouTube 字幕翻译的真实站点稳定性和产品化细节，但不引入划词翻译。
- 保持现有隐私边界：content script 不接触 API key、provider secret 或完整 provider 配置。
- 保持手动触发原则：网页正文翻译不自动发送页面文本；YouTube 字幕仅在用户偏好启用且有可用字幕轨时运行。

## 非目标

- 不复制 KISS Translator 的 GPL 实现。
- 不做油猴脚本、Firefox、Safari、Thunderbird 或移动端适配。
- 不做规则订阅、规则分享、WebDAV 同步或云同步。
- 不做接口 Hook、任意 Provider 脚本或远程规则执行。
- 不做图片翻译。
- 不做无字幕视频 ASR。
- 不做非 YouTube 视频站点。
- 不把划词翻译放进 YouTube player。
- 不在这轮引入字幕下载、生词本、右侧字幕列表或复杂样式编辑器。
- 不改变 API key 只保存在 extension storage/background 边界内的安全模型。

## 总体方案

采用“一个总 milestone，三个子项目”的方案：

- 总设计文档固定边界、优先级和验收标准。
- P0、P1、P2 分别落地，分别测试，避免互相阻塞。
- 实现时优先改已有模块，不引入新的大框架。

原因是当前代码中三条链路已经有主体实现。如果把它们作为一个大重写，风险主要来自回归和抽象膨胀；如果完全拆散，又容易丢失跨链路的一致性，例如缓存 key、trace privacy、取消语义和状态恢复。总 milestone + 子计划能在架构上统一，在实现上保持小步可审阅。

## P0：动态网页翻译 Runtime Hardening

### 当前基础

当前已有：

- `src/content/pageRuntime.ts`
- `src/content/translationQueue.ts`
- `src/content/domExtraction.ts`
- `src/background/taskOrchestrator.ts` 的 `enqueueTranslationBatch`
- `tests/content/pageRuntime.test.ts`
- `tests/content/domExtraction.test.ts`

已有机制包括 viewport-first queue、mutation rescan、visibility observer、lazy recovery、断连节点失败上报和 feed-like DOM 抽取规则。

### 设计方向

P0 不重写 runtime。重点是让现有 runtime 的状态流更可预测：

1. DOM discovery 继续由 `domExtraction` 负责，允许 `article`、`[data-testid="tweetText"]`、`[lang]`、`[dir="auto"]` 等高置信短文本进入候选。
2. Runtime 继续负责任务生命周期、anchor registry、pending marker、mutation dirty roots、visible-first queue 和 runtime-originated batch。
3. Queue 继续按 `viewport -> nearViewport -> normal` 排序，首屏快速 flush，后续批量聚合。
4. Mutation rescan 只处理受影响的最小容器，避免全页反复扫描。
5. React 或 SPA 删除节点时，runtime 应清理 anchor，并将已经无法注入的 segment 上报为 failed，而不是卡住整个任务。

### 验收标准

- 手动翻译信息流页面时，首屏可见内容优先进入翻译请求。
- 滚动加载的新内容在同一个手动任务仍活跃时继续翻译。
- DOM 节点被删除或替换时，不应导致整个任务失败。
- 已翻译内容不会被自身扫描器再次翻译。
- 对普通长文页面的抽取、注入和 lazy 行为不回退。

### 测试范围

- `tests/content/domExtraction.test.ts`：补充 feed-like 短文本、导航噪音、嵌套语言节点和 duplicate handling。
- `tests/content/pageRuntime.test.ts`：补充 mutation debounce、断连节点、visible-first batch、failed segment reporting、task stop cleanup。
- `tests/background/taskOrchestrator.test.ts`：覆盖 runtime-originated batch 的恢复、stale task、collection complete 和 failed ids。
- 浏览器 smoke：使用本地 fixture 模拟信息流增量插入和节点替换。

## P1：Provider Pipeline Hardening

### 当前基础

当前已有：

- `src/background/taskOrchestrator.ts`
- `src/provider/openAiTranslationAdapter.ts`
- `src/provider/openAiCompatible.ts`
- `src/translation/batch.ts`
- `src/translation/cache.ts`
- `src/translation/jsonResult.ts`
- `tests/background/taskOrchestrator.test.ts`
- `tests/provider/openAiTranslationAdapter.test.ts`
- `tests/translation/*`

已有机制包括 batch splitting、streaming NDJSON parsing、missing item retry、batch degrade、single-segment fallback、session cache fan-out、rate-limit concurrency 降级和 trace privacy。

### 设计方向

P1 的核心是收紧 Provider 行为契约，而不是新增大量 Provider 类型：

1. Provider batch 输入输出必须稳定使用 segment id，不依赖返回顺序。
2. Streaming 优先作为首选路径；空 stream、解析失败或缺项时必须进入 fallback，而不是误判成功。
3. Missing items 只重试缺失 segment；重复文本使用 cache fan-out，避免重复调用 Provider。
4. 多次失败后允许拆分 batch，最终降级到 single-segment request。
5. Rate limit 触发后并发降到 1，并在连续成功后恢复到默认并发。
6. Trace metadata 只记录 task id、batch id、segment count、char count、duration、错误类型等，不记录原文或译文。

### 验收标准

- Provider 返回缺项时，任务能只补缺失项。
- Provider streaming 空输出不会被记录为成功 batch。
- Provider 限流时，不会继续并发冲击同一个服务。
- 重复源文本只翻译一次，并能 fan-out 到多个 DOM anchor。
- 取消任务时，in-flight Provider 请求被 abort 或其结果被忽略。
- 所有 trace 不泄露页面文本、选择文本、字幕文本或译文。

### 测试范围

- `tests/background/taskOrchestrator.test.ts`：补充 rate-limit recovery、stream fallback、batch split、single fallback、cache fan-out、cancellation stale result。
- `tests/provider/openAiTranslationAdapter.test.ts`：补充 streaming parser 边界、invalid SSE、unknown ids、duplicate ids。
- `tests/translation/jsonResult.test.ts`：补充 partial NDJSON、malformed line、missing expected ids。
- `tests/translation/hash.test.ts`：确保缓存 key 区分 provider、model、source language、target language、prompt version、formatting-sensitive text。

## P2：YouTube Subtitle Hardening And Product Polish

### 当前基础

当前已有：

- `src/content/youtubeSubtitle/runtime.ts`
- `src/content/youtubeSubtitle/captionParser.ts`
- `src/content/youtubeSubtitle/trackSelection.ts`
- `src/content/youtubeSubtitle/segmentation.ts`
- `src/content/youtubeSubtitle/scheduler.ts`
- `src/content/youtubeSubtitle/sessionCache.ts`
- `src/content/youtubeSubtitle/overlay.ts`
- `src/content/youtubeSubtitle/playerButton.ts`
- `src/background/youtubeSubtitle/service.ts`
- `src/background/youtubeSubtitle/aiSegmentation.ts`
- `src/background/youtubeSubtitle/cache.ts`
- `src/subtitle/types.ts`
- `tests/content/youtubeSubtitle/*`
- `tests/background/youtubeSubtitle/*`
- `tests/browser/youtube-subtitle.spec.mjs`

已有机制包括 YouTube SPA runtime、caption track 选择、`json3` 解析、内置断句、AI 断句、播放窗口预取、双语 overlay、播放器按钮、session cache、background cache、取消和 fixture 浏览器测试。

### 设计方向

P2 按新的模式只处理 YouTube 字幕，不包含划词翻译。

1. Runtime 应在 YouTube 视频页稳定挂载按钮和 overlay，处理 SPA 跳转、player 重建、全屏和剧场模式。
2. 字幕轨选择优先当前 active track，再选同语言人工字幕、同语言 ASR 字幕，最后选第一个可用非 live chat track。
3. Caption fetching 优先显式 track URL；无法获取时只显示 warning，不注入不可靠 hook。
4. 内置断句是默认路径，AI segmentation 是可选质量增强，失败后必须回退内置断句。
5. Scheduler 继续使用播放窗口预取，不等待全量字幕翻译完成。
6. Overlay 保持双语、轻量、不可被页面翻译 runtime 二次扫描。
7. 状态按钮需要清楚区分 enabled、disabled、warning、loading。
8. 如果暴露设置，第一版只考虑少量高价值开关：YouTube 字幕开关、AI segmentation 开关、overlay 字号或位置。复杂样式编辑器不进入本轮。

### 验收标准

- 有字幕轨的视频能自动启动字幕翻译，并在播放时显示双语 overlay。
- 无 Provider、无字幕轨、字幕获取失败、Provider 失败时显示 warning 或失败状态，不静默失效。
- Seek 后能优先翻译新窗口内容，旧请求结果不会污染当前视频。
- YouTube SPA 切换视频后，旧 overlay、旧 session 和旧请求被清理或忽略。
- AI segmentation 失败时回退内置断句，不阻断字幕翻译。
- 源语言等于目标语言时不调用 Provider，直接显示源文本或隐藏翻译状态。

### 测试范围

- `tests/content/youtubeSubtitle/runtime.test.ts`：补充 SPA 视频切换、seek、stale response、provider missing、caption missing、AI fallback。
- `tests/content/youtubeSubtitle/trackSelection.test.ts`：补充 active track、manual vs ASR、live chat 排除。
- `tests/content/youtubeSubtitle/scheduler.test.ts`：补充 seek window、retry exhaustion、batch limits。
- `tests/background/youtubeSubtitle/service.test.ts`：补充 model mismatch、cache hit、unknown source language detection fallback、cancel。
- `tests/background/youtubeSubtitle/aiSegmentation.test.ts`：补充 invalid coverage、unknown cue id、timeout/cancel、fallbackRequired。
- `tests/browser/youtube-subtitle.spec.mjs`：扩展 fixture 以覆盖字幕按钮、overlay、播放时间变化、配置变更和目标语言变化。

## 数据与隐私边界

- Content script 可以看到页面 DOM、字幕文本、segment id 和显示状态，但不能看到 API key、base URL secret 或完整 Provider profile。
- Background 负责 Provider profile 解析、请求执行、缓存和取消。
- Cache key 必须包含会改变语义的字段，例如 provider id、model、source language、target language、prompt version、segmentation version、translation mode。
- Trace 和测试日志不能输出原文、译文、字幕正文或 selected text。
- YouTube 字幕偏好使用独立 `subtitlePreferences`；普通网页翻译继续使用 `translationPreferences`。

## 错误处理

- 普通网页 runtime 中单个 segment 失败不应失败整个任务；只有 Provider 缺失、任务取消、content 不可达等全局错误才进入 task-level failed 或 cancelled。
- Provider 缺项优先 retry missing segments，再降级 batch。
- Provider rate limit 触发后降低并发并短暂 backoff。
- YouTube 字幕失败需要局部显示状态，不应影响普通网页翻译、划词翻译或总结。
- 旧 task、旧 runtime session、旧 config version 返回的结果必须被忽略。

## 实施顺序

1. P0：先补动态网页 runtime 和 feed fixture 相关测试，修复暴露出的状态问题。
2. P1：补 Provider pipeline 的边界测试和少量实现修正，确保 P0 的 runtime-originated batch 有稳定后台保障。
3. P2：最后做 YouTube 字幕 hardening 和产品化补齐，避免字幕专项工作影响普通网页翻译主路径。

这个顺序符合风险优先级：P0/P1 是网页翻译主路径，P2 是独立视频链路。先稳定共享 Provider pipeline，再打磨 YouTube，可以减少重复修复。

## 验证命令

每个子项目至少运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

涉及浏览器行为时运行：

```bash
pnpm verify:extension
```

涉及 YouTube fixture 时运行：

```bash
pnpm test -- tests/browser/youtube-subtitle.spec.mjs
```

如果测试入口不支持直接用 `pnpm test --` 运行 browser spec，应使用项目已有的 browser test script，并在 implementation plan 中写明准确命令。

## 风险与取舍

- 最大风险不是缺功能，而是已有链路之间的状态交互复杂。实现应优先补测试再做小修。
- P0 的 DOM extraction 不能为了 `x.com` 过拟合，否则会把导航、按钮、用户名和计数器误抽成正文。
- P1 的 retry/degrade 不能无限重试；失败要可观测、可结束。
- P2 不应扩大成视频翻译平台。YouTube 字幕已经独立成链路，本轮只把它稳定下来。
- 设置项要克制。过早开放大量 tuning 会提高维护成本，也会让用户困惑。

## 后续不在本轮的候选能力

- 普通网页划词 popup 的进一步产品化。
- 富文本翻译保真，尤其是链接保留。
- 术语表或 glossary。
- 持久翻译缓存。
- 站点级规则和 allowlist。
- 字幕样式编辑器。
- 字幕下载或侧边字幕列表。
