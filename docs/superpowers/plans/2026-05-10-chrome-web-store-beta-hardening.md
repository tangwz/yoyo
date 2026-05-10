# Chrome Web Store Beta Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Yoyo 1.1 for Chrome Web Store beta by adding first-run Provider onboarding, popup state reconstruction, privacy/permission release documentation, and release verification gates.

**Architecture:** Keep the existing WXT + Vue + TypeScript extension boundaries. Background owns Provider readiness and options routing; popup owns current-tab state presentation; content script owns page runtime state; docs and scripts make Chrome Web Store privacy, permission, and package checks reproducible.

**Tech Stack:** WXT, Vue 3, TypeScript, Vitest, Testing Library for Vue, happy-dom/jsdom, Playwright Core, Node.js release scripts, Chrome MV3.

---

## Scope Check

This plan implements the approved design in `docs/superpowers/specs/2026-05-10-chrome-web-store-beta-hardening-design.md`. The work is one cohesive hardening slice, not multiple independent feature subsystems.

The plan intentionally does not implement:

- Selection translation.
- Page summaries.
- Image or video translation.
- Service worker task continuation.
- Persistent storage of page text or translations.
- Automatic translation.
- A permission architecture rewrite.

## File Structure

Create or modify these files:

- Create: `src/provider/readiness.ts`
  - Defines `ProviderReadiness`, validates active provider profiles, and formats provider labels.
- Test: `tests/provider/readiness.test.ts`
  - Covers missing provider, invalid active provider, missing required fields, and ready provider.
- Modify: `src/messaging/contracts.ts`
  - Extends `providerStatus`, `openOptions`, and `pageRuntimeState` contracts.
- Modify: `tests/messaging/contracts.test.ts`
  - Locks message contract variants for Provider readiness and options routing.
- Create: `src/background/providerStatus.ts`
  - Builds Provider status responses without importing WXT entrypoints in tests.
- Modify: `entrypoints/background.ts`
  - Uses strict Provider readiness instead of falling back to the first profile; routes options opening with query parameters.
- Modify: `src/browser/browserApi.ts`
  - Adds URL-aware options opening for `section=provider&source=first-run`.
- Modify: `wxt.config.ts`
  - Sets options UI to open in a tab; removes unused `activeTab` and `scripting` if audit confirms no runtime call path.
- Modify: `entrypoints/popup/App.vue`
  - Reorders initialization: Provider readiness, active task, page runtime state, then page estimate.
  - Adds onboarding and existing-translation UI states.
- Test: `tests/ui/popup.test.ts`
  - Covers readiness-first initialization, first-run options opening, active task priority, existing translations, hide/show/remove, and no page estimate before Provider readiness.
- Modify: `src/content/injection.ts`
  - Exposes translation visibility state from DOM markers.
- Modify: `src/content/pageRuntime.ts`
  - Adds `visibility` to runtime state.
- Test: `tests/content/pageRuntime.test.ts`
  - Covers runtime state and hide/show/remove visibility.
- Modify: `entrypoints/options/App.vue`
  - Reads `section=provider&source=first-run`, makes Provider section the first-run landing point, and focuses the Provider form.
- Test: `tests/ui/options.test.ts`
  - Covers first-run landing behavior and existing Provider test invariants.
- Create: `docs/privacy/chrome-web-store-disclosure.md`
  - Documents actual data flow and Chrome Web Store privacy / Limited Use disclosure.
- Create: `docs/release/chrome-web-store-beta.md`
  - Documents beta release checklist, permission reasons, zip checks, known limitations, and release blockers.
- Modify: `docs/qa/manual-mvp-checklist.md`
  - Expands MVP checklist into beta readiness checklist.
- Create: `scripts/verify-release-package.mjs`
  - Validates build manifest permissions, zip root structure, and package exclusions.
- Modify: `package.json`
  - Adds `verify:release`.
- Modify: `scripts/verify-extension-smoke.mjs`
  - Adds first-run/privacy request-spy coverage.

## Task 1: Provider Readiness Contract

**Files:**
- Create: `src/provider/readiness.ts`
- Test: `tests/provider/readiness.test.ts`
- Modify: `src/messaging/contracts.ts`
- Modify: `tests/messaging/contracts.test.ts`

- [ ] **Step 1: Write failing Provider readiness tests**

Create `tests/provider/readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
} from "@/provider/readiness";
import type { ProviderProfile } from "@/provider/types";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "provider-1",
    displayName: "Work Provider",
    type: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    apiKey: "secret-key",
    textModel: "gpt-4.1-mini",
    ...overrides,
  };
}

describe("provider readiness", () => {
  it("requires an active provider id", () => {
    expect(evaluateProviderReadiness([], undefined)).toEqual({
      readiness: "missingProvider",
    });
    expect(evaluateProviderReadiness([profile()], undefined)).toEqual({
      readiness: "missingProvider",
    });
  });

  it("rejects an active id that does not match a saved profile", () => {
    expect(evaluateProviderReadiness([profile()], "missing-id")).toEqual({
      readiness: "invalidActiveProvider",
    });
  });

  it("reports missing required provider fields", () => {
    expect(
      evaluateProviderReadiness([profile({ apiKey: "   " })], "provider-1").readiness,
    ).toBe("missingApiKey");
    expect(
      evaluateProviderReadiness([profile({ baseURL: "" })], "provider-1").readiness,
    ).toBe("missingBaseURL");
    expect(
      evaluateProviderReadiness([profile({ textModel: " " })], "provider-1").readiness,
    ).toBe("missingTextModel");
  });

  it("returns ready with the active profile when required fields are present", () => {
    const activeProfile = profile();

    expect(evaluateProviderReadiness([activeProfile], "provider-1")).toEqual({
      readiness: "ready",
      profile: activeProfile,
    });
    expect(resolveReadyProviderProfile([activeProfile], "provider-1")).toBe(activeProfile);
  });

  it("formats bounded provider labels without exposing API keys", () => {
    expect(formatProviderLabel(profile())).toBe("Work Provider / api.example.com");
    expect(formatProviderLabel(undefined)).toBe("未配置翻译服务");
    expect(formatProviderLabel(profile({ baseURL: "not a url" }))).toBe("Work Provider");
  });
});
```

- [ ] **Step 2: Run the failing readiness test**

Run:

```bash
pnpm test tests/provider/readiness.test.ts
```

Expected: FAIL because `src/provider/readiness.ts` does not exist.

- [ ] **Step 3: Implement Provider readiness**

Create `src/provider/readiness.ts`:

```ts
import type { ProviderProfile } from "@/provider/types";

export type ProviderReadiness =
  | "ready"
  | "missingProvider"
  | "missingApiKey"
  | "missingBaseURL"
  | "missingTextModel"
  | "invalidActiveProvider";

export type ProviderReadinessResult = {
  readiness: ProviderReadiness;
  profile?: ProviderProfile;
};

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateProviderReadiness(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderReadinessResult {
  if (!activeProviderId) {
    return { readiness: "missingProvider" };
  }

  const profile = profiles.find((candidate) => candidate.id === activeProviderId);
  if (!profile) {
    return { readiness: "invalidActiveProvider" };
  }

  if (!hasText(profile.apiKey)) {
    return { readiness: "missingApiKey" };
  }

  if (!hasText(profile.baseURL)) {
    return { readiness: "missingBaseURL" };
  }

  if (!hasText(profile.textModel)) {
    return { readiness: "missingTextModel" };
  }

  return { readiness: "ready", profile };
}

export function resolveReadyProviderProfile(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderProfile | undefined {
  const result = evaluateProviderReadiness(profiles, activeProviderId);
  return result.readiness === "ready" ? result.profile : undefined;
}

export function formatProviderLabel(profile: ProviderProfile | undefined): string {
  if (!profile) {
    return "未配置翻译服务";
  }

  try {
    return `${profile.displayName} / ${new URL(profile.baseURL).host}`;
  } catch {
    return profile.displayName;
  }
}
```

- [ ] **Step 4: Run the Provider readiness test**

Run:

```bash
pnpm test tests/provider/readiness.test.ts
```

Expected: PASS.

- [ ] **Step 5: Extend messaging contract tests**

Modify `tests/messaging/contracts.test.ts` by replacing the provider configuration test with:

```ts
it("supports querying Provider readiness from the popup", () => {
  const request = { type: "getProviderStatus" } satisfies BackgroundRequest;
  const response = {
    type: "providerStatus",
    configured: false,
    readiness: "missingApiKey",
    providerLabel: "未配置翻译服务",
  } satisfies BackgroundResponse;

  expect(request.type).toBe("getProviderStatus");
  expect(response.configured).toBe(false);
  expect(response.readiness).toBe("missingApiKey");
});

it("supports opening options at a specific section", () => {
  const request = {
    type: "openOptions",
    section: "provider",
    source: "first-run",
  } satisfies BackgroundRequest;

  expect(request).toEqual({
    type: "openOptions",
    section: "provider",
    source: "first-run",
  });
});

it("supports page runtime visibility state", () => {
  const response = {
    type: "pageRuntimeState",
    hasTranslations: true,
    taskId: "task-1",
    visibility: "hidden",
  } satisfies ContentResponse;

  expect(response.visibility).toBe("hidden");
});
```

- [ ] **Step 6: Run the failing contract test**

Run:

```bash
pnpm test tests/messaging/contracts.test.ts
```

Expected: FAIL because the contract does not yet include `readiness`, `section`, `source`, or `visibility`.

- [ ] **Step 7: Update messaging contracts**

Modify `src/messaging/contracts.ts`:

```ts
import type { ProviderReadiness } from "@/provider/readiness";
import type {
  CancelReason,
  PageSegment,
  TranslationProgress,
  TranslationResultItem,
} from "@/translation/types";

export type PageTranslationEstimate = {
  canTranslate: boolean;
  estimatedSegments: number;
  estimatedChars: number;
  reason?: string;
};

export type OptionsSection = "provider";
export type OptionsOpenSource = "first-run" | "popup" | "manual";

export type ContentRequest =
  | { type: "estimatePage" }
  | { type: "collectSegments"; taskId: string }
  | { type: "applyTranslations"; taskId: string; items: TranslationResultItem[] }
  | { type: "hideTranslations"; taskId?: string }
  | { type: "showTranslations"; taskId?: string }
  | { type: "removeTranslations"; taskId?: string }
  | { type: "getPageRuntimeState" };

export type ContentResponse =
  | { type: "estimatePageResult"; estimate: PageTranslationEstimate }
  | { type: "collectSegmentsResult"; taskId: string; segments: PageSegment[] }
  | {
      type: "contentActionResult";
      success: boolean;
      appliedSegmentIds?: string[];
      failedSegmentIds?: string[];
      message?: string;
    }
  | {
      type: "pageRuntimeState";
      hasTranslations: boolean;
      taskId?: string;
      visibility?: "visible" | "hidden";
    }
  | { type: "contentError"; message: string };

export type BackgroundRequest =
  | {
      type: "translatePage";
      tabId: number;
      sourceLanguage: string;
      targetLanguage: string;
    }
  | { type: "cancelTask"; taskId: string; reason: CancelReason }
  | { type: "getTaskForTab"; tabId: number }
  | { type: "getProviderStatus" }
  | {
      type: "openOptions";
      section?: OptionsSection;
      source?: OptionsOpenSource;
    };

export type BackgroundResponse =
  | { type: "taskProgress"; progress: TranslationProgress }
  | {
      type: "providerStatus";
      configured: boolean;
      readiness: ProviderReadiness;
      providerLabel: string;
    }
  | { type: "backgroundActionResult"; success: true }
  | { type: "backgroundError"; message: string };
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
pnpm test tests/provider/readiness.test.ts tests/messaging/contracts.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/provider/readiness.ts src/messaging/contracts.ts tests/provider/readiness.test.ts tests/messaging/contracts.test.ts
git commit -m "feat: add provider readiness contract"
```

## Task 2: Background Readiness and Options Routing

**Files:**
- Create: `src/background/providerStatus.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/browser/browserApi.ts`
- Modify: `wxt.config.ts`
- Test: `tests/background/providerStatus.test.ts`

- [ ] **Step 1: Write background Provider status tests**

Create `tests/background/providerStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildProviderStatusResponse,
  selectReadyProviderProfile,
} from "@/background/providerStatus";
import type { ProviderProfile } from "@/provider/types";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "provider-1",
    displayName: "Work Provider",
    type: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    apiKey: "secret-key",
    textModel: "gpt-4.1-mini",
    ...overrides,
  };
}

describe("background provider status", () => {
  it("does not fall back to the first profile when active provider id is missing", () => {
    expect(selectReadyProviderProfile([profile()], undefined)).toBeUndefined();
    expect(buildProviderStatusResponse([profile()], undefined)).toEqual({
      type: "providerStatus",
      configured: false,
      readiness: "missingProvider",
      providerLabel: "未配置翻译服务",
    });
  });

  it("returns configured status only for the ready active provider", () => {
    expect(buildProviderStatusResponse([profile()], "provider-1")).toEqual({
      type: "providerStatus",
      configured: true,
      readiness: "ready",
      providerLabel: "Work Provider / api.example.com",
    });
  });

  it("reports incomplete active provider profiles as not configured", () => {
    expect(buildProviderStatusResponse([profile({ textModel: "" })], "provider-1")).toEqual({
      type: "providerStatus",
      configured: false,
      readiness: "missingTextModel",
      providerLabel: "未配置翻译服务",
    });
  });
});
```

- [ ] **Step 2: Run the failing background status test**

Run:

```bash
pnpm test tests/background/providerStatus.test.ts
```

Expected: FAIL because the exported helpers do not exist.

- [ ] **Step 3: Create background Provider status helpers**

Create `src/background/providerStatus.ts`:

```ts
import type { BackgroundResponse } from "@/messaging/contracts";
import {
  evaluateProviderReadiness,
  formatProviderLabel,
  resolveReadyProviderProfile,
} from "@/provider/readiness";
import type { ProviderProfile } from "@/provider/types";

export function selectReadyProviderProfile(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): ProviderProfile | undefined {
  return resolveReadyProviderProfile(profiles, activeProviderId);
}

export function buildProviderStatusResponse(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): Extract<BackgroundResponse, { type: "providerStatus" }> {
  const readiness = evaluateProviderReadiness(profiles, activeProviderId);
  const configured = readiness.readiness === "ready" && readiness.profile !== undefined;

  return {
    type: "providerStatus",
    configured,
    readiness: readiness.readiness,
    providerLabel: configured ? formatProviderLabel(readiness.profile) : "未配置翻译服务",
  };
}
```

- [ ] **Step 4: Use strict Provider readiness in the background entrypoint**

Modify `entrypoints/background.ts` imports:

```ts
import {
  buildProviderStatusResponse,
  selectReadyProviderProfile,
} from "@/background/providerStatus";
```

Remove the local `formatProviderLabel` helper from `entrypoints/background.ts`.

Replace `getActiveProfile` with:

```ts
async function getActiveProfile(): Promise<ProviderProfile | undefined> {
  const [activeProviderId, profiles] = await Promise.all([
    storage.providers.getActiveProviderId(),
    listProfiles(),
  ]);

  return selectReadyProviderProfile(profiles, activeProviderId);
}
```

Replace the `getProviderStatus` case with:

```ts
case "getProviderStatus": {
  const [activeProviderId, profiles] = await Promise.all([
    storage.providers.getActiveProviderId(),
    listProfiles(),
  ]);
  return buildProviderStatusResponse(profiles, activeProviderId);
}
```

- [ ] **Step 5: Update options opening in the browser adapter**

Modify `src/browser/browserApi.ts`:

```ts
import { browser } from "wxt/browser";
import type { OptionsOpenSource, OptionsSection } from "@/messaging/contracts";

export type ActiveTab = {
  id: number;
  url?: string;
  title?: string;
};

export type OpenOptionsInput = {
  section?: OptionsSection;
  source?: OptionsOpenSource;
};

function optionsPath(input: OpenOptionsInput = {}): string {
  const params = new URLSearchParams();

  if (input.section) {
    params.set("section", input.section);
  }

  if (input.source) {
    params.set("source", input.source);
  }

  const suffix = params.toString();
  return suffix ? `/options.html?${suffix}` : "/options.html";
}

export async function getActiveTab(): Promise<ActiveTab | undefined> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (tab?.id === undefined) {
    return undefined;
  }

  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
  };
}

export async function openOptionsPage(input: OpenOptionsInput = {}): Promise<void> {
  if (!input.section && !input.source) {
    await browser.runtime.openOptionsPage();
    return;
  }

  await browser.tabs.create({
    url: browser.runtime.getURL(optionsPath(input)),
  });
}

export async function notifyBasic(input: {
  id: string;
  title: string;
  message: string;
}): Promise<void> {
  await browser.notifications.create(input.id, {
    type: "basic",
    iconUrl: browser.runtime.getURL("/icon/128.png" as never),
    title: input.title,
    message: input.message,
  });
}
```

Replace the `openOptions` background message case with:

```ts
case "openOptions":
  await openOptionsPage({
    section: request.section,
    source: request.source,
  });
  return { type: "backgroundActionResult", success: true };
```

- [ ] **Step 6: Configure options as an independent tab and remove unused permissions**

Modify `wxt.config.ts` manifest:

```ts
manifest: {
  name: "悠悠阅读助手",
  description: "A privacy-conscious LLM reading and translation assistant.",
  version: "0.1.0",
  permissions: ["storage", "contextMenus", "notifications"],
  host_permissions: ["<all_urls>"],
  action: {
    default_title: "悠悠阅读助手",
  },
  options_ui: {
    page: "options.html",
    open_in_tab: true,
  },
},
```

Keep `notifications` because `src/browser/browserApi.ts` calls `browser.notifications.create` through `notifyBasic`. Remove `activeTab` and `scripting` because this plan does not use `chrome.scripting` or `activeTab` grant semantics.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm test tests/background/providerStatus.test.ts tests/messaging/contracts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/background/providerStatus.ts entrypoints/background.ts src/browser/browserApi.ts wxt.config.ts tests/background/providerStatus.test.ts
git commit -m "feat: harden provider readiness routing"
```

## Task 3: Popup Initialization State Machine

**Files:**
- Modify: `entrypoints/popup/App.vue`
- Test: `tests/ui/popup.test.ts`

- [ ] **Step 1: Replace popup first-run test with readiness-first expectations**

In `tests/ui/popup.test.ts`, update the default `getProviderStatus` mock to include readiness:

```ts
if (message.type === "getProviderStatus") {
  return {
    type: "providerStatus",
    configured: true,
    readiness: "ready",
    providerLabel: "OpenAI / api.openai.com",
  };
}
```

Replace `opens the options page from the settings button` with:

```ts
it("opens the options page from the settings button", async () => {
  render(PopupApp);

  await fireEvent.click(screen.getByRole("button", { name: "设置" }));

  expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
    type: "openOptions",
    source: "popup",
  });
});
```

Replace `shows a provider setup prompt for first-time users` with:

```ts
it("opens Provider settings and skips page estimate when Provider is not ready", async () => {
  browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "getProviderStatus") {
      return {
        type: "providerStatus",
        configured: false,
        readiness: "missingApiKey",
        providerLabel: "未配置翻译服务",
      };
    }

    if (message.type === "openOptions") {
      return { type: "backgroundActionResult", success: true };
    }

    return idleTaskProgress();
  });

  render(PopupApp);

  expect(await screen.findByText("未配置翻译服务")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "需要先配置 Provider，正在打开设置页面...",
  );

  await waitFor(() => {
    expect(browserMock.runtimeSendMessage).toHaveBeenCalledWith({
      type: "openOptions",
      section: "provider",
      source: "first-run",
    });
  });

  expect(browserMock.tabsQuery).not.toHaveBeenCalled();
  expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(
    expect.any(Number),
    { type: "estimatePage" },
  );
});
```

- [ ] **Step 2: Add popup state priority tests**

Append these tests to the popup app `describe` block:

```ts
it("shows running background task before page estimate", async () => {
  browserMock.runtimeSendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "getProviderStatus") {
      return {
        type: "providerStatus",
        configured: true,
        readiness: "ready",
        providerLabel: "OpenAI / api.openai.com",
      };
    }

    if (message.type === "getTaskForTab") {
      return {
        type: "taskProgress",
        progress: {
          taskId: "task-1",
          state: "translating",
          total: 32,
          translated: 8,
          failed: 1,
        },
      };
    }

    return idleTaskProgress();
  });

  render(PopupApp);

  expect(await screen.findByRole("button", { name: "取消翻译" })).toBeVisible();
  expect(screen.getByLabelText("Task progress")).toBeVisible();
  expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(123, {
    type: "estimatePage",
  });
});

it("shows existing translations before page estimate when no task is running", async () => {
  browserMock.tabsSendMessage.mockImplementation(async (_tabId: number, message: { type: string }) => {
    if (message.type === "getPageRuntimeState") {
      return {
        type: "pageRuntimeState",
        hasTranslations: true,
        taskId: "task-previous",
        visibility: "visible",
      };
    }

    return {
      type: "estimatePageResult",
      estimate: {
        canTranslate: true,
        estimatedSegments: 32,
        estimatedChars: 1200,
      },
    };
  });

  render(PopupApp);

  expect(await screen.findByText("页面已有译文")).toBeVisible();
  expect(screen.getByRole("button", { name: "重新翻译" })).toBeVisible();
  expect(screen.getByRole("button", { name: "隐藏译文" })).toBeVisible();
  expect(screen.getByRole("button", { name: "移除译文" })).toBeVisible();
  expect(browserMock.tabsSendMessage).not.toHaveBeenCalledWith(123, {
    type: "estimatePage",
  });
});
```

- [ ] **Step 3: Run failing popup tests**

Run:

```bash
pnpm test tests/ui/popup.test.ts
```

Expected: FAIL because popup still estimates before task/runtime reconstruction and does not open options through the background message.

- [ ] **Step 4: Update popup state types and labels**

Modify the top-level refs in `entrypoints/popup/App.vue`:

```ts
type PopupState = "idle" | "onboarding" | "translating" | "completed" | "existingTranslations" | "error";

const sourceLanguage = ref("auto");
const targetLanguage = ref("zh-CN");
const providerLabel = ref("正在读取翻译服务...");
const isProviderConfigured = ref(true);
const tabId = ref<number>();
const isInitializing = ref(true);
const canTranslate = ref(true);
const state = ref<PopupState>("idle");
const currentTaskId = ref("");
const translated = ref(0);
const total = ref(0);
const failed = ref(0);
const errorMessage = ref("");
const pageTranslationsVisible = ref(true);
```

Update `primaryLabel`:

```ts
const primaryLabel = computed(() => {
  if (state.value === "onboarding" || !isProviderConfigured.value) {
    return "打开设置";
  }

  if (state.value === "translating") {
    return "取消翻译";
  }

  if (state.value === "completed" || state.value === "existingTranslations") {
    return "重新翻译";
  }

  return "翻译当前页面";
});
```

- [ ] **Step 5: Add initialization helpers to popup**

Add these helpers in `entrypoints/popup/App.vue`:

```ts
function isRunningTask(response: BackgroundResponse): response is Extract<BackgroundResponse, { type: "taskProgress" }> {
  return (
    response.type === "taskProgress" &&
    response.progress.taskId.length > 0 &&
    (response.progress.state === "collecting" || response.progress.state === "translating")
  );
}

function applyProviderStatus(response: Extract<BackgroundResponse, { type: "providerStatus" }>) {
  isProviderConfigured.value = response.configured;
  providerLabel.value = response.providerLabel;

  if (!response.configured) {
    state.value = "onboarding";
    currentTaskId.value = "";
    errorMessage.value = "需要先配置 Provider，正在打开设置页面...";
  } else if (state.value === "onboarding") {
    state.value = "idle";
    errorMessage.value = "";
  }
}

async function openSettings(section?: "provider", source: "first-run" | "popup" = "popup"): Promise<void> {
  const request: BackgroundRequest = section
    ? { type: "openOptions", section, source }
    : { type: "openOptions", source };
  const response = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(request);

  if (response.type === "backgroundError") {
    throw new Error(response.message);
  }
}

async function loadPageRuntimeState(activeTabId: number): Promise<boolean> {
  const runtimeState = await sendTabMessage<ContentRequest, ContentResponse>(activeTabId, {
    type: "getPageRuntimeState",
  });

  if (runtimeState.type !== "pageRuntimeState" || !runtimeState.hasTranslations) {
    return false;
  }

  state.value = "existingTranslations";
  currentTaskId.value = runtimeState.taskId ?? "";
  pageTranslationsVisible.value = runtimeState.visibility !== "hidden";
  errorMessage.value = "";
  return true;
}
```

- [ ] **Step 6: Reorder popup `onMounted` initialization**

Replace the body of the `onMounted(async () => { ... })` callback with:

```ts
browser.runtime.onMessage.addListener(handleRuntimeMessage);

try {
  const providerStatus = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
    type: "getProviderStatus",
  });

  if (providerStatus.type === "providerStatus") {
    applyProviderStatus(providerStatus);
    if (!providerStatus.configured) {
      await openSettings("provider", "first-run").catch((error: unknown) => {
        errorMessage.value = error instanceof Error
          ? error.message
          : "无法自动打开设置页面，请点击打开设置。";
      });
      return;
    }
  }

  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (activeTab?.id === undefined) {
    return;
  }

  tabId.value = activeTab.id;

  const taskResponse = await sendRuntimeMessage<BackgroundRequest, BackgroundResponse>({
    type: "getTaskForTab",
    tabId: activeTab.id,
  });

  if (isRunningTask(taskResponse)) {
    applyProgress(taskResponse);
    return;
  }

  if (await loadPageRuntimeState(activeTab.id)) {
    return;
  }

  const response = await sendTabMessage<ContentRequest, ContentResponse>(activeTab.id, {
    type: "estimatePage",
  });

  if (response.type === "estimatePageResult") {
    canTranslate.value = response.estimate.canTranslate;
    total.value = response.estimate.estimatedSegments;
    if (!response.estimate.canTranslate) {
      errorMessage.value = response.estimate.reason ?? "当前页面不可翻译。";
    }
    return;
  }

  if (response.type === "contentError") {
    errorMessage.value = response.message;
  }
} catch (error: unknown) {
  errorMessage.value = error instanceof Error ? error.message : "无法读取当前页面。";
} finally {
  isInitializing.value = false;
}
```

- [ ] **Step 7: Update popup settings action**

Replace `onOpenSettings`:

```ts
async function onOpenSettings(): Promise<void> {
  try {
    await openSettings(undefined, "popup");
  } catch (error: unknown) {
    state.value = "error";
    errorMessage.value = error instanceof Error ? error.message : "无法打开设置页面。";
  }
}
```

Update the onboarding branch of `onPrimaryAction`:

```ts
if (state.value === "onboarding" || !isProviderConfigured.value) {
  await onOpenSettings();
  return;
}
```

- [ ] **Step 8: Update popup template for existing translations**

Add this block after `TaskProgress`:

```vue
<div
  v-if="state === 'existingTranslations'"
  class="existing-translations"
>
  <p>页面已有译文</p>
  <div class="translation-actions">
    <button
      class="secondary-action"
      type="button"
      @click="onToggleTranslations"
    >
      {{ pageTranslationsVisible ? "隐藏译文" : "显示译文" }}
    </button>
    <button
      class="secondary-action danger"
      type="button"
      @click="onRemoveTranslations"
    >
      移除译文
    </button>
  </div>
</div>
```

Add scoped CSS:

```css
.existing-translations {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #d9ddea;
  border-radius: 10px;
  background: #ffffff;
}

.existing-translations p {
  margin: 0;
  color: #34394a;
  font-size: 13px;
  font-weight: 650;
}

.translation-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.secondary-action {
  min-height: 34px;
  border: 1px solid #cbd1e1;
  border-radius: 8px;
  color: #293044;
  background: #ffffff;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.secondary-action.danger {
  color: #9b1c1c;
  border-color: #f0b9b9;
}
```

- [ ] **Step 9: Add existing translation handlers**

Add handlers in `entrypoints/popup/App.vue`:

```ts
async function onToggleTranslations(): Promise<void> {
  if (tabId.value === undefined) {
    return;
  }

  const message: ContentRequest = pageTranslationsVisible.value
    ? { type: "hideTranslations", taskId: currentTaskId.value || undefined }
    : { type: "showTranslations", taskId: currentTaskId.value || undefined };

  const response = await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, message);
  if (response.type === "contentActionResult" && response.success) {
    pageTranslationsVisible.value = !pageTranslationsVisible.value;
  }
}

async function onRemoveTranslations(): Promise<void> {
  if (tabId.value === undefined) {
    return;
  }

  const response = await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, {
    type: "removeTranslations",
    taskId: currentTaskId.value || undefined,
  });

  if (response.type === "contentActionResult" && response.success) {
    state.value = "idle";
    currentTaskId.value = "";
    errorMessage.value = "";
    pageTranslationsVisible.value = true;
  }
}
```

At the start of a non-onboarding translation in `onPrimaryAction`, clear existing translations if needed:

```ts
if (state.value === "existingTranslations" && tabId.value !== undefined) {
  await sendTabMessage<ContentRequest, ContentResponse>(tabId.value, {
    type: "removeTranslations",
    taskId: currentTaskId.value || undefined,
  });
}
```

- [ ] **Step 10: Run popup tests**

Run:

```bash
pnpm test tests/ui/popup.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add entrypoints/popup/App.vue tests/ui/popup.test.ts
git commit -m "feat: reconstruct popup page state"
```

## Task 4: Content Runtime Visibility

**Files:**
- Modify: `src/content/injection.ts`
- Modify: `src/content/pageRuntime.ts`
- Test: `tests/content/pageRuntime.test.ts`

- [ ] **Step 1: Add failing runtime state tests**

Append to `tests/content/pageRuntime.test.ts`:

```ts
import {
  applyTranslationResults,
  getPageRuntimeState,
  hidePageTranslations,
  removePageTranslations,
  showPageTranslations,
} from "@/content/pageRuntime";
```

Append these tests:

```ts
it("reports existing translation visibility", async () => {
  document.body.innerHTML = `
    <article>
      <p id="first">First readable paragraph.</p>
    </article>
  `;

  await collectSegments("task-1");
  applyTranslationResults("task-1", [
    { segmentId: "seg_1", translatedText: "Translated paragraph." },
  ]);

  expect(getPageRuntimeState()).toEqual({
    hasTranslations: true,
    taskId: "task-1",
    visibility: "visible",
  });

  hidePageTranslations("task-1");
  expect(getPageRuntimeState()).toEqual({
    hasTranslations: true,
    taskId: "task-1",
    visibility: "hidden",
  });

  showPageTranslations("task-1");
  expect(getPageRuntimeState()).toEqual({
    hasTranslations: true,
    taskId: "task-1",
    visibility: "visible",
  });
});

it("clears runtime state after removing translations", async () => {
  document.body.innerHTML = `
    <article>
      <p id="first">First readable paragraph.</p>
    </article>
  `;

  await collectSegments("task-1");
  removePageTranslations("task-1");

  expect(getPageRuntimeState()).toEqual({
    hasTranslations: false,
    taskId: undefined,
    visibility: undefined,
  });
});
```

- [ ] **Step 2: Run failing content runtime tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts
```

Expected: FAIL because runtime state has no `visibility`.

- [ ] **Step 3: Add translation state helper**

Add to `src/content/injection.ts`:

```ts
export type TranslationDomState = {
  hasTranslations: boolean;
  taskId?: string;
  visibility?: "visible" | "hidden";
};

export function getTranslationDomState(taskId?: string): TranslationDomState {
  const nodes = translationNodes(taskId);
  if (nodes.length === 0) {
    return { hasTranslations: false };
  }

  const firstTaskId = nodes[0].dataset.yoyoTaskId;
  const allHidden = nodes.every((node) => node.dataset.yoyoHidden === "true");

  return {
    hasTranslations: true,
    taskId: taskId ?? firstTaskId,
    visibility: allHidden ? "hidden" : "visible",
  };
}
```

- [ ] **Step 4: Use DOM state from page runtime**

Modify imports in `src/content/pageRuntime.ts`:

```ts
import {
  applyTranslations,
  getTranslationDomState,
  hideTranslations,
  insertPendingTranslations,
  removeTranslations,
  showTranslations,
} from "@/content/injection";
```

Replace `getPageRuntimeState`:

```ts
export function getPageRuntimeState(): {
  hasTranslations: boolean;
  taskId?: string;
  visibility?: "visible" | "hidden";
} {
  const state = getTranslationDomState(activeTaskId);
  return {
    hasTranslations: state.hasTranslations,
    taskId: state.taskId ?? activeTaskId,
    visibility: state.visibility,
  };
}
```

- [ ] **Step 5: Run content tests**

Run:

```bash
pnpm test tests/content/pageRuntime.test.ts tests/content/injection.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/content/injection.ts src/content/pageRuntime.ts tests/content/pageRuntime.test.ts
git commit -m "feat: expose translation runtime visibility"
```

## Task 5: Options First-Run Landing

**Files:**
- Modify: `entrypoints/options/App.vue`
- Test: `tests/ui/options.test.ts`

- [ ] **Step 1: Add failing first-run options test**

Update the existing `afterEach` in `tests/ui/options.test.ts`:

```ts
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/options.html");
});
```

Append to `tests/ui/options.test.ts`:

```ts
it("uses Provider as the first-run landing section", async () => {
  const focusMock = vi.fn();
  const scrollIntoViewMock = vi.fn();
  window.history.pushState({}, "", "/options.html?section=provider&source=first-run");
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(focusMock);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoViewMock);

  render(OptionsApp);

  expect(await screen.findByText("首次使用前，请先配置模型服务。")).toBeVisible();
  expect(scrollIntoViewMock).toHaveBeenCalled();
  expect(focusMock).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run failing options test**

Run:

```bash
pnpm test tests/ui/options.test.ts
```

Expected: FAIL because options does not read first-run query parameters.

- [ ] **Step 3: Add refs and first-run state to options**

Modify the Vue import in `entrypoints/options/App.vue`:

```ts
import { computed, nextTick, onMounted, ref, watch } from "vue";
```

Add refs:

```ts
const providerSection = ref<HTMLElement>();
const presetSelect = ref<HTMLSelectElement>();
const isFirstRunProviderLanding = ref(false);
```

Add this helper:

```ts
async function applyInitialRoute() {
  const params = new URLSearchParams(globalThis.location.search);
  if (params.get("section") !== "provider") {
    return;
  }

  isFirstRunProviderLanding.value = params.get("source") === "first-run";
  await nextTick();
  providerSection.value?.scrollIntoView({ block: "start" });
  presetSelect.value?.focus();
}
```

Replace `onMounted(loadActiveProviderProfile);` with:

```ts
onMounted(async () => {
  await loadActiveProviderProfile();
  await applyInitialRoute();
});
```

- [ ] **Step 4: Wire refs and first-run copy in template**

Update the Provider section opening tag:

```vue
<section
  ref="providerSection"
  class="settings-section"
  aria-labelledby="provider-heading"
>
```

Add first-run copy below the Provider heading:

```vue
<p
  v-if="isFirstRunProviderLanding"
  class="section-note"
>
  首次使用前，请先配置模型服务。
</p>
```

Add `ref="presetSelect"` to the Preset `<select>`:

```vue
<select
  ref="presetSelect"
  v-model="selectedPresetId"
  @change="applySelectedPreset"
>
```

Add scoped CSS:

```css
.section-note {
  margin: -4px 0 16px;
  color: #4d566f;
  font-size: 14px;
  line-height: 1.5;
}
```

- [ ] **Step 5: Run options tests**

Run:

```bash
pnpm test tests/ui/options.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/options/App.vue tests/ui/options.test.ts
git commit -m "feat: add first-run options landing"
```

## Task 6: Privacy, Permission, and Release Documentation

**Files:**
- Create: `docs/privacy/chrome-web-store-disclosure.md`
- Create: `docs/release/chrome-web-store-beta.md`
- Modify: `docs/qa/manual-mvp-checklist.md`
- Modify: `README.md`
- Modify: `README-zh.md`

- [ ] **Step 1: Create Chrome Web Store privacy disclosure**

Create `docs/privacy/chrome-web-store-disclosure.md`:

```md
# Chrome Web Store Privacy Disclosure

## Data Flow

Yoyo needs page access so it can run a content script, read visible article text, create stable anchors, and inject translation nodes below the original text.

`<all_urls>` is page access capability. It is not automatic data transmission.

Page text is sent to a model provider only when the user explicitly starts page translation from the popup or context menu. The destination is the OpenAI-compatible Provider configured by the user.

Provider connection testing sends only this fixed prompt:

```text
Reply with exactly: ok
```

Provider connection testing does not read page text.

## API Keys

Provider profiles and API keys are stored in `chrome.storage.local`.

API keys are not stored in `chrome.storage.sync`.

API keys are not sent to content scripts.

API keys are not injected into the webpage DOM.

## Project-Owned Services

Yoyo does not provide an account system.

Yoyo does not upload Provider configuration to a project-owned cloud service.

Yoyo does not upload webpage text to a project-owned cloud service.

## Chrome Web Store Privacy and Limited Use

Chrome Web Store privacy and Limited Use disclosures must match the actual data flow above:

- Page text is read only for user-triggered translation.
- Page text is sent only to the user's configured Provider during translation.
- Provider test requests send only the fixed test prompt.
- API keys stay in extension local storage and are used only for requests to the configured Provider.
```

- [ ] **Step 2: Create Chrome Web Store beta release checklist**

Create `docs/release/chrome-web-store-beta.md`:

```md
# Chrome Web Store Beta Release Checklist

## Build

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm verify:release`.

## Package

- [ ] `build/chrome-mv3` loads as an unpacked Chrome extension.
- [ ] The uploaded zip has `manifest.json` at the zip root.
- [ ] The uploaded zip does not include source files, tests, `.env`, logs, or temporary files.
- [ ] The uploaded zip matches the locally verified build output.

## Permissions

- [ ] `<all_urls>` is explained as page access capability: run content script, read visible body text, and inject translation nodes.
- [ ] `<all_urls>` is not described as automatic data transmission.
- [ ] `storage` is used for Provider profiles, API keys, language preferences, and local configuration.
- [ ] `contextMenus` is used for right-click page translation.
- [ ] `notifications` is retained only if right-click failure notifications are implemented.
- [ ] `activeTab` is absent unless a real call path requires it.
- [ ] `scripting` is absent unless a real call path requires it.

## Privacy

- [ ] Chrome Web Store privacy disclosure matches `docs/privacy/chrome-web-store-disclosure.md`.
- [ ] Limited Use disclosure matches actual data flow.
- [ ] Provider test sends only `Reply with exactly: ok`.
- [ ] Opening popup does not send Provider requests.
- [ ] First-run options opening does not send Provider requests.
- [ ] Page estimate does not send Provider requests.
- [ ] Page text is sent only after user-triggered translation.

## Known Limitations

- No automatic translation.
- No service worker task continuation.
- No full task progress recovery.
- No persistent page text cache.
- No persistent translation cache.
- Edge remains technically supported on a best-effort basis, but Chrome Web Store beta is the 1.1 release target.

## Release Blockers

- API key appears in content script messages, webpage DOM, `chrome.storage.sync`, logs, or error output.
- Page text is sent before the user starts translation.
- Provider is not configured but popup still triggers page estimate or page extraction.
- Popup shows an error or stalls when background state is gone and page translations already exist.
- Manifest keeps `activeTab` or `scripting` without an actual call path.
- Zip structure does not satisfy Chrome Web Store upload requirements.
- Chrome Web Store privacy or Limited Use disclosure does not match actual data flow.
```

- [ ] **Step 3: Expand manual QA checklist**

Replace `docs/qa/manual-mvp-checklist.md` with:

```md
# Yoyo Reading Assistant Beta Manual QA

## Build

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm zip`.
- [ ] Run `pnpm verify:extension`.
- [ ] Run `pnpm verify:release`.
- [ ] Load `build/chrome-mv3` in Chrome extension developer mode.

## First Run

- [ ] Open popup with no active Provider profile.
- [ ] Confirm popup opens an independent options tab.
- [ ] Confirm popup says Provider configuration is required.
- [ ] Confirm popup does not show a page unsupported error.
- [ ] Confirm popup does not estimate or extract page text before Provider readiness.

## Provider

- [ ] Open options page.
- [ ] Create an OpenAI-compatible Provider profile.
- [ ] Confirm API key is entered only in options page.
- [ ] Run Provider test connection.
- [ ] Confirm Provider test sends only `Reply with exactly: ok`.
- [ ] Confirm Provider test does not read page text.

## Popup State Reconstruction

- [ ] Translate a page.
- [ ] Close and reopen popup after translations are visible.
- [ ] Confirm popup shows `页面已有译文`.
- [ ] Hide translations.
- [ ] Show translations.
- [ ] Remove translations.
- [ ] Re-translate the page explicitly.

## Translation Pages

- [ ] Translate a normal blog article.
- [ ] Translate a technical documentation page.
- [ ] Translate a news article.
- [ ] Translate a long article and cancel mid-task.
- [ ] Translate a GitHub README or issue page.

## DOM Safety

- [ ] Code blocks are not translated.
- [ ] Tables are not translated.
- [ ] Forms and inputs are not translated.
- [ ] Hidden and aria-hidden content is not translated.
- [ ] Translation text mirrors source paragraph style on light, dark, and colored content.

## Privacy and Permissions

- [ ] `<all_urls>` is documented as page access capability: run content script, read visible body text, inject translation nodes.
- [ ] `<all_urls>` is not described as automatic data transmission.
- [ ] API key is not present in content script messages.
- [ ] API key is not present in webpage DOM.
- [ ] API key is not present in `chrome.storage.sync`.
- [ ] Full page text is not printed in logs.
- [ ] Opening popup does not send Provider requests.
- [ ] Page estimate does not send Provider requests.
- [ ] First-run options opening does not send Provider requests.
- [ ] Page text is sent only after clicking `翻译当前页面` or using the context menu.

## Chrome Web Store

- [ ] Zip has `manifest.json` at the root.
- [ ] Zip does not include source files, tests, `.env`, logs, or temporary files.
- [ ] Store description matches implemented behavior.
- [ ] Privacy disclosure matches actual data flow.
- [ ] Limited Use disclosure matches actual data flow.
- [ ] Permission reasons match manifest permissions.
```

- [ ] **Step 4: Update README links**

Add under the English README `Project Status` section:

```md
For Chrome Web Store beta preparation, see:

- `docs/superpowers/specs/2026-05-10-chrome-web-store-beta-hardening-design.md`
- `docs/superpowers/plans/2026-05-10-chrome-web-store-beta-hardening.md`
- `docs/privacy/chrome-web-store-disclosure.md`
- `docs/release/chrome-web-store-beta.md`
```

Add under the Chinese README `项目状态` section:

```md
Chrome Web Store beta 发布准备可参考：

- `docs/superpowers/specs/2026-05-10-chrome-web-store-beta-hardening-design.md`
- `docs/superpowers/plans/2026-05-10-chrome-web-store-beta-hardening.md`
- `docs/privacy/chrome-web-store-disclosure.md`
- `docs/release/chrome-web-store-beta.md`
```

- [ ] **Step 5: Review documentation for disclosure consistency**

Run:

```bash
rg -n "<all_urls>|Limited Use|Reply with exactly: ok|activeTab|scripting|notifications" README.md README-zh.md docs
```

Expected: Every hit describes the same data flow and permission semantics:

- `<all_urls>` means page access capability.
- Provider test uses `Reply with exactly: ok`.
- `activeTab` and `scripting` are blockers if retained without a call path.
- `notifications` is retained only when right-click failure notifications are implemented.

- [ ] **Step 6: Commit**

```bash
git add README.md README-zh.md docs/privacy/chrome-web-store-disclosure.md docs/release/chrome-web-store-beta.md docs/qa/manual-mvp-checklist.md
git commit -m "docs: add chrome beta release checklist"
```

## Task 7: Release Package Verification

**Files:**
- Create: `scripts/verify-release-package.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add release verification script**

Create `scripts/verify-release-package.mjs`:

```js
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const buildDir = resolve("build/chrome-mv3");
const buildManifestPath = join(buildDir, "manifest.json");
const forbiddenPatterns = [
  /^src\//,
  /^tests\//,
  /^docs\//,
  /^scripts\//,
  /\.env(?:\.|$)/,
  /\.log$/,
  /(?:^|\/)\.DS_Store$/,
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listZipEntries(path) {
  return execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findChromeZip() {
  const candidates = readdirSync(resolve("build"))
    .filter((name) => name.endsWith(".zip") && name.includes("chrome"))
    .map((name) => resolve("build", name))
    .sort();

  return candidates.at(-1);
}

assert(existsSync(buildManifestPath), "Missing build/chrome-mv3/manifest.json. Run pnpm build first.");

const manifest = readJson(buildManifestPath);
const permissions = new Set(manifest.permissions ?? []);

assert(permissions.has("storage"), "Missing storage permission.");
assert(permissions.has("contextMenus"), "Missing contextMenus permission.");
assert(permissions.has("notifications"), "Missing notifications permission while notification code is present.");
assert(!permissions.has("activeTab"), "activeTab is present without an approved call path.");
assert(!permissions.has("scripting"), "scripting is present without an approved call path.");
assert(
  Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes("<all_urls>"),
  "Missing <all_urls> host permission for page access capability.",
);

const zipPath = findChromeZip();
assert(zipPath, "Missing Chrome zip artifact. Run pnpm zip first.");

const entries = listZipEntries(zipPath);
assert(entries.includes("manifest.json"), "Zip must contain manifest.json at the root.");

for (const entry of entries) {
  const forbidden = forbiddenPatterns.find((pattern) => pattern.test(entry));
  assert(!forbidden, `Zip contains forbidden entry: ${entry}`);
}

console.log("Release package verification passed.");
console.log(`Checked manifest: ${buildManifestPath}`);
console.log(`Checked zip: ${zipPath}`);
```

- [ ] **Step 2: Add package script**

Modify `package.json` scripts:

```json
"verify:release": "pnpm build && pnpm zip && node scripts/verify-release-package.mjs"
```

- [ ] **Step 3: Run release verification**

Run:

```bash
pnpm verify:release
```

Expected: PASS after build and zip complete. If it fails because `unzip` is missing, replace `unzip -Z1` with a small ZIP parser or add an explicit dev dependency before committing.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/verify-release-package.mjs
git commit -m "test: verify chrome beta release package"
```

## Task 8: Smoke Test Privacy and First-Run Coverage

**Files:**
- Modify: `scripts/verify-extension-smoke.mjs`

- [ ] **Step 1: Add request spy assertions to the smoke script**

Extend `promptProbe` near the top of `scripts/verify-extension-smoke.mjs`:

```js
const promptProbe = {
  connectionTestPrompt: "",
  translationPrompts: [],
  requestsBeforeExplicitTranslation: 0,
};
```

Add helper:

```js
function countProviderRequests() {
  return Number(promptProbe.connectionTestPrompt !== "") + promptProbe.translationPrompts.length;
}
```

- [ ] **Step 2: Add first-run popup check before options configuration**

After `const { extensionId, serviceWorker } = await getExtensionServiceWorker(context);`, insert:

```js
const firstRunPopup = await context.newPage();
await firstRunPopup.goto(`chrome-extension://${extensionId}/popup.html`);
await firstRunPopup.getByText("需要先配置 Provider，正在打开设置页面...").waitFor({
  timeout: 5000,
});
await firstRunPopup.getByRole("button", { name: "打开设置" }).waitFor({
  timeout: 5000,
});
assert(
  countProviderRequests() === 0,
  "First-run popup opened or sent a provider request before explicit user action.",
);
await firstRunPopup.close();
```

If WXT outputs the popup at a different path, inspect `build/chrome-mv3/manifest.json` and use `manifest.action.default_popup`.

- [ ] **Step 3: Assert options opening and Provider test request boundaries**

Keep the existing options configuration flow. After options page loads and before clicking `测试连接`, assert:

```js
assert(
  countProviderRequests() === 0,
  "Opening options or filling Provider settings sent a provider request.",
);
```

After provider test succeeds, keep:

```js
assert(
  promptProbe.connectionTestPrompt === "Reply with exactly: ok",
  "Provider test did not use the fixed connection-test prompt.",
);
```

- [ ] **Step 4: Assert page load and popup estimate do not send Provider requests**

After opening the article and waiting for `main p`, insert:

```js
const requestsAfterProviderTest = countProviderRequests();
const articlePopup = await context.newPage();
await articlePopup.goto(`chrome-extension://${extensionId}/popup.html`);
await articlePopup.getByRole("button", { name: "翻译当前页面" }).waitFor({
  timeout: 5000,
});
await articlePopup.close();
assert(
  countProviderRequests() === requestsAfterProviderTest,
  "Opening popup or estimating the page sent a provider request before translation.",
);
```

- [ ] **Step 5: Assert existing translation reconstruction**

After translation nodes are injected and before the final success log, insert:

```js
const postTranslationPopup = await context.newPage();
await postTranslationPopup.goto(`chrome-extension://${extensionId}/popup.html`);
await postTranslationPopup.getByText("页面已有译文").waitFor({ timeout: 5000 });
await postTranslationPopup.getByRole("button", { name: "重新翻译" }).waitFor({
  timeout: 5000,
});
await postTranslationPopup.close();
```

- [ ] **Step 6: Run smoke verification**

Run:

```bash
pnpm verify:extension
```

Expected: PASS and output includes `Extension smoke test passed.`

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-extension-smoke.mjs
git commit -m "test: cover first-run privacy smoke flow"
```

## Task 9: Final Verification

**Files:**
- All files changed by Tasks 1-8.

- [ ] **Step 1: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with exit code 0.

- [ ] **Step 2: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS with exit code 0.

- [ ] **Step 3: Run unit tests**

Run:

```bash
pnpm test
```

Expected: PASS with all Vitest suites passing.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected: PASS and `build/chrome-mv3/manifest.json` exists.

- [ ] **Step 5: Run extension smoke test**

Run:

```bash
pnpm verify:extension
```

Expected: PASS and output includes `Extension smoke test passed.`

- [ ] **Step 6: Run release package verification**

Run:

```bash
pnpm verify:release
```

Expected: PASS and output includes `Release package verification passed.`

- [ ] **Step 7: Review final diff**

Run:

```bash
git status --short
git log --oneline -n 8
```

Expected:

- Worktree has only intentional changes or is clean after task commits.
- Recent commits correspond to the tasks above.
