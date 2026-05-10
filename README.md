# Yoyo Reading Assistant

[简体中文](README-zh.md)

Yoyo Reading Assistant is a Chrome / Edge reading assistant extension for bilingual long-form reading. It lets users configure their own OpenAI-compatible LLM provider, then manually translate the current page with progressive result injection and task state tracking.

This project is not positioned as a page-cleaning tool. It is designed to preserve the original page structure as much as possible: it does not replace source text, does not expose API keys to content scripts, and does not automatically transmit page text. The current MVP focuses on the full-page translation workflow. Future versions can extend the same provider and task orchestration foundation to support selection translation, image translation, video translation, and page summaries.

## Features

Implemented in the current version:

- Custom LLM provider: supports OpenAI-compatible providers with configurable Base URL, API Key, text model, vision model placeholder, and request parameters.
- Local provider storage: provider profiles, API keys, model names, and Base URLs are stored in `chrome.storage.local` and are not synced across devices.
- Provider connection test: the options page can send a fixed short prompt to test the configured provider without reading page content.
- Full-page translation: users can translate the current page from the popup or context menu.
- Bilingual reading layout: translations are inserted below the original text instead of replacing it.
- Style compatibility: injected translations try to mirror the original paragraph styling to reduce disruption across different page backgrounds and layouts.
- Progressive injection: translated batches are injected as they complete instead of waiting for the entire page.
- Task state tracking: supports collecting, translating, completed, completedWithErrors, failed, and cancelled states.
- Cancellation: running tasks can be cancelled, and in-flight provider requests are aborted with `AbortController`.
- Safe DOM extraction: skips `script`, `style`, `pre`, `code`, form controls, hidden nodes, extension-owned nodes, and restricted pages.
- Popup control panel: shows current page status, language selectors, provider information, action button, progress, and error summary.
- Options page: includes Provider, Translation, Privacy, and Advanced sections.
- Chrome / Edge MV3: implemented with Manifest V3 service worker architecture.

Not included in the current version:

- Selection translation
- Image translation
- Video subtitle translation
- Page summaries
- Persistent translation cache
- Task recovery after service worker restart
- Automatic translation for all websites

These capabilities are planned for later versions and are not part of the current MVP scope.

## Tech Stack

- WXT
- Vue 3
- TypeScript
- Vitest
- Playwright Core
- Chrome / Edge Manifest V3

## Development

Install dependencies:

```bash
pnpm install
```

Start development mode:

```bash
pnpm dev
```

WXT generates the development extension output. Follow the WXT terminal output and load the generated unpacked extension from the Chrome or Edge extension management page.

## Packaging

Build the Chrome MV3 production extension:

```bash
pnpm build
```

The unpacked build is written to:

```text
build/chrome-mv3
```

Load it manually in Chrome or Edge:

1. Open `chrome://extensions` or `edge://extensions`
2. Enable developer mode
3. Click "Load unpacked"
4. Select `build/chrome-mv3`

Create a distributable zip:

```bash
pnpm zip
```

WXT writes the zip file to `build`. The file name includes the package name, extension version, and browser target, for example `build/yoyo-reading-assistant-0.1.0-chrome.zip`. This artifact can be used for manual distribution, review submission, or release archiving.

## Verification

Run the standard checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run the extension smoke test:

```bash
pnpm verify:extension
```

`pnpm verify:extension` builds the extension, starts a local test article and mock OpenAI-compatible provider, launches Chrome with `build/chrome-mv3` loaded, and verifies provider configuration, full-page translation, translation injection, and code-block skipping.

Keep the browser open for manual acceptance:

```bash
YOYO_SMOKE_KEEP_OPEN=1 pnpm verify:extension
```

Keep a detached Chrome for Testing window after the script exits:

```bash
YOYO_SMOKE_DETACH_BROWSER=1 pnpm verify:extension
```

## Privacy Boundaries

- Visiting a page alone does not transmit page text.
- Opening the popup may locally estimate readable text after a Provider is configured.
- Extracted page text is sent to the configured Provider only when the user explicitly starts translation.
- API keys are stored in browser extension local storage, do not enter content scripts, and are not injected into the page context.
- The current version has no account system and does not upload configuration to a project-owned cloud service.
- The current version does not store a persistent translation cache.

## Project Status

This codebase is preparing for a Chrome Web Store beta. The current priority is to harden the full-page translation workflow, Provider onboarding, privacy boundary, permission disclosure, and MV3 task orchestration. See:

- `docs/superpowers/specs/2026-05-08-yoyo-reading-assistant-design.md`
- `docs/superpowers/specs/2026-05-10-chrome-web-store-beta-hardening-design.md`
- `docs/superpowers/plans/2026-05-10-chrome-web-store-beta-hardening.md`
- `docs/privacy/chrome-web-store-disclosure.md`
- `docs/release/chrome-web-store-beta.md`
- `docs/qa/manual-mvp-checklist.md`
