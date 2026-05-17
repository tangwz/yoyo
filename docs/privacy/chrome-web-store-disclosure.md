# Chrome Web Store Privacy Disclosure

This document records the privacy and permission facts that must stay aligned with the Chrome Web Store privacy form, permission justification, and Limited Use disclosures for the beta release.

## Permission Scope

`<all_urls>` is used as a page access capability so the extension can support user-triggered translation on arbitrary readable web pages.

This capability allows Yoyo to:

- Run the content script on pages where Chrome permits extension content scripts.
- Read visible article or body text selected by the extension's DOM extraction rules.
- Create stable anchors for source text blocks so translated batches can be matched back to the page.
- Inject extension-owned translation nodes below source text for bilingual reading.

`<all_urls>` is not automatic data transmission. It does not mean Yoyo reads every visited page, uploads page text in the background, or sends browsing history to any server.

`offscreen` is used to create an extension offscreen document for the Chrome Built-in AI provider. The offscreen document hosts browser Built-in AI APIs that are unavailable in the Manifest V3 background service worker. This permission is not a remote data transfer capability.

## Page Text Data Flow

Page text is sent only when the user explicitly starts translation from the popup or the context menu.

When translation starts:

1. The content script extracts visible readable text from the current page, excluding unsupported or unsafe DOM regions.
2. The background task batches the extracted text.
3. The text batches are sent to the OpenAI-compatible Provider configured by the user.
4. Translation responses are sent back to the content script for injection into the same page.

Yoyo does not provide automatic translation in the beta release. It does not automatically translate every website, every tab, or every page visit.

## Chrome Built-in AI Data Flow

On desktop Chrome 138 or later, users can select the Chrome Built-in AI provider to translate locally with no API key.

When this provider is selected:

1. Page text is extracted only after the user explicitly starts translation.
2. Text batches are sent from the background task to the extension offscreen document.
3. The offscreen document calls Chrome's browser Built-in AI APIs because those APIs are unavailable in the Manifest V3 background service worker.
4. Translation responses are sent back through extension messaging for injection into the same page.

The Chrome Built-in AI provider is local-only. It does not use the user-configured OpenAI-compatible Provider, does not require or transmit an API key, and does not automatically fall back to a remote Provider.

## Provider Test Data Flow

The Provider connection test does not read page text.

The test sends only this fixed prompt to the user-configured Provider:

```text
Reply with exactly: ok
```

The test exists only to confirm that the Provider endpoint, API key, and model settings can complete a minimal request.

## API Key Storage

Provider profiles and API keys are stored in `chrome.storage.local` only.

API keys are not stored in `chrome.storage.sync`, are not sent to content scripts, and are not injected into the webpage DOM. Web pages cannot read the key from extension storage.

## Project-Owned Services

Yoyo has no account system in the beta release.

The project does not operate a project-owned cloud service that receives Provider configuration, API keys, webpage text, translation requests, or translation responses.

The only remote service that receives page text during translation is the user-configured OpenAI-compatible Provider.

## Chrome Web Store Disclosure Requirements

Chrome Web Store privacy disclosures and Limited Use statements must match the actual data flow above.

The submission must disclose that:

- Page access is used to support user-triggered translation on the current page.
- Page text is transmitted only after the user explicitly starts translation.
- When an OpenAI-compatible Provider is selected, page text is transmitted only to the Provider configured by the user.
- When the Chrome Built-in AI provider is selected, page text is processed locally through Chrome's browser Built-in AI APIs hosted in an extension offscreen document.
- The `offscreen` permission is used only to host browser Built-in AI APIs that are unavailable in the MV3 background service worker.
- API keys stay in extension local storage and are used only for requests to the configured Provider.
- Provider connection tests send only `Reply with exactly: ok` and do not read page text.
- Provider configuration, API keys, page text, translation requests, and translation responses are not sent to project-owned cloud services.

The submission must not imply that Yoyo has a project-owned backend, account database, analytics pipeline, or cloud translation service unless that behavior is implemented in the product. The submission must clearly distinguish page access capability from user-triggered Provider transmission.
