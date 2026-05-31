# Superpowers Plan Status

本目录保存历史 implementation plans。它们是当时的执行脚本和审查线索，不是当前项目状态的唯一来源。

## Status Rule

- 不要把历史计划中的 unchecked checkbox 直接解释为“功能未完成”。
- 当前功能状态以 source code、tests、release docs、QA docs 和 git history 为准。
- 新计划仍可以使用 checkbox 跟踪当轮执行，但计划完成并 merge 后，checkbox 不要求回填。
- 如果某个历史计划需要复盘，应先对照相关 commits、tests 和 release docs，再判断哪些步骤已经落地。

## Current Milestone Notes

- `2026-05-30-p0-dynamic-page-runtime-hardening.md`、`2026-05-30-p1-provider-pipeline-hardening.md` 和 `2026-05-30-p2-youtube-subtitle-hardening.md` 已通过 `Merge P0 P1 P2 hardening` 进入主线。
- 这些计划中的 checkbox 保留为历史执行结构，不再作为 release readiness gate。
- Chrome Web Store beta readiness 以 `docs/release/chrome-web-store-beta.md` 和 `docs/qa/manual-mvp-checklist.md` 为准。

## When To Update These Plans

只在下面场景修改历史 plan：

- 修正文档中会误导后续实现的错误事实。
- 添加明确的归档说明或指向新的 release gate。
- 用户明确要求重建某个计划的完成状态。

不要为了制造完成感批量勾选旧 checkbox；那会降低计划文档作为审计线索的可信度。
