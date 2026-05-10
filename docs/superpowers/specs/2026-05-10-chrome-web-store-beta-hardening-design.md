# Yoyo Chrome Web Store Beta Hardening Design

## 1. 目标与范围

Yoyo 1.1 命名为 **Chrome Web Store Beta Hardening**。这一版不扩展划词翻译、页面总结、图片翻译或视频字幕翻译，而是把当前全文翻译 MVP 打磨到可公开 beta 的状态。

1.1 的核心目标：

- 首次使用时把“未配置 Provider”视为 onboarding 状态，而不是错误状态。
- popup 能在 background 状态丢失、页面已有译文等场景下重建用户可理解状态。
- Chrome Web Store beta 发布前，manifest 权限、隐私说明、QA checklist 和 release 流程都可解释、可验证、可审计。

1.1 的明确非目标：

- 不做 service worker 中断后的任务续跑。
- 不做完整任务进度恢复。
- 不持久化网页正文或译文。
- 不做自动翻译。
- 不做按需注入或权限架构大迁移。

## 2. 架构边界

现有模块边界继续保持：

- `content script` 负责 DOM extraction、anchor、译文节点和页面 runtime state。
- `background service worker` 负责 provider 调用、task orchestration、progress broadcast、取消和 session cache。
- `popup` 是当前页面任务控制台，不承载完整设置页。
- `options page` 是完整配置中心，作为独立浏览器页面打开。
- 文档和 QA checklist 负责支撑 Chrome Web Store beta 的权限、隐私和发布叙事。

1.1 的恢复原则是：**不自动续跑中断任务，不持久化网页正文，不持久化译文，只重建足够清晰的用户状态**。

`<all_urls>` 的解释边界必须写清楚：

- `<all_urls>` 表示扩展具备页面访问能力：运行 content script、读取可见正文、注入译文节点。
- 它不等于自动发送页面数据。
- 只有用户显式触发全文翻译时，当前页面正文才会发送到用户配置的 Provider。

## 3. First-Run Provider Onboarding

1.1 将“未配置 Provider”视为 onboarding 状态，而不是错误状态。系统不引入额外 first-run flag，而是直接以 provider readiness 判断用户是否可以进入翻译控制台。

Provider readiness 优先于 page estimate。未配置 Provider 时，popup 不估算当前页面是否可翻译，也不展示页面不可翻译或 Provider 错误。用户当前最需要解决的是 Provider 配置，而不是页面状态判断。

Provider readiness 建议建模为：

```ts
type ProviderReadiness =
  | "ready"
  | "missingProvider"
  | "missingApiKey"
  | "missingBaseURL"
  | "missingTextModel"
  | "invalidActiveProvider";
```

`missingProvider`、`invalidActiveProvider`、`missingApiKey`、`missingBaseURL` 和 `missingTextModel` 都进入 onboarding 路径。popup 文案保持简洁，不需要逐项展示配置错误；具体缺失项由 options page 展示。

推荐流程：

- 用户点击扩展图标打开 popup。
- popup 首先执行 provider readiness check。
- 如果没有可用 active provider profile，popup 显示轻量 onboarding fallback，例如“需要先配置 Provider，正在打开设置页面...”。
- popup 尝试打开独立 options tab，并定位到 Provider 区域。
- popup 保留“打开设置”按钮，防止自动打开失败。
- options page 作为完整独立页面承载 Provider 配置，不作为 popup 内嵌页面。
- options page 的 Provider 区域是 first-run 默认落点，第一屏应展示 Preset、Base URL、API Key、Text Model、保存和测试连接。
- Provider 测试连接只发送固定短 prompt：`Reply with exactly: ok`。
- 保存成功后设置 active provider。
- 保存 Provider 不会自动触发当前页面翻译；翻译仍需用户显式点击“翻译当前页面”或使用右键菜单触发。

popup 打开 options page 时可以带 query，例如 `options.html?section=provider&source=first-run`。options page 可以据此滚动到 Provider 区域、展示 first-run 简短说明，并聚焦到合适输入框。

## 4. Popup State Reconstruction

1.1 的 popup 不追求恢复完整任务，只恢复用户能理解、能操作的状态。初始化状态优先级固定如下：

1. Provider readiness
2. Active background task
3. Existing page translations
4. Page estimate

具体语义：

- popup 首先判断 Provider 是否可用。
- 如果 Provider 不是 `ready`，进入 onboarding，不做 page estimate。
- Provider ready 后，查询 background 是否有当前 tab 的非终态任务。
- 如果存在 `collecting` 或 `translating`，展示实时进度和取消按钮。
- 如果 background 没有运行中任务，查询 content runtime。
- 如果页面存在 `[data-yoyo-translation]`，展示“页面已有译文”状态。
- 不重建 `translated` / `failed` / `total`，不推断任务是否完整。
- 只有 Provider ready、无运行中任务、页面无既有译文时，才估算当前页面是否可翻译。

“页面已有译文”状态提供这些动作：

- 隐藏译文或显示译文。
- 移除译文。
- 重新翻译。

重新翻译保持现有语义：先移除旧译文与旧 anchors，再重新 collect segments 并启动新任务。它仍然是用户显式动作，不自动触发。

content runtime 对 popup 暴露的信息保持克制：

```ts
type PageRuntimeState = {
  hasTranslations: boolean;
  taskId?: string;
  visibility?: "visible" | "hidden";
};
```

`visibility` 是可选增强。它不恢复任务进度，只让 popup 的辅助按钮能在“隐藏译文 / 显示译文”之间正确切换。如果现有 DOM 标记不足，1.1 可以先只实现 `hasTranslations` 和 `taskId`，按钮文案采用保守状态。

## 5. Chrome Web Store Beta Readiness

1.1 的发布准备分成三类：manifest/权限叙事、隐私与商店文案、验收流程。这里不做权限模型重构，重点是让现有权限可解释、可验证、可提交。

Manifest 权限策略：

- 继续保留 `<all_urls>`，理由是扩展需要页面访问能力：运行 content script、读取可见正文、生成 anchor，并把译文节点注入原文下方。
- 明确说明 `<all_urls>` 只是页面访问能力，不表示自动发送数据。
- 继续保留 `storage`，用于 provider profile、API key、语言偏好和本地配置。
- `contextMenus` 用于右键触发全文翻译。
- `notifications` 如实现右键失败通知则保留，否则移除。典型用途是右键菜单触发失败时提示未配置 Provider 或页面不可翻译。
- `activeTab` 和 `scripting` 是 1.1 必须审计项：如果当前实现不依赖，就在 implementation plan 阶段移除；如果保留，必须写清用途。

文档侧新增或更新：

- `docs/release/chrome-web-store-beta.md`
  - beta 发布 checklist。
  - build/zip 产物路径。
  - 手动加载和提交前检查。
  - 已知限制。
- `docs/privacy/chrome-web-store-disclosure.md`
  - 页面文本何时读取、何时发送、发送到哪里、不发送到哪里。
  - API key 保存在 `chrome.storage.local`，不跨设备同步，不进入 content script，不注入网页。
  - Provider test 只发送固定 `Reply with exactly: ok`。
  - Chrome Web Store privacy / Limited Use 披露必须与实际数据流一致。
- `docs/qa/manual-mvp-checklist.md`
  - 扩展为 beta checklist。
  - 加入 first-run、popup 状态重建、已有译文状态、权限/隐私检查、Chrome Web Store submission 前检查。

Chrome Web Store 文案围绕三个事实写：

- Yoyo 是用户自带模型服务的双语阅读助手。
- 页面文本只在用户手动触发翻译时发送到用户配置的 Provider。
- 项目不提供账号系统，不把 provider 配置或网页正文上传到项目自有云端。

## 6. Automated Verification

自动化验证覆盖：

- `ProviderReadiness`
  - 无 provider profile。
  - active provider id 指向不存在 profile。
  - 缺少 API key / Base URL / Text Model。
  - Provider 完整时返回 `ready`。
- popup 初始化优先级
  - Provider 未 ready 时，不调用 page estimate，直接进入 onboarding。
  - Provider ready 且有 running task 时，展示 task progress。
  - Provider ready、无 running task、页面已有译文时，展示“页面已有译文”。
  - 只有前三者都不命中时，才做 page estimate。
- content runtime state
  - 有译文节点时返回 `hasTranslations: true`。
  - hide/show/remove 后状态符合预期。
- smoke test
  - 首次打开 popup 自动打开独立 options tab。
  - 配置 Provider、测试连接、保存。
  - 回到文章页后需要用户显式触发翻译，不自动发送页面正文。
  - 翻译完成后重开 popup，能识别页面已有译文。

隐私边界必须可观测：

- 使用 mocked provider 或 request spy 验证打开 popup 不产生 provider 请求。
- first-run 自动打开 options 不产生 provider 请求。
- page estimate 不产生 provider 请求。
- 只有点击“翻译当前页面”或右键菜单翻译时，才产生包含页面正文的 provider 请求。
- Provider test 只发送固定 `Reply with exactly: ok`。

## 7. Manual Beta Checklist

手动验收作为 beta checklist 固化：

- Chrome 加载 `build/chrome-mv3` unpacked build。
- Chrome Web Store 提交前检查 zip、图标、名称、描述、权限理由、隐私文案和 privacy / Limited Use 披露。
- 验证未配置 Provider 时的 first-run 路径。
- 验证 Provider test 只发送固定 `Reply with exactly: ok`。
- 验证全文翻译、取消、隐藏、显示、移除、重新翻译。
- 验证页面文本不会在未触发翻译时发送到 Provider。
- 验证 API key 不进入 content script message，不进入网页 DOM，不进入 `chrome.storage.sync`。
- 验证 `<all_urls>` 的说明文案与实际行为一致：页面访问能力包括运行 content script、读取可见正文、注入译文节点，不等于自动发送数据。

## 8. Privacy and Permission Verification

权限审计必须成为 beta 发布前检查项：

- `storage`、`contextMenus`、`notifications`、`scripting`、`activeTab` 和 `host_permissions` 均有对应调用或明确理由。
- `notifications` 只有在实现右键失败通知时才保留；如果没有通知调用路径，manifest 必须移除该权限。
- 未使用的权限必须移除，或在 release 文档中标记为 blocking issue。
- `<all_urls>` 的理由必须与实际行为一致：页面访问能力包括运行 content script、读取可见正文、注入译文节点，不代表自动发送数据。
- Chrome Web Store privacy / Limited Use 披露必须与实际数据流一致，不能暗示项目自有云端会接收 provider 配置或网页正文。

zip 结构检查必须覆盖：

- `manifest.json` 位于 zip 根目录。
- zip 不包含源码、测试文件、`.env`、日志或临时文件。
- `build/chrome-mv3` 可被 Chrome 以 unpacked 方式加载。
- Chrome Web Store 上传 zip 与本地验证产物一致。

## 9. Rollout Gate

发布 beta 前必须通过：

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm verify:extension`
- beta checklist 全部通过。
- README、privacy、release 文档与 manifest 权限保持一致。
- Chrome Web Store privacy / Limited Use 披露与实际数据流保持一致。

已知限制必须明确写出：

- 不做断点续跑。
- 不做完整任务恢复。
- 不持久化网页正文或译文。
- 不做自动翻译。
- Edge 保持技术上不刻意破坏，但 1.1 首发验收以 Chrome Web Store beta 为主。

## 10. Release Blockers

任一情况出现则不得发布 beta：

- API key 出现在 content script message、DOM、`chrome.storage.sync`、日志或错误上报中。
- 未触发翻译时产生包含网页正文的 provider 请求。
- manifest 中存在无法解释或未使用的高敏权限。
- Provider 未配置时仍触发 page estimate 或页面正文提取。
- popup 在 background 状态丢失且页面已有译文时显示错误态或卡死。
- `activeTab` 或 `scripting` 无实际调用路径但仍保留在 manifest 中。
- zip 结构不满足 Chrome Web Store 上传要求。
- Chrome Web Store privacy / Limited Use 披露与实际数据流不一致。
