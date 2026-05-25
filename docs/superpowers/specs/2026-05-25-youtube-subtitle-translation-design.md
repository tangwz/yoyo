# YouTube Subtitle Translation Design

## 背景

Yoyo 当前是 WXT Chrome / Edge MV3 扩展，已有普通网页翻译、划词翻译、总结、provider profile、background task orchestration、content script DOM 注入和隐私边界。现有翻译链路围绕页面文本抽取和 `TranslationProvider` capability 设计，provider secrets 保留在 background/offscreen 边界内，content script 不直接访问 provider 配置。

本设计目标是新增 YouTube 字幕实时翻译：支持任意已配置翻译服务，对视频字幕进行翻译并双语显示；内置基础字幕清洗、合并与断句算法；支持可选 AI 断句以提升自动字幕质量。设计参考 `fishjar/kiss-translator` 的 YouTube subtitle pipeline，但按当前项目的 MV3、TypeScript、provider capability 和测试结构重新建模。

## 目标

- 在 YouTube 视频页自动启用字幕翻译，默认全局开启。
- 在 YouTube player 右侧控制栏插入 Yoyo 字幕按钮，按钮展示状态并作为全局开关。
- 支持 YouTube caption track 的获取、清洗、内置断句、时间轴生成和双语 overlay 渲染。
- 复用当前 active `TranslationProvider`，支持 OpenAI-compatible 和 Chrome Built-in AI 等现有 provider。
- 翻译按播放进度预取，不等待整条字幕轨全量翻译完成。
- 支持可选 AI 断句，默认关闭，复用 active provider。
- AI 断句失败、缺段、超时或输出不可解析时，降级到内置断句和普通字幕翻译。
- 保持 privacy boundary：content script 不接触 API key 或 provider secret。
- 新增独立字幕协议、缓存 namespace、取消语义和测试覆盖。

## 非目标

- 不做音频转写或无字幕视频的 ASR。
- 不修改 YouTube 原生 CC 开关状态。
- 不把 YouTube 字幕翻译塞进现有普通网页 `TranslationTaskOrchestrator`。
- 不在第一版实现字幕样式编辑器、字幕下载、右侧字幕列表、生词本或 hover dictionary。
- 不支持非 YouTube 视频站点。
- 不承诺移动端 YouTube 支持。
- 不在第一版引入单独 AI segmentation provider 配置；AI 断句复用 active provider。

## 用户体验

字幕翻译默认自动开启。用户进入 YouTube 视频页后，content runtime 自动尝试获取字幕轨、生成字幕时间轴并启动预取翻译。用户可以通过播放器控制栏内的 Yoyo 字幕按钮关闭或重新开启该功能。

按钮插入到 YouTube player 的右侧控制栏，位置优先靠近字幕或设置按钮；若无法稳定定位，则插入右侧 controls 末尾。content runtime 使用 `MutationObserver` 处理 YouTube SPA 跳转、播放器重建、全屏和剧场模式切换导致的 DOM 重绘，并保证每个 player 实例只挂载一个按钮。

按钮使用紧凑的 Yoyo 绿色主题：绿色渐变方形底，中心只保留白色“文”，不使用完整 app icon 的书本细节，避免小尺寸重叠。右上角 badge 表示运行状态：

- 绿色勾：全局启用且当前视频可正常处理。
- 红色叉：全局关闭，overlay 已移除，当前请求会被取消或忽略。
- 黄色感叹号：全局启用但当前不可正常工作，例如 provider 未配置、无可用字幕轨、语言对不可用或字幕获取失败。
- 灰色 loading 点：正在获取字幕轨、断句或等待首批翻译。loading 状态只用于初始化和首批结果阶段，避免后续批量翻译时频繁闪烁。

点击开启态会关闭 YouTube 字幕翻译并持久化用户偏好；点击关闭态会重新开启并持久化。视频切换时读取该偏好决定是否自动启动 pipeline。若 provider 未配置，则不自动发送翻译请求，只显示 warning，并可引导用户打开 options。

overlay 不依赖 YouTube 原生字幕是否开启，也不修改 YouTube CC 状态。overlay 挂载在当前 video player 容器内，底部居中显示，并在控制栏出现、全屏、剧场模式等场景下保持在播放器安全区域内。默认显示双语：原文在上、译文在下。译文未返回时显示原文和轻量 loading/占位；翻译失败时译文行显示简短失败状态，但播放不中断。

overlay DOM 使用 `.notranslate` 和 `translate="no"`，并要求项目自身页面翻译扫描器跳过该节点，避免二次翻译。第一版样式保持克制：半透明深色背景、白色原文、绿色或浅色译文、最大宽度随播放器自适应，最多两行原文和两行译文；超长文本通过 segment 策略提前拆分，而不是靠 CSS 强行压缩。overlay 默认 `pointer-events: none`，避免遮挡 YouTube 控件。

## 架构

新增独立 YouTube subtitle pipeline，不复用普通网页 DOM 翻译 orchestrator。核心边界如下：

- `src/content/youtubeSubtitle/*`：视频检测、播放器控制栏按钮、caption track 获取、`json3` 解析、内置断句、播放时间同步、预取调度、session cache、overlay 渲染和 runtime cleanup。
- `src/background/youtubeSubtitle/*`：active provider 解析、字幕批量翻译、独立 subtitle cache、可选 AI 断句、取消和错误归一化。
- `src/messaging/contracts.ts`：新增字幕专用 request/response，不复用 `translatePage`。
- `src/storage/*`：新增 `subtitlePreferences`，默认 YouTube 字幕翻译开启、AI 断句关闭。
- `src/provider/*`：不新增 provider 类型，复用现有 active `TranslationProvider`。

content runtime 负责离视频最近的状态：YouTube SPA 生命周期、当前 video 元素、当前播放器实例、字幕时间轴、播放窗口、overlay。background 负责 provider 和缓存边界：content 只发送 subtitle segment，不接触 provider secret。

这条边界避免让现有 `TranslationTaskOrchestrator` 承担字幕专属复杂度。普通页面翻译关注 DOM anchor、lazy viewport、page segment 和任务进度；字幕翻译关注时间轴、seek、预取窗口、播放器重建和 overlay。

## 字幕获取

第一版只处理 YouTube 可用的字幕轨，不做音频转写。字幕数据优先使用 YouTube `timedtext` 的 `json3` 格式。content runtime 在视频页检测当前 `videoId`，读取 caption tracks，选择当前或最合适的字幕轨，然后拉取并解析事件。

优先实现显式获取 caption track，避免一开始就依赖注入页面 XHR hook。XHR hook 可作为 fallback，用于 YouTube 页面内部已加载字幕但扩展无法稳定定位 track 的情况。

字幕轨选择规则：

- 优先当前 YouTube 正在使用的字幕语言和 track kind。
- 其次选择同语言人工字幕。
- 再其次选择同语言 ASR 字幕。
- 最后选择第一个非 chat/live-chat 字幕轨。
- 若源语言与目标语言相同，不发起翻译请求；按钮可保持开启状态，overlay 可不显示或显示状态提示。

`sourceLanguage` 可以为 `unknown`。background 在调用 provider 前可以尝试用现有 language detection 能力补全；补全失败不直接阻断，由 provider capability 决定是否支持 auto/unknown source。

## 字幕断句

字幕断句输出必须满足以下 contract：

- 每个输出 segment 覆盖一段连续原始 cue。
- `sourceCueIds` 进入 `SubtitleSegment`，用于追踪来源和校验覆盖。
- 时间轴只能从原始 cue 推导，不凭空生成。
- 单条字幕不超过最大时长、最大词数或最大字符数。
- 短句优先向后合并，但遇到长 pause、强句末标点或合并后超过限制时停止。
- 中日韩等无空格语言按字符、标点、时间窗处理。
- 英文等空格语言按 token/word、标点、pause gap 处理。
- 混合语言按主要脚本判断，必要时回退到字符策略。

人工字幕默认保留 YouTube 原有 cue，只做轻量清洗和过长 cue 拆分。自动字幕 ASR 默认走内置合并/断句。规则包含 pause gap、句末标点、最大时长、最大词数、短句合并；英文/空格语言按词合并，中文/日文/韩文等无空格语言按字符长度和时间窗口合并。

AI 断句默认关闭。开启后只对 ASR 或质量较差的字幕轨分块处理，复用 active provider，让模型返回重新分段后的原文和译文。AI 输出必须经过本地 validator，检查连续覆盖、无重叠、时间来自原始 cue、最大时长、最大词数/字符数、segment id 稳定生成。校验失败时降级到内置断句。

AI 断句 prompt 不允许模型生成任意时间戳；模型只能返回原始 cue 范围或 cue id 范围。content/background 再由原始 cue 计算时间轴。

## 实时翻译

字幕翻译不等待全量完成。content runtime 在获取字幕轨并完成内置清洗/断句后，先生成完整 segment 时间轴，然后维护一个播放进度预取窗口，例如 `currentTime - 2s` 到 `currentTime + 60~90s`。

窗口内未翻译、未请求且未达到失败重试上限的 segment 会进入队列，按字符数或 segment 数批量发送给 background。background 复用 active `TranslationProvider.translateBatch`，返回带 `segmentId` 的结果；content 收到后通过 `runtimeSessionId`、`configVersion`、`requestId` 校验结果是否仍然有效，再增量更新 session cache 和 overlay。

seek 时立即重新扫描新窗口。旧窗口请求可以尝试 abort；如果无法 abort，则返回后只允许写入匹配 key 的缓存，不得更新已经失效的 overlay。YouTube SPA 跳转或视频切换时递增 `runtimeSessionId`，移除 overlay、停止 listener、取消或忽略所有旧请求。provider、model、目标语言、字幕轨、AI 断句开关变化时递增 `configVersion`，清空当前 in-flight 队列，并按新的 cache key 从当前播放时间重新调度。

## 缓存

缓存分为两层。

content session cache 只服务当前页面，key 至少包含：

- `videoId`
- `trackKey`
- `sourceLanguage`
- `targetLanguage`
- `providerId`
- `model`
- `segmentTextHash`
- `segmentationVersion`
- `translationMode`
- `promptVersion`

background subtitle cache 使用独立 namespace 和短期 LRU，复用 `SessionTranslationCache` 的结构但不与普通页面翻译缓存混用，避免 `promptVersion`、`segmentKind` 和上下文语义混淆。

`promptVersion`、`segmentationVersion`、`translationMode` 必须进入请求、缓存 key 和测试断言，避免未来 prompt 或断句策略变更时复用旧缓存。

## 消息协议

字幕协议单独建模，不复用 `PageSegment`。

```ts
type SubtitleSourceLanguage =
  | { kind: "known"; code: string }
  | { kind: "unknown" };

type SubtitleTranslationMode = "youtubeSubtitleRealtime";

type SubtitleCue = {
  cueId: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

type SubtitleSegment = {
  segmentId: string;
  sourceCueIds: string[];
  sourceCueStartIndex: number;
  sourceCueEndIndex: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  textHash: string;
};

type SubtitleTranslationItem = {
  segmentId: string;
  translatedText: string;
};

type TranslateSubtitleBatchRequest = {
  type: "translateSubtitleBatch";
  runtimeSessionId: string;
  configVersion: number;
  requestId: string;
  videoId: string;
  trackKey: string;
  sourceLanguage: SubtitleSourceLanguage;
  targetLanguage: string;
  providerId: string;
  modelKey: string;
  promptVersion: string;
  segmentationVersion: string;
  translationMode: SubtitleTranslationMode;
  segments: SubtitleSegment[];
};

type TranslateSubtitleBatchResponse =
  | {
      type: "subtitleTranslateBatchResult";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      items: SubtitleTranslationItem[];
    }
  | {
      type: "subtitleTranslateBatchError";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      message: string;
      retryable: boolean;
    };

type CancelSubtitleRequestsRequest = {
  type: "cancelSubtitleRequests";
  runtimeSessionId: string;
  reason: "userDisabled" | "videoChanged" | "configChanged" | "pageUnloaded";
};

type SegmentSubtitleChunkRequest = {
  type: "segmentSubtitleChunk";
  runtimeSessionId: string;
  configVersion: number;
  requestId: string;
  videoId: string;
  trackKey: string;
  sourceLanguage: SubtitleSourceLanguage;
  targetLanguage: string;
  providerId: string;
  modelKey: string;
  segmentationPromptVersion: string;
  segmentationVersion: string;
  sourceCues: SubtitleCue[];
  previousContext?: string;
  nextContext?: string;
};

type SegmentSubtitleChunkResponse =
  | {
      type: "segmentSubtitleChunkResult";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      segments: Array<SubtitleSegment & { translatedText?: string }>;
    }
  | {
      type: "segmentSubtitleChunkError";
      runtimeSessionId: string;
      configVersion: number;
      requestId: string;
      message: string;
      fallbackRequired: true;
    };
```

整批错误响应由 background 返回 `subtitleTranslateBatchError`，content 根据 `retryable`、retry count 和 backoff 决定是否重试。取消消息尽力取消 background in-flight 请求；即使 provider 无法真正 abort，返回结果也必须通过 session/config/request 校验，不能更新失效 overlay。

AI 断句使用 `segmentSubtitleChunk` 协议。content 发送连续 cue chunk，background 复用 active provider 生成分段结果，随后在 background 内先执行 validator；只有通过 validator 的 `SubtitleSegment` 才能返回给 content。返回失败或 validator 不通过时，background 返回 `segmentSubtitleChunkError`，content 对该 chunk 使用内置断句降级。

## 存储

新增 `subtitlePreferences`，使用 schema version 和边界校验。

```ts
type SubtitlePreferences = {
  schemaVersion: 1;
  youtubeEnabled: boolean;
  aiSegmentationEnabled: boolean;
  prefetchBeforeMs: number;
  prefetchAfterMs: number;
  maxRetryCount: number;
};
```

默认值：

```ts
const defaultSubtitlePreferences: SubtitlePreferences = {
  schemaVersion: 1,
  youtubeEnabled: true,
  aiSegmentationEnabled: false,
  prefetchBeforeMs: 2000,
  prefetchAfterMs: 90000,
  maxRetryCount: 2,
};
```

读取 storage 时 normalize：

- `schemaVersion` 非 `1` 时回落默认值或走显式迁移。
- `youtubeEnabled` 非 boolean 时回落 `true`。
- `aiSegmentationEnabled` 非 boolean 时回落 `false`。
- `prefetchBeforeMs` 限制在 `0..10000`。
- `prefetchAfterMs` 限制在 `15000..180000`。
- `maxRetryCount` 限制在 `0..5`。

播放器按钮切换写入 `youtubeEnabled`。options 页后续可增加完整设置，但第一版不要求新增复杂 UI；至少需要有可恢复的 storage repository 和测试。

## 错误处理

错误处理不阻断播放。

- 没有字幕轨：按钮显示 no captions/warning 状态，overlay 不显示，tooltip 提示该视频没有可获取字幕。
- provider 缺失：显示 warning，点击可打开 options，不自动发送翻译请求。
- language pair 不可用：显示 warning，保留原文播放。
- 单批翻译失败：segment 先显示原文和简短失败状态，并按 backoff 重试；达到重试上限后标记为最终失败。
- AI 断句失败、缺段、超时或输出无法解析：降级到内置断句和普通字幕翻译，不视为整个字幕功能失败。
- YouTube SPA 跳转、视频切换或 page unload：递增 `runtimeSessionId`，移除 overlay，停止 listener，取消或忽略旧请求。

## 测试计划

单元测试覆盖：

- `json3` cue 解析：空文本、HTML tag、无效时间、重叠 cue、chat/live-chat track 过滤。
- 内置断句：连续 cue 覆盖、`sourceCueIds`、短句向后合并、长 pause 停止、强标点停止、最大时长、最大词数/字符数、中日韩字符策略、英文 word 策略、混合脚本判断。
- AI 断句 validator：成功路径、缺段、重叠、非连续覆盖、超限、未知 cue id、无法解析时降级。
- 预取调度：窗口扫描、去重、按 segment 数/字符数 batch、失败重试上限、backoff、seek 后旧请求不更新 overlay。
- cache key：包含 `videoId`、`trackKey`、source/target language、provider、model、text hash、`segmentationVersion`、`translationMode`、`promptVersion`。
- background 翻译：active provider 复用、独立 subtitle cache namespace、整批错误响应、provider 缺失、cancel request。
- UI/runtime：按钮只挂载一次、badge 状态变化、YouTube SPA 跳转清理、player rebuild 后重新挂载、overlay 使用 `.notranslate` 和 `translate="no"`、overlay 不阻挡控件。

集成或 smoke 测试覆盖：

- 在 mock YouTube DOM 中插入 player controls，确认按钮定位和去重。
- 模拟 video timeupdate 和 seek，确认 overlay 按当前 segment 更新。
- 模拟旧 `runtimeSessionId`、旧 `configVersion`、旧 `requestId` 返回，确认不会更新 overlay。
- 模拟 provider 变更或目标语言变更，确认 in-flight 队列清空并从当前播放时间重新调度。

建议实现完成后运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:extension
```

## 风险与取舍

YouTube DOM 和 caption track 结构不稳定，因此 content runtime 必须围绕观察、去重挂载和可恢复 cleanup 设计。第一版应保持 UI 和设置面克制，先把 caption track、断句、预取、取消、缓存和 overlay 这条主链路做稳。

AI 断句能提升 ASR 字幕质量，但成本、延迟和失败面都更高，因此默认关闭，并且任何 AI 输出都不能直接信任。validator 和内置断句降级是第一版必须具备的安全网。

独立 subtitle pipeline 会新增协议和测试成本，但能保持现有普通网页翻译 orchestrator 的职责清晰。长期看，字幕和网页翻译都复用 provider capability，而不是复用不匹配的 orchestration。
