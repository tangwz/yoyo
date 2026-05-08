# Yoyo Reading Assistant MVP Manual QA

## Build
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Load `.output/chrome-mv3` in Chrome extension developer mode.
- [ ] Load the same build in Edge extension developer mode.

## Provider
- [ ] Open options page.
- [ ] Create an OpenAI-compatible provider profile.
- [ ] Confirm API key is entered only in options page.
- [ ] Run provider test connection with fixed test text.

## Popup
- [ ] Popup shows source language dropdown, arrow, target language dropdown.
- [ ] Popup shows translation service.
- [ ] Popup has large primary translate button.
- [ ] Popup footer shows settings, version, and more.

## Translation Pages
- [ ] Translate a normal blog article.
- [ ] Translate a technical documentation page.
- [ ] Translate a news article.
- [ ] Translate a long article and cancel mid-task.
- [ ] Translate GitHub README or issue page.

## DOM Safety
- [ ] Code blocks are not translated.
- [ ] Tables are not translated.
- [ ] Forms and inputs are not translated.
- [ ] Hidden and aria-hidden content is not translated.
- [ ] Translations can be hidden, shown, removed, and regenerated.
- [ ] Translation text mirrors source paragraph style on light, dark, and colored content.

## Privacy
- [ ] API key is not present in content script messages.
- [ ] Full page text is not printed in logs.
- [ ] Provider profile is not stored in `chrome.storage.sync`.
