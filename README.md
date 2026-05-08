# Yoyo Reading Assistant

Yoyo Reading Assistant is a Chrome/Edge MV3 extension built with WXT, Vue 3, and TypeScript.

## Development

    pnpm install
    pnpm dev

## Verification

    pnpm typecheck
    pnpm lint
    pnpm test
    pnpm build
    pnpm verify:extension

Load the Chrome MV3 build from `.output/chrome-mv3` in Chrome or Edge developer mode.

`pnpm verify:extension` builds the extension, starts local mock pages and a mock
OpenAI-compatible provider, then launches Chrome with `.output/chrome-mv3`
loaded as an unpacked extension. Set `YOYO_CHROME_CHANNEL=msedge` to run the
same smoke test with Edge.
