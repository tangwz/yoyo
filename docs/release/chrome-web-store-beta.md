# Chrome Web Store Beta Release Checklist

Use this checklist before submitting a beta package to the Chrome Web Store.

## Build

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:release`.
- [ ] Confirm the unpacked extension loads from `build/chrome-mv3` in Chrome.
- [ ] Confirm the unpacked extension loads from `build/chrome-mv3` in Edge.

## Package

- [ ] Confirm the zip contains `manifest.json` at the zip root, not inside an extra parent directory.
- [ ] Confirm the zip contains only runtime extension assets needed by Chrome.
- [ ] Confirm the zip does not include source files, tests, `.env` files, log files, temporary files, local screenshots, or development-only artifacts.
- [ ] Confirm version, name, description, icons, popup, options page, background service worker, and content script entries match the intended beta release.
- [ ] Confirm source maps are included only if the release policy intentionally allows them.

## Permissions

- [ ] Confirm `<all_urls>` is present only as the host access capability needed to run the content script, read visible article/body text, create anchors, and inject translation nodes after user-triggered translation.
- [ ] Confirm `<all_urls>` is not described as automatic data collection or automatic data transmission.
- [ ] Confirm `activeTab` is absent unless a real runtime call path needs it.
- [ ] Confirm `scripting` is absent unless a real runtime call path needs it.
- [ ] Confirm `notifications` is retained only if right-click translation failure notifications are implemented and still reachable.
- [ ] Confirm permission justifications in Chrome Web Store match the current manifest.

## Privacy

- [ ] Confirm the Chrome Web Store privacy form matches `docs/privacy/chrome-web-store-disclosure.md`.
- [ ] Confirm the Limited Use disclosure matches the actual data flow.
- [ ] Confirm opening the popup does not send Provider requests.
- [ ] Confirm first-run options opening does not send Provider requests.
- [ ] Confirm page estimate does not send Provider requests.
- [ ] Confirm page text is sent only after the user starts translation from the popup or context menu.
- [ ] Confirm page text is sent only to the user-configured OpenAI-compatible Provider.
- [ ] Confirm the Provider test sends only `Reply with exactly: ok` and does not read page text.
- [ ] Confirm API keys remain in `chrome.storage.local` only, not `chrome.storage.sync`, content scripts, or webpage DOM.
- [ ] Confirm the product has no account system and no project-owned cloud receiving Provider config or webpage text.
- [ ] Confirm logs do not print API keys or full page text.

## Known Limitations

- [ ] Selection translation is not included.
- [ ] Image translation is not included.
- [ ] Video subtitle translation is not included.
- [ ] Page summaries are not included.
- [ ] Automatic translation is not included.
- [ ] Persistent translation cache is not included.
- [ ] Full task progress is not recovered after service worker restart.
- [ ] Restricted browser pages and Chrome Web Store pages cannot be translated.
- [ ] Edge support is best-effort; Chrome Web Store beta is the 1.1 release target.

## Release Blockers

- [ ] Block release if the zip root does not contain `manifest.json`.
- [ ] Block release if the zip includes source, tests, `.env`, logs, temp files, or unrelated local artifacts.
- [ ] Block release if `activeTab` or `scripting` appears in the manifest without a real runtime call path.
- [ ] Block release if `notifications` appears in the manifest but right-click failure notifications are not implemented or reachable.
- [ ] Block release if Chrome Web Store privacy or Limited Use disclosures do not match the actual data flow.
- [ ] Block release if API keys can reach content scripts or webpage DOM.
- [ ] Block release if Provider test reads page text.
- [ ] Block release if automatic page text transmission is introduced without explicit product, privacy, and permission updates.
