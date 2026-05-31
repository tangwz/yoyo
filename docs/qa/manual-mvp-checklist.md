# Yoyo Reading Assistant Beta Manual QA Checklist

本清单用于 Chrome Web Store beta 的人工验收。默认使用 production build，并从 `build/chrome-mv3` 加载 unpacked extension。

## Build And Load

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:release`.
- [ ] 在 Chrome extension developer mode 加载 `build/chrome-mv3`。
- [ ] 在 Edge extension developer mode 加载 `build/chrome-mv3`，记录 best-effort 差异。
- [ ] 确认 extension name、version、icon、popup、options page、context menu 和 offscreen entry 都存在。

## First Run

- [ ] 使用没有既有 `chrome.storage.local` provider profile 的浏览器环境安装扩展。
- [ ] 在普通网页打开 popup。
- [ ] 确认 popup 在 provider readiness 之前提示需要配置 provider。
- [ ] 确认 opening popup 不发送 provider requests。
- [ ] 点击 setup action，确认 options page 打开到 provider section。
- [ ] 确认 first-run options opening 不发送 provider requests。
- [ ] 确认 provider form 获得焦点，或视觉位置明确指向 first-run setup。
- [ ] 确认 popup 在 provider readiness 之前不收集页面文本。

## OpenAI-Compatible Provider

- [ ] 创建 OpenAI-compatible provider profile，包含 Base URL、API key 和 text model。
- [ ] 保存 profile 并设为 active。
- [ ] 运行 Provider connection test。
- [ ] 确认 test 只发送 `Reply with exactly: ok`。
- [ ] 确认 test 不读取页面文本。
- [ ] 确认 invalid Base URL、missing API key、missing text model 状态被清晰展示。
- [ ] 确认 API keys 只保存在 `chrome.storage.local`。
- [ ] 确认 API keys 不出现在 `chrome.storage.sync`、content script messages、page DOM、console logs，或除用户配置 provider request 之外的 network payloads。

## Chrome Built-in AI Provider

- [ ] 在不支持 Chrome Built-in AI 的浏览器或版本中，确认 provider option 明确显示 unavailable 或 disabled。
- [ ] 在支持的桌面 Chrome 版本中，确认 Chrome Built-in AI provider 可选择。
- [ ] 确认 Chrome Built-in AI provider 不要求 Base URL、API key 或 model。
- [ ] 确认 popup provider label 显示 local-only 语义。
- [ ] 使用 Chrome Built-in AI provider 翻译普通页面，确认不会调用 OpenAI-compatible provider。
- [ ] 使用 Chrome Built-in AI provider 触发 selection translation，确认显示 translated text 或明确 local-only error。
- [ ] 使用 Chrome Built-in AI provider 触发 summary，确认显示 summary unsupported 状态，且不自动 fallback 到远程 provider。

## Popup State Reconstruction

- [ ] 翻译页面过程中关闭 popup。
- [ ] 重新打开 popup，确认 active task status、progress 和 provider label 能恢复。
- [ ] 完成翻译后关闭并重新打开 popup，确认显示 existing translation state。
- [ ] 从 popup hide translations，确认下次打开 popup 显示 hidden state。
- [ ] 从 popup show translations，确认下次打开 popup 显示 visible state。
- [ ] 从 popup remove translations，确认下次打开 popup 不再显示 existing translation state。
- [ ] 确认 page estimate 不在 provider readiness 前请求。
- [ ] 确认 page estimate 只读取本地页面内容，不发送 provider requests。

## Full-Page Translation

- [ ] 从 popup 翻译普通 blog article。
- [ ] 从 context menu 翻译普通 blog article。
- [ ] 翻译 technical documentation page。
- [ ] 翻译 news article。
- [ ] 翻译 long article，并在任务中途 cancel。
- [ ] 翻译 GitHub README 或 issue page。
- [ ] 确认 progressive translation batches 不需要等待整页完成即可注入。
- [ ] 确认 translated text 注入在 source text 下方，不替换原文。
- [ ] 确认 failure 在 popup 中显示 recoverable state；context-menu start 且 popup 未打开时显示 failure notification。

## Dynamic Page Runtime

- [ ] 在 feed-like 页面手动开始翻译，确认首屏可见内容优先翻译。
- [ ] 滚动加载新内容，确认手动任务仍 active 时新增内容继续进入队列。
- [ ] 确认 mutation rescan 不重复翻译 extension-owned translation nodes。
- [ ] 确认 React 或 SPA 替换节点时任务不会整体失败。
- [ ] 确认 detached source anchor 被清理或上报为 segment failure，而不是卡住任务。
- [ ] 确认 hide、show、remove 和 re-translate 不破坏后续 dynamic content handling。

## Selection Translation

- [ ] 在普通网页选择一段文本。
- [ ] 从 context menu 触发 selection translation。
- [ ] 确认 popup 锚定在 selection 附近，而不是固定在页面角落。
- [ ] 在 selection popup 中切换 provider，确认本次请求使用所选 provider。
- [ ] 关闭 selection popup，确认后续 late result 不再重新显示已关闭 popup。
- [ ] 再次触发 selection translation，确认上次选择的 selection provider 被记住。
- [ ] 确认 selection provider preference 不改变 full-page translation、summary 或 YouTube subtitle 的 provider。
- [ ] 确认 selected text 只在显式触发 selection translation 后发送或本地处理。

## Article Summary

- [ ] 在普通 article page 打开 popup。
- [ ] 点击 summary action。
- [ ] 确认 summary 使用当前 target language。
- [ ] 确认 summary panel 显示在页面中，且不会替换原文内容。
- [ ] 确认重复 summary 会替换旧 summary panel，而不是创建多个 panel。
- [ ] 确认关闭 summary panel 后 DOM 清理干净。
- [ ] 确认 summary source extraction 是只读路径，不触发 translation injection、queue 或 task reset。
- [ ] 确认 summary request 不记录 source text、prompt、summary text、API key 或 Authorization header。

## YouTube Subtitle Translation

- [ ] 打开有 caption track 的 YouTube video page。
- [ ] 确认 player button mount 成功。
- [ ] 开启 YouTube subtitle translation。
- [ ] 确认 bilingual overlay 显示当前播放窗口内的字幕和译文。
- [ ] Seek 到较后位置，确认 later window 的字幕会继续排队和翻译。
- [ ] 切换视频或 YouTube SPA 导航，确认旧 overlay、旧 session 和旧请求被清理或忽略。
- [ ] 在 caption fetch 临时失败后重试，确认不会永久卡在 loading。
- [ ] 切换 subtitle preferences，确认 stale overlay/config state 不残留。
- [ ] 确认没有 caption track 或 provider 不可用时显示局部状态，不影响普通网页翻译。
- [ ] 确认 YouTube subtitle text 不进入 logs。

## DOM Safety

- [ ] 确认 code blocks 不被翻译。
- [ ] 确认 tables 不被翻译。
- [ ] 确认 forms、inputs、buttons 和 editable fields 不被翻译。
- [ ] 确认 hidden 和 `aria-hidden` content 不被翻译。
- [ ] 确认 extension-owned translation nodes 不会被再次抽取。
- [ ] 确认 translations 可以 hide、show、remove 和 regenerate。
- [ ] 确认 translation text 在 light、dark 和 colored content 上尽量继承 source paragraph style。
- [ ] 确认 restricted browser pages 和 Chrome Web Store pages fail safely，不抽取 page text。

## Privacy And Permissions

- [ ] 确认 manifest host access 包含 `<all_urls>`，用于 content script page access。
- [ ] 确认 `<all_urls>` 被描述为运行 content script、读取 visible readable text、创建 anchors、注入 translation nodes 的能力。
- [ ] 确认 `<all_urls>` 没有被描述为 automatic data transmission。
- [ ] 确认 `offscreen` permission 只用于 Chrome Built-in AI provider 的 MV3 offscreen document。
- [ ] 确认 `activeTab` 不在 manifest 中，除非后续有真实 runtime call path。
- [ ] 确认 `scripting` 不在 manifest 中，除非后续有真实 runtime call path。
- [ ] 确认 `notifications` 只在 context-menu failure notification 路径中使用。
- [ ] 确认没有 account system，也没有 project-owned cloud 接收 provider config、API keys、webpage text、translation requests 或 translation responses。
- [ ] 确认 full page text、selection text、subtitle text、summary text、translation text 和 API keys 不打印到 logs。

## Chrome Web Store

- [ ] 确认 zip 根目录包含 `manifest.json`。
- [ ] 确认 zip 排除 source files、tests、`.env`、logs、temporary files 和 unrelated local artifacts。
- [ ] 确认 Chrome Web Store permission justifications 与 manifest 匹配。
- [ ] 确认 Chrome Web Store privacy answers 与 `docs/privacy/chrome-web-store-disclosure.md` 匹配。
- [ ] 确认 Limited Use statements 与实际 data flow 匹配。
- [ ] 确认 listing copy 和 beta notes 与 `docs/release/chrome-web-store-beta.md` 的 current capabilities 和 known limitations 一致。
