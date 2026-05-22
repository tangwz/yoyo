# 悠悠阅读助手

[English](README.md)

悠悠阅读助手是一个面向 Chrome / Edge 的浏览器阅读辅助插件。它允许用户配置自己的 OpenAI-compatible 大模型服务，并在用户手动触发后，对当前网页进行全文翻译、渐进式注入译文和任务状态管理。

这个项目的产品定位不是“又一个网页清洗器”，而是一个尽量尊重原网页结构的双语阅读工具：插件不替换原文，不把 API Key 暴露给 content script，也不会自动传输网页文本。当前 MVP 聚焦全文翻译主链路，后续会在同一套 provider 与任务调度框架上扩展划词翻译、图片翻译、视频翻译和全文总结。

## 功能介绍

当前版本已实现：

- 自定义大模型服务：支持 OpenAI-compatible provider，用户可配置 Base URL、API Key、文本模型、视觉模型占位和请求参数。
- Chrome Built-in AI Provider：在桌面版 Chrome 138 或更高版本中，悠悠可以无需 API Key 使用本地翻译能力。该模式是 local-only，不会自动回退到远端 Provider。
- Provider 本地保存：provider profile、API Key、模型名和 Base URL 保存到 `chrome.storage.local`，不会同步到云端。
- Provider 连接测试：设置页可发送固定短文本测试模型服务，不读取网页正文。
- 当前页全文翻译：通过 popup 或右键菜单触发当前页面翻译。
- 双语对照注入：译文插入在原文下方，不替换原文，方便对照阅读。
- 样式兼容：译文节点尽量继承原段落排版样式，减少对不同背景色和网页布局的干扰。
- 渐进式结果展示：翻译结果按批次返回并注入，不需要等待整页完成。
- 任务状态管理：支持 collecting、translating、completed、completedWithErrors、failed、cancelled 等任务状态。
- 取消任务：翻译过程中可取消任务，并通过 AbortController 中断进行中的 provider 请求。
- DOM 安全提取：跳过 `script`、`style`、`pre`、`code`、表单控件、隐藏节点、扩展自身节点以及受限页面。
- Popup 控制台：展示当前页可翻译状态、语言选择、provider 信息、翻译按钮、进度和错误摘要。
- 设置页：提供 Provider、Translation、Privacy、Advanced 设置分区。
- Chrome / Edge MV3：基于 Manifest V3 service worker 架构实现。

当前版本不包含：

- 划词翻译
- 图片翻译
- 视频字幕翻译
- 全文总结
- 持久翻译缓存
- service worker 重启后的任务恢复
- 自动翻译所有网站

这些能力属于后续版本规划，不在当前 MVP 的可用范围内。

## 技术栈

- WXT
- Vue 3
- TypeScript
- Vitest
- Playwright Core
- Chrome / Edge Manifest V3

## 开发

安装依赖：

```bash
pnpm install
```

启动开发模式：

```bash
pnpm dev
```

开发模式会由 WXT 生成浏览器扩展开发产物。根据 WXT 输出提示，在 Chrome 或 Edge 的扩展管理页面中加载对应的 unpacked extension。

## 打包

生成 Chrome MV3 生产构建：

```bash
pnpm build
```

构建产物位于：

```text
build/chrome-mv3
```

在 Chrome 或 Edge 中手动加载：

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择 `build/chrome-mv3`

生成可分发压缩包：

```bash
pnpm zip
```

压缩包会由 WXT 输出到 `build` 目录中，文件名包含 package name、扩展版本和目标浏览器，例如 `build/yoyo-reading-assistant-0.2.0-chrome.zip`。该产物可用于手动分发、提交审核或归档发布。

## 验证

常规验证：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

扩展烟测：

```bash
pnpm verify:extension
```

`pnpm verify:extension` 会构建扩展，启动本地测试文章和 mock OpenAI-compatible provider，然后启动 Chrome 并加载 `build/chrome-mv3`，验证 provider 配置、全文翻译、译文注入和代码块跳过等主链路。

如果需要保留浏览器窗口用于人工验收：

```bash
YOYO_SMOKE_KEEP_OPEN=1 pnpm verify:extension
```

如果需要让脚本结束后保留一个独立 Chrome for Testing 窗口：

```bash
YOYO_SMOKE_DETACH_BROWSER=1 pnpm verify:extension
```

## 隐私边界

- 仅访问页面不会传输网页文本。
- Provider 配置完成后，打开 popup 可能会在本地估算当前页面的可读文本量。
- 只有用户明确开始翻译时，提取出的网页文本才会发送到用户配置的 Provider。
- API Key 保存在浏览器扩展本地存储，不进入 content script，也不会注入网页上下文。
- 当前版本不提供账号系统，不上传配置到项目自有云端。
- 当前版本不保存持久翻译缓存。

## 项目状态

当前代码正在准备 Chrome Web Store beta，重点加固全文翻译主链路、Provider 首次配置、隐私边界、权限披露和 MV3 任务调度。相关设计、计划、隐私披露、发布清单和验收清单可参考：

- `docs/superpowers/specs/2026-05-08-yoyo-reading-assistant-design.md`
- `docs/superpowers/specs/2026-05-10-chrome-web-store-beta-hardening-design.md`
- `docs/superpowers/plans/2026-05-10-chrome-web-store-beta-hardening.md`
- `docs/privacy/chrome-web-store-disclosure.md`
- `docs/release/chrome-web-store-beta.md`
- `docs/qa/manual-mvp-checklist.md`
