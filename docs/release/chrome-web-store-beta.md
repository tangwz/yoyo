# Chrome Web Store Beta Release Checklist

本清单用于 Chrome Web Store beta 提交前的发布收口。它描述当前实现应满足的状态，不代表功能路线图。

## Build

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:release`.
- [ ] 在 Chrome 中从 `build/chrome-mv3` 加载 unpacked extension。
- [ ] 在 Edge 中从 `build/chrome-mv3` 加载 unpacked extension，并按 best-effort 记录差异。

## Package

- [ ] 确认 zip 根目录包含 `manifest.json`，而不是多一层父目录。
- [ ] 确认 zip 只包含 Chrome 运行扩展所需的 runtime assets。
- [ ] 确认 zip 不包含 source files、tests、`.env`、logs、temporary files、local screenshots 或 development-only artifacts。
- [ ] 确认 version、name、description、icons、popup、options page、background service worker、content script、offscreen document 都匹配本次 beta 目标。
- [ ] 确认 source maps 只在发布策略明确允许时包含。

## Implemented Capabilities

- [ ] Popup 可以手动触发当前页翻译，并展示 provider、语言、进度、错误和已有译文状态。
- [ ] Context menu 可以触发当前页翻译。
- [ ] Context menu 可以触发 selection translation，并在页面中展示 selection-anchored popup。
- [ ] Selection translation 的默认 provider 独立于全页翻译、summary 和 YouTube 字幕 provider。
- [ ] OpenAI-compatible provider 支持用户配置的 Base URL、API key 和 model。
- [ ] Chrome Built-in AI provider 在支持的桌面 Chrome 版本中可选，local-only，不需要 API key，不自动 fallback 到远程 provider。
- [ ] Article summary 可以从 popup 手动触发，并通过 OpenAI-compatible provider 生成页面总结。
- [ ] Chrome Built-in AI active provider 下，summary 返回明确 unsupported 状态，不自动 fallback 到远程 provider。
- [ ] YouTube subtitle translation 可以在有可用 caption track 的 YouTube 视频页运行，并显示播放器按钮和 bilingual overlay。
- [ ] 动态网页翻译 runtime 支持手动任务内的 viewport-first queue、mutation rescan、lazy recovery 和 extension-owned node skip。
- [ ] Provider pipeline 支持 streaming fallback、missing item retry、batch degrade、single-segment fallback、cache fan-out、cancellation stale result protection 和 rate-limit recovery。

## Permissions

- [ ] 确认 `<all_urls>` 只作为 host access capability：运行 content script、读取用户触发翻译所需的 visible readable text、创建 anchors、注入 translation nodes。
- [ ] 确认 `<all_urls>` 没有被描述为 automatic data collection 或 automatic data transmission。
- [ ] 确认 `storage` 用于 provider profiles、API keys、language preferences、subtitle preferences、selection translation preferences 和 UI configuration。
- [ ] 确认 `contextMenus` 用于 page translation、selection translation 和 page summary 入口。
- [ ] 确认 `notifications` 仅用于 context-menu failure notification，并且该路径仍可达。
- [ ] 确认 `offscreen` 仅用于 Chrome Built-in AI provider 的 MV3 offscreen document。
- [ ] 确认 `activeTab` 不在 manifest 中，除非后续新增真实 runtime call path。
- [ ] 确认 `scripting` 不在 manifest 中，除非后续新增真实 runtime call path。
- [ ] 确认 Chrome Web Store permission justifications 与当前 manifest 一致。

## Privacy

- [ ] 确认 Chrome Web Store privacy form 与 `docs/privacy/chrome-web-store-disclosure.md` 一致。
- [ ] 确认 Limited Use disclosure 与实际 data flow 一致。
- [ ] 确认 opening popup 不发送 provider requests。
- [ ] 确认 first-run options opening 不发送 provider requests。
- [ ] 确认 page estimate 不发送 provider requests。
- [ ] 确认 full-page text 只在用户从 popup 或 context menu 显式开始页面翻译后发送。
- [ ] 确认 selected text 只在用户显式触发 selection translation 后发送。
- [ ] 确认 summary source text 只在用户显式触发 summary 后发送。
- [ ] 确认 YouTube subtitle text 只在 YouTube subtitle preference 启用且视频存在可用 caption track 时发送或本地处理。
- [ ] 确认 OpenAI-compatible provider active 时，文本只发送到用户配置的 provider。
- [ ] 确认 Chrome Built-in AI provider active 时，文本经 extension offscreen document 交给 browser Built-in AI APIs 本地处理，不发送到用户配置的 OpenAI-compatible provider。
- [ ] 确认 Provider test 只发送 `Reply with exactly: ok`，不读取页面文本。
- [ ] 确认 API keys 只保存在 `chrome.storage.local`，不进入 `chrome.storage.sync`、content scripts 或 webpage DOM。
- [ ] 确认产品没有 account system，也没有 project-owned cloud 接收 provider config、API keys、webpage text、translation requests 或 translation responses。
- [ ] 确认 logs 不打印 API keys、完整页面文本、selection text、subtitle text、summary text 或 translation text。

## Known Limitations

- [ ] 不包含 image translation。
- [ ] 不包含 non-YouTube video sites。
- [ ] 不包含 no-caption video ASR。
- [ ] 不包含 automatic page translation。
- [ ] 不包含 persistent translation cache。
- [ ] 不包含 glossary 或 terminology management。
- [ ] 已包含 site blacklist；不包含 auto-translation allowlist、rule subscription 或 rule sharing。
- [ ] 不包含 subtitle download、side subtitle list、生词本或复杂 subtitle style editor。
- [ ] 不包含 rich-text fidelity guarantee；尤其是复杂 inline links 和 nested formatting 仍按当前 DOM injection 能力 best-effort。
- [ ] Service worker restart 后不保证恢复完整 in-flight task progress。
- [ ] Restricted browser pages 和 Chrome Web Store pages 不能翻译。
- [ ] Edge support 是 best-effort；Chrome Web Store beta 的主目标仍是 Chrome。

## Release Blockers

- [ ] Block release if the zip root does not contain `manifest.json`.
- [ ] Block release if the zip includes source, tests, `.env`, logs, temp files, or unrelated local artifacts.
- [ ] Block release if `activeTab` or `scripting` appears in manifest without a real runtime call path and matching disclosure.
- [ ] Block release if `notifications` appears in manifest but context-menu failure notifications are not implemented or reachable.
- [ ] Block release if `offscreen` appears in manifest but Chrome Built-in AI offscreen usage is removed or undocumented.
- [ ] Block release if Chrome Web Store privacy or Limited Use disclosures do not match actual data flow.
- [ ] Block release if API keys can reach content scripts or webpage DOM.
- [ ] Block release if Provider test reads page text.
- [ ] Block release if popup open, options open, or page estimate sends provider requests.
- [ ] Block release if automatic page text transmission is introduced without explicit product, privacy, and permission updates.
- [ ] Block release if Chrome Built-in AI silently falls back to a remote provider.
