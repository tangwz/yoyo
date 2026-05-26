# Selection Translation Popup Design

## Context

Yoyo is a WXT Chrome / Edge MV3 extension using Vue 3 and TypeScript. The current selection translation path is intentionally small: background translates the selected text with the active provider, then content renders a fixed bottom-right panel through `src/content/selectionPanel.ts`.

Issue #29 changes that interaction. Selection translation should appear in an explicit popup near the selected text, similar to the provided reference image, instead of the page corner. The popup body must only show translated content. It also needs a copy button and a provider selector that uses already configured model services.

The selected provider behavior is scoped to selection translation. Choosing a provider in the popup must not change the global active provider used by page translation, summary, or YouTube subtitle translation.

## Goals

- Replace the bottom-right selection translation panel with a medium, selection-anchored popup.
- Show only translated text in the popup body. Do not show source text or explanatory footer copy.
- Use a green Yoyo brand icon in the popup header.
- Use icon-only controls for copy and close.
- Use a dropdown for configured provider/model services.
- Remember the user's selection translation default provider separately from the global active provider.
- Retranslate the current selection immediately when the dropdown provider changes.
- Keep provider secrets in background/local storage boundaries. Content must only receive provider ids, display labels, and translation results.

## Non-Goals

- Do not change page translation, summary, or YouTube subtitle provider selection behavior.
- Do not convert the selection popup to a Vue app in this iteration.
- Do not add provider profile editing from the popup.
- Do not add translation history.
- Do not show bilingual output, source text, explanations, or dictionary details.

## User Experience

The popup is a medium panel anchored near the current text selection. It prefers the area above or below the selection and flips when there is not enough viewport space. It is clamped within the viewport so long translations and edge selections remain usable.

The header contains:

- Green Yoyo brand icon.
- Provider dropdown.
- Copy icon button.
- Close icon button.

The body contains:

- Loading state while translation is in progress.
- Translated text on success.
- Error message on failure.

The body does not contain source text or explanatory footer text. Copy success or failure appears as a short-lived lightweight status near the copy button, not as a persistent footer row.

The provider dropdown lists ready, configured providers only:

- OpenAI-compatible providers display as `displayName / textModel`.
- Chrome Built-in AI displays as `Chrome Built-in AI`.

When the user chooses another provider:

1. Save that provider as the selection translation default.
2. Immediately retranslate the current selection.
3. Show loading state for the new request.
4. Ignore stale results from older requests.

## Architecture

Use the current background/content boundary and extend it rather than introducing a new UI runtime.

### Content

`src/content/selectionPanel.ts` becomes the selection popup runtime. It owns only UI state and DOM interaction:

- Render popup structure and inline styles.
- Position the popup near the current selection.
- Render loading, success, and error states.
- Render provider dropdown from background-provided options.
- Trigger provider changes and retranslation requests through runtime messages.
- Copy translated text through the Clipboard API.
- Close and remove the popup.
- Ignore stale request results with request ids.

The popup should be marked as extension-owned and non-translatable:

- `data-yoyo-extension="selection-translation-panel"`
- `class="notranslate"`
- `translate="no"`

### Background

`src/background/selectionTranslation.ts` remains the translation boundary. It should support a selection-specific provider id and default provider lookup:

- Resolve the requested provider id when provided.
- Otherwise resolve the saved selection translation default provider.
- Fall back to a ready stored provider if the saved provider is missing or invalid.
- Execute translation with the resolved provider.
- Return normalized result or error messages to content.

Background must not expose API keys, base URLs beyond display labels, request params, or other secrets to content.

### Storage

Add selection translation preferences to storage:

```ts
export type SelectionTranslationPreferences = {
  providerId?: string;
};
```

Store this separately from `activeProviderId`. Saving a provider from the popup updates only selection translation preferences.

### Messaging

Extend the message contract with selection-specific messages:

- `getSelectionTranslationConfig`: content asks background for ready provider options, selected provider id, and target language.
- `setSelectionTranslationProvider`: content asks background to persist the selected provider id for future selection translations.
- `translateSelectionWithProvider`: content asks background to translate the current selection with source text, source language, target language, provider id, and request id. The sender tab id is used by background when it needs to send a content message.
- `showSelectionTranslation`: background asks content to show loading, success, or error state. The message includes request id, selected provider id, provider options, and the translated text or error message for terminal states.

Content ignores any result whose request id is not current.

## Data Flow

1. User triggers selection translation from the context menu.
2. Background resolves selection translation provider and target language.
3. Background sends content a loading popup message with source text, provider options, selected provider id, and request id.
4. Background translates the selected text using the resolved provider.
5. Background sends content a result message with request id and translated text.
6. Content renders only the translated text.
7. If the user changes provider in the dropdown, content saves the new selection provider id and sends a new translation request for the same selection.
8. Content updates the popup to loading and accepts only the newest request result.

## Error Handling

- No ready provider: show provider missing state and include an action to open provider settings.
- Provider failure: show a concise error message while keeping the dropdown available for retry via another provider.
- Chrome Built-in AI language detection failure: reuse the existing local-only error message.
- Chrome Built-in AI warm-up or language pair failure: reuse the existing local-only error message.
- Stale result: ignore silently.
- Copy failure: show a short-lived failure status near the copy button.
- Close during in-flight translation: remove the popup and ignore later results.

## Testing

### Content Tests

Update `tests/content/selectionPanel.test.ts` to cover:

- Popup renders translated text and does not render source text.
- Popup renders green brand icon, provider dropdown, copy icon button, and close icon button.
- Loading, success, and error states render correctly.
- Provider change triggers retranslation and updates loading state.
- Stale request results do not replace the current result.
- Copy success and failure feedback stays near the copy button and does not add footer copy.
- Popup uses extension-owned and non-translation markers.

### Background Tests

Update `tests/background/selectionTranslation.test.ts` to cover:

- Selection translation uses saved selection provider by default.
- Explicit provider id overrides the saved selection provider.
- Saving selection provider does not call `setActiveProviderId`.
- Invalid saved provider falls back to another ready provider.
- Missing provider, provider errors, and local AI failures return safe messages.
- Perf traces do not include raw selected text or translated text.

### Storage Tests

Update `tests/storage/repositories.test.ts` to cover:

- Default selection translation preferences.
- Saving and loading `providerId`.
- Normalizing invalid preference payloads.

### Messaging Tests

Update `tests/messaging/contracts.test.ts` to cover the new selection popup config, provider save, and translate request/result shapes.

## Implementation Scope

Expected files:

- `src/content/selectionPanel.ts`
- `src/background/selectionTranslation.ts`
- `src/background/contextMenuActions.ts`
- `entrypoints/background.ts`
- `entrypoints/content.ts`
- `src/messaging/contracts.ts`
- `src/storage/repositories.ts`
- `src/storage/storageKeys.ts`
- `tests/content/selectionPanel.test.ts`
- `tests/background/selectionTranslation.test.ts`
- `tests/storage/repositories.test.ts`
- `tests/messaging/contracts.test.ts`

## Verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

For manual QA:

1. Configure at least two provider profiles.
2. Trigger selection translation on a normal web page.
3. Confirm the popup appears near the selected text and not in the bottom-right corner.
4. Confirm the body shows only translated text.
5. Switch provider in the dropdown and confirm the same selection is retranslated immediately.
6. Confirm the selected provider is remembered for later selection translations.
7. Confirm page translation, summary, and YouTube subtitle provider behavior is unchanged.
8. Confirm copy success and close behavior.
9. Test viewport edge selections and long translation output.
