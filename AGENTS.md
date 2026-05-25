# Repository Guidelines

## Project Structure & Module Organization

This is a WXT Chrome / Edge MV3 extension using Vue 3 and TypeScript.

- `entrypoints/` wires WXT surfaces: background, content, popup, options, and offscreen pages.
- `src/` contains feature modules: `background/`, `content/`, `provider/`, `translation/`, `summary/`, `storage/`, `messaging/`, `ui/`, and `utils/`.
- `tests/` mirrors source areas with Vitest tests.
- `docs/` stores design plans, QA checklists, release notes, and privacy docs.
- `scripts/` contains release and extension verification helpers.
- `build/` contains generated extension packages from WXT build and zip commands.
- Generated output belongs in `.wxt/`, `.output/`, and `build/`; do not edit it directly.

## Build, Test, and Development Commands

Use `pnpm` consistently.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:extension
pnpm verify:release
```

`pnpm dev` starts WXT locally. `pnpm typecheck` runs `vue-tsc --noEmit`. `pnpm lint` runs ESLint. `pnpm test` runs Vitest once. `pnpm build` creates `build/chrome-mv3`. `pnpm verify:extension` smoke-tests the unpacked extension; `pnpm verify:release` builds, zips, and validates the package.

## Coding Style & Naming Conventions

Write TypeScript as ES modules and prefer explicit domain types in `src/*/types.ts` or local module types. Vue components use PascalCase filenames, such as `LanguageSelector.vue`; tests use `*.test.ts` or `*.test.mjs`. Keep browser APIs in `src/browser/`, provider integrations in `src/provider/`, orchestration in `src/background/`, and DOM work in `src/content/`.

Formatting is enforced through ESLint, TypeScript, and Vue recommended rules. Keep comments sparse and focused on non-obvious intent.

## Testing Guidelines

Vitest uses `jsdom`, globals, mock restoration, and the `@` alias mapped to `src/`. Place tests under `tests/<area>/` and mirror the source module name, for example `tests/provider/resolver.test.ts`.

Add or update tests for non-trivial branching, provider behavior, DOM extraction, storage migrations, task orchestration, and messaging contracts. Before opening a PR, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

For extension workflow changes, also run `pnpm verify:extension`.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, for example `Validate stored UI preferences`. Keep commits focused and avoid mixing unrelated refactors with behavior changes.

Pull requests should include a concise summary, linked issue or design doc when relevant, test commands run, and screenshots for popup/options UI changes. For release-facing changes, mention affected docs under `docs/release/`, `docs/privacy/`, or `docs/qa/`.

## Security & Configuration Tips

Preserve privacy boundaries: API keys stay in local storage, content scripts must not receive secrets, and page text should only be sent after explicit user action. Avoid broad permissions unless they are documented in release and privacy materials.
