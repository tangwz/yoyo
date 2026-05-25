# Summary Button UI Design

## 1. Goal

本次目标是修复 popup 中“一键总结”按钮的视觉问题，让总结入口不再像临时追加的白底描边按钮，而是与 popup 的核心操作区形成清晰、稳定、可维护的设计。

用户已确认采用“并列操作”方向：把翻译与总结放在同一操作行中。翻译仍保留更强的品牌色主按钮样式；总结作为同级核心入口出现，但通过更轻的浅绿色样式保持层级差异。

## 2. Scope

本次覆盖：

- `entrypoints/popup/App.vue` 中主操作区的布局和按钮样式。
- 翻译按钮与总结按钮在 idle、loading、disabled、focus 和 hover 状态下的视觉表现。
- popup UI 测试中对按钮文案、可见性和 summary request 行为的现有覆盖。

本次不做：

- 不修改总结或翻译的消息协议。
- 不修改 `summarizePage`、`translatePage`、provider、content script 或 background 行为。
- 不新增 summary 配置、图标系统或新的视觉主题。
- 不改变 `existingTranslations` 区块中“隐藏译文 / 显示译文 / 移除译文”的操作布局。

## 3. Current Context

当前 popup 使用固定宽度 `340px`，根布局位于 `entrypoints/popup/App.vue`。现有主操作区是：

- 一个全宽 `primary-action`，文案为“翻译当前页面”。
- 一个全宽 `secondary-action summary-action`，文案为“一键总结”。

问题在于 `summary-action` 复用了通用次级按钮样式，而这个样式原本更适合小型辅助操作。它放在主按钮下方时，宽度、边框、留白和视觉层级都显得松散，导致总结入口看起来像后补功能。

已有 summary 设计文档 `docs/superpowers/specs/2026-05-23-article-summary-design.md` 把总结定义为 popup 入口之一；从产品层面看，用户现在也希望它像核心能力，而不是低优先级链接。

## 4. Recommended Approach

采用“并列双操作按钮”方案。

主操作区改为一个两列 grid：

- 左侧翻译按钮：保留品牌绿色主按钮样式，文案压缩为“翻译页面”。
- 右侧总结按钮：使用浅绿色填充、品牌色文字、品牌系边框，不再使用白底弱描边。

两列按钮使用相同高度、相同圆角和一致的内边距，形成一个稳定操作组。翻译按钮仍通过深色填充与阴影保持第一优先级；总结按钮作为同一行的同级入口出现，但视觉重量略低。

该方案优点：

- 直接解决当前按钮“像临时补丁”的问题。
- 明确表达总结是 popup 的核心能力之一。
- 减少垂直占用，让 popup 更紧凑。
- 改动集中在 popup template 和 scoped CSS，不影响业务链路。

该方案代价：

- 翻译按钮文案需要从“翻译当前页面”改为“翻译页面”，否则在两列布局下容易拥挤。
- 两个核心动作并列后，summary 的可见性会明显提高，产品语义比原先更强。

## 5. Alternatives Considered

### 5.1 Soft Secondary

保留垂直布局，summary 使用浅绿色填充的大按钮。

优点是改动小，仍保留翻译按钮的绝对主导地位。缺点是 popup 会继续有两个全宽大按钮，垂直节奏偏重；总结作为核心能力的表达仍不够明确。

### 5.2 Quiet Ghost

保留现有白底描边方向，只调整高度、圆角、边框颜色和 spacing。

优点是风险最低。缺点是只能“稍微不丑”，不能解决总结入口像弱辅助操作的问题。

## 6. UI Design

主操作区新增专用容器 `action-grid`，替代当前两个按钮直接堆叠的结构。

建议视觉规则：

- `action-grid` 使用 `grid-template-columns: 1fr 1fr`，列间距约 `10px`。
- 两个按钮最小高度保持在 `48px`，与当前主按钮高度一致。
- 翻译按钮继续使用深绿色渐变和轻微阴影。
- 总结按钮使用 `var(--yoyo-surface-muted)` 或同体系浅绿背景，边框使用品牌绿色的低透明或浅色变量。
- 两个按钮都保留 `focus-visible` ring，ring 与当前 `primary-action` 保持一致。
- disabled 状态保持低透明度和 `not-allowed` cursor，不能只依赖颜色表达。
- hover 状态只做轻量反馈，避免 summary 按钮看起来比 translate 更强。

文案规则：

- 默认中文翻译按钮文案从“翻译当前页面”调整为“翻译页面”。
- 翻译中仍显示“取消翻译”。
- 完成或已有译文时仍显示“重新翻译”。
- summary 文案继续走 `src/popup/messages.ts`，中文为“一键总结”，英文为 “Summarize”。
- summary loading 文案继续使用现有 `button.summarizingPage`。

## 7. State Behavior

状态逻辑保持现状：

- `isPrimaryDisabled` 的计算不变。
- `isSummaryDisabled` 的计算不变。
- 点击翻译仍调用 `onPrimaryAction`。
- 点击总结仍调用 `onSummaryAction`。
- summary request 仍发送 `summarizePage`，包含当前 `tabId` 和 `targetLanguage`。

唯一行为可见变化是布局和主按钮默认文案缩短。该文案变化是视觉布局的一部分，不应改动底层消息协议或任务状态机。

## 8. Component Boundary

本次不抽取新 Vue 组件。

理由：

- 变化只影响 popup 内部一个小型操作区。
- 当前 `App.vue` 已经拥有 primary action 和 summary action 的状态上下文。
- 新组件需要传入多个状态、文案和 handler，会增加不必要接口面。

实现时应通过局部 class 分离样式职责：

- `action-grid` 管理布局。
- `primary-action` 保留翻译主按钮样式。
- `summary-action` 变成 summary 专用按钮样式。
- 通用 `.secondary-action` 继续服务已有译文区域，避免样式回归。

## 9. Testing and Verification

自动化验证：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

推荐补充或更新的测试点：

- popup 默认状态仍显示翻译按钮和“一键总结”按钮。
- 英文 UI 仍显示 “Summarize”。
- 点击“一键总结”仍发送 `summarizePage`，并带上当前 `targetLanguage`。
- 如果测试环境支持 class 断言，可检查两个核心按钮位于同一个 action group；否则保持行为测试为主，把视觉布局交给人工/浏览器验证。

人工验证：

- 在 extension popup 尺寸下检查中文界面，确认两个按钮同高、同行、无换行挤压。
- 切到英文 UI，确认 “Summarize” 不溢出。
- 检查 disabled、hover、focus-visible 状态。
- 检查已有译文状态下“隐藏译文 / 移除译文”区域没有被新样式影响。

## 10. Implementation Notes

推荐实现顺序：

1. 在 `entrypoints/popup/App.vue` 中引入 `action-grid` 包住翻译和总结按钮。
2. 将默认 primary label 从“翻译当前页面”改为“翻译页面”。
3. 调整 `.primary-action` 使其适配两列布局，同时保留现有 translating、completed、disabled 状态。
4. 给 `.summary-action` 增加专用浅绿色按钮样式，不再完全依赖 `.secondary-action`。
5. 确认 `.secondary-action` 的现有用途不被 summary 新样式污染。
6. 运行测试并进行 popup 视觉检查。
