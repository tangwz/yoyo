# Yoyo Reading Assistant Beta Manual QA Checklist

Use this checklist for Chrome Web Store beta acceptance. Run it against the production build loaded from `build/chrome-mv3`.

## Build And Load

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:release`.
- [ ] Load `build/chrome-mv3` in Chrome extension developer mode.
- [ ] Load `build/chrome-mv3` in Edge extension developer mode.
- [ ] Confirm extension name, version, icon, popup, options page, and context menu are present.

## First Run

- [ ] Install the extension with no existing `chrome.storage.local` Provider profile.
- [ ] Open the popup on a normal web page.
- [ ] Confirm the popup shows Provider setup is required before translation can start.
- [ ] Confirm opening the popup does not send Provider requests.
- [ ] Click the setup action and confirm the options page opens directly to the Provider section.
- [ ] Confirm first-run options opening does not send Provider requests.
- [ ] Confirm the Provider form receives focus or is visually positioned as the first-run target.
- [ ] Confirm the popup does not collect page text before Provider readiness is established.

## Provider

- [ ] Create an OpenAI-compatible Provider profile with Base URL, API key, and text model.
- [ ] Save the profile and make it active.
- [ ] Run the Provider connection test.
- [ ] Confirm the test sends only `Reply with exactly: ok`.
- [ ] Confirm the test does not read page text.
- [ ] Confirm invalid Base URL, missing API key, and missing text model states are surfaced clearly.
- [ ] Confirm API keys are stored only in `chrome.storage.local`.
- [ ] Confirm API keys are not present in `chrome.storage.sync`, content script messages, page DOM, console logs, or network payloads other than requests to the configured Provider.

## Popup State Reconstruction

- [ ] Translate a page and close the popup during the task.
- [ ] Reopen the popup and confirm it reconstructs active task status, progress, and provider label.
- [ ] Complete a translation, close the popup, reopen it, and confirm existing translation state is shown.
- [ ] Hide translations from the popup and confirm the next popup open shows the hidden state.
- [ ] Show translations from the popup and confirm the next popup open shows the visible state.
- [ ] Remove translations from the popup and confirm the next popup open shows no existing translation state.
- [ ] Confirm page estimate is not requested before Provider readiness is known.
- [ ] Confirm page estimate reads only local page content and does not send Provider requests.

## Translation Pages

- [ ] Translate a normal blog article from the popup.
- [ ] Translate a normal blog article from the context menu.
- [ ] Translate a technical documentation page.
- [ ] Translate a news article.
- [ ] Translate a long article and cancel mid-task.
- [ ] Translate a GitHub README or issue page.
- [ ] Confirm progressive translation batches are injected without waiting for the full page.
- [ ] Confirm translated text is injected below source text and does not replace the original text.
- [ ] Confirm failures show a recoverable popup state and, for context-menu starts, a failure notification when the popup is not open.

## DOM Safety

- [ ] Confirm code blocks are not translated.
- [ ] Confirm tables are not translated.
- [ ] Confirm forms, inputs, buttons, and editable fields are not translated.
- [ ] Confirm hidden and `aria-hidden` content is not translated.
- [ ] Confirm extension-owned translation nodes are not re-extracted for translation.
- [ ] Confirm translations can be hidden, shown, removed, and regenerated.
- [ ] Confirm translation text mirrors source paragraph style on light, dark, and colored content.
- [ ] Confirm restricted browser pages and Chrome Web Store pages fail safely without page text extraction.

## Privacy And Permissions

- [ ] Confirm manifest host access includes `<all_urls>` for content script page access.
- [ ] Confirm `<all_urls>` is documented as capability to run the content script, read visible article/body text, create anchors, and inject translation nodes.
- [ ] Confirm `<all_urls>` is not described as automatic data transmission.
- [ ] Confirm page text is sent only after the user explicitly starts translation from the popup or context menu.
- [ ] Confirm page text is sent only to the user-configured OpenAI-compatible Provider.
- [ ] Confirm `activeTab` is absent unless a real runtime call path needs it.
- [ ] Confirm `scripting` is absent unless a real runtime call path needs it.
- [ ] Confirm `notifications` is retained only if right-click translation failure notifications are implemented and reachable.
- [ ] Confirm there is no account system and no project-owned cloud receiving Provider config or webpage text.
- [ ] Confirm full page text and API keys are not printed in logs.

## Chrome Web Store

- [ ] Confirm the zip contains `manifest.json` at the zip root.
- [ ] Confirm the zip excludes source files, tests, `.env` files, logs, temp files, and unrelated local artifacts.
- [ ] Confirm Chrome Web Store permission justifications match the manifest.
- [ ] Confirm Chrome Web Store privacy answers match `docs/privacy/chrome-web-store-disclosure.md`.
- [ ] Confirm Limited Use statements match the actual data flow.
- [ ] Confirm known limitations in `docs/release/chrome-web-store-beta.md` are reflected in listing copy or beta notes where relevant.
