# Chrome Built-in AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-configuration, local-only Chrome Built-in AI provider that supports full-page translation and context-menu selection translation through Chrome Translator API.

**Architecture:** Convert provider usage from OpenAI-only text generation to capability-based translation providers. Keep OpenAI-compatible translation behind an adapter, add a Chrome Built-in AI adapter for Translator API, and wire both into existing task orchestration and UI without automatic remote fallback.

**Tech Stack:** WXT, Vue 3, TypeScript, Vitest, Chrome MV3, Chrome Translator API.

---

## Scope Check

This plan covers one cohesive feature: a new local translation provider plus the minimum UI and message flow required to use it for full-page and context-menu selection translation. `Prompt API`, summaries, Q&A, floating selection buttons, image translation, video translation, and Edge support are outside this implementation plan.

## File Structure

Create these focused files:

- `src/provider/localAiErrors.ts`: local AI error codes, error class, and user-facing messages.
- `src/provider/browserSupport.ts`: browser and version detection helpers for Chrome Built-in AI gating.
- `src/provider/translationProvider.ts`: translation capability interfaces and common request/response types.
- `src/provider/openAiTranslationAdapter.ts`: adapter from OpenAI-compatible text generation to `TranslationProvider`.
- `src/provider/chromeBuiltInAi.ts`: Chrome Translator API detection, availability, download preparation, and translation calls.
- `src/provider/resolver.ts`: maps active `ProviderProfile` to a `TranslationProvider`.
- `src/background/selectionTranslation.ts`: background-side selection translation orchestration.
- `src/content/selectionPanel.ts`: lightweight content-side panel for selection translation results.

Modify these existing files:

- `src/provider/types.ts`: change provider profiles to a discriminated union.
- `src/provider/readiness.ts`: accept zero-config Chrome Built-in AI profile and expose browser support readiness.
- `src/provider/presets.ts`: add Chrome Built-in AI provider metadata or keep OpenAI presets separate and expose a Built-in constant.
- `src/storage/repositories.ts`: normalize legacy OpenAI profiles and Built-in profiles when reading storage.
- `src/background/providerStatus.ts`: include local-only status labels.
- `src/background/taskOrchestrator.ts`: depend on `TranslationProviderResolver` instead of `OpenAiCompatibleProvider`.
- `src/background/contextMenu.ts`: register page and selection menu items.
- `src/messaging/contracts.ts`: add selection translation and provider status fields.
- `entrypoints/background.ts`: instantiate resolver, Chrome Built-in provider, and selection translation handler.
- `entrypoints/options/App.vue`: add zero-config Built-in AI selection flow and Chrome 138+ requirement.
- `entrypoints/popup/App.vue`: display local-only provider state and selection-safe provider status.
- `entrypoints/content.ts`: route `showSelectionTranslation` messages.

Add or update tests:

- `tests/provider/types.test.ts`
- `tests/provider/browserSupport.test.ts`
- `tests/provider/readiness.test.ts`
- `tests/provider/openAiTranslationAdapter.test.ts`
- `tests/provider/chromeBuiltInAi.test.ts`
- `tests/provider/resolver.test.ts`
- `tests/background/taskOrchestrator.test.ts`
- `tests/background/contextMenu.test.ts`
- `tests/background/selectionTranslation.test.ts`
- `tests/content/selectionPanel.test.ts`
- `tests/messaging/contracts.test.ts`
- `tests/storage/repositories.test.ts`
- `tests/ui/options.test.ts`
- `tests/ui/popup.test.ts`

---

### Task 1: Provider Profile Types and Local AI Errors

**Files:**
- Modify: `src/provider/types.ts`
- Create: `src/provider/localAiErrors.ts`
- Create: `tests/provider/types.test.ts`
- Create: `tests/provider/localAiErrors.test.ts`

- [ ] **Step 1: Write provider profile type tests**

Create `tests/provider/types.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChromeBuiltInAiProviderProfile,
  OpenAiCompatibleProviderProfile,
  ProviderProfile,
} from "@/provider/types";

describe("provider profile types", () => {
  it("supports OpenAI-compatible profiles with remote provider settings", () => {
    const profile: ProviderProfile = {
      id: "openai",
      displayName: "OpenAI Compatible",
      type: "openai-compatible",
      baseURL: "https://api.example.test/v1",
      apiKey: "secret",
      textModel: "gpt-4.1-mini",
    };

    expect(profile.type).toBe("openai-compatible");
    expectTypeOf(profile).toMatchTypeOf<OpenAiCompatibleProviderProfile>();
  });

  it("supports Chrome Built-in AI profiles without remote provider settings", () => {
    const profile: ProviderProfile = {
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };

    expect(profile.type).toBe("chrome-built-in-ai");
    expectTypeOf(profile).toMatchTypeOf<ChromeBuiltInAiProviderProfile>();
  });
});
```

- [ ] **Step 2: Write local AI error tests**

Create `tests/provider/localAiErrors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  LocalAiError,
  formatLocalAiErrorMessage,
} from "@/provider/localAiErrors";

describe("local AI errors", () => {
  it("preserves local AI error codes", () => {
    const error = new LocalAiError(
      "browserUnsupported",
      "Chrome Built-in AI requires desktop Chrome 138 or later.",
    );

    expect(error.code).toBe("browserUnsupported");
    expect(error.message).toBe(
      "Chrome Built-in AI requires desktop Chrome 138 or later.",
    );
  });

  it("formats local-only user messages", () => {
    expect(formatLocalAiErrorMessage("languagePairUnavailable")).toBe(
      "Chrome Built-in AI is not available for this language pair. No remote provider was used.",
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm vitest run tests/provider/types.test.ts tests/provider/localAiErrors.test.ts
```

Expected: FAIL because `ChromeBuiltInAiProviderProfile`, `LocalAiError`, and `formatLocalAiErrorMessage` do not exist yet.

- [ ] **Step 4: Update provider profile types**

Replace `src/provider/types.ts` with:

```ts
export type ProviderType = "openai-compatible" | "chrome-built-in-ai";

export type ProviderPreset = {
  id: string;
  name: string;
  type: "openai-compatible";
  defaultBaseUrl: string;
  defaultTextModel?: string;
  defaultVisionModel?: string;
};

export type ProviderRequestParams = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type OpenAiCompatibleProviderProfile = {
  id: string;
  displayName: string;
  presetId?: string;
  type: "openai-compatible";
  baseURL: string;
  apiKey: string;
  textModel: string;
  visionModel?: string;
  requestParams?: ProviderRequestParams;
};

export type ChromeBuiltInAiProviderProfile = {
  id: "chrome-built-in-ai";
  displayName: string;
  type: "chrome-built-in-ai";
};

export type ProviderProfile =
  | OpenAiCompatibleProviderProfile
  | ChromeBuiltInAiProviderProfile;

export type GenerateTextRequest = {
  profile: OpenAiCompatibleProviderProfile;
  prompt: string;
  abortSignal?: AbortSignal;
};

export type GenerateTextResponse = {
  text: string;
  model: string;
};

export type StreamTextRequest = GenerateTextRequest;

export type StreamTextChunk = {
  text: string;
  model?: string;
};
```

- [ ] **Step 5: Add local AI error model**

Create `src/provider/localAiErrors.ts`:

```ts
export type LocalAiErrorCode =
  | "browserUnsupported"
  | "apiUnavailable"
  | "languagePairUnavailable"
  | "modelDownloadRequired"
  | "modelDownloadFailed"
  | "textTooLong"
  | "aborted"
  | "unknown";

export class LocalAiError extends Error {
  constructor(
    readonly code: LocalAiErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalAiError";
  }
}

export function formatLocalAiErrorMessage(code: LocalAiErrorCode): string {
  switch (code) {
    case "browserUnsupported":
      return "Chrome Built-in AI requires desktop Chrome 138 or later. No remote provider was used.";
    case "apiUnavailable":
      return "Chrome Built-in AI is not available in this browser. No remote provider was used.";
    case "languagePairUnavailable":
      return "Chrome Built-in AI is not available for this language pair. No remote provider was used.";
    case "modelDownloadRequired":
      return "Chrome needs to download a local translation model before translating this language pair. No remote provider was used.";
    case "modelDownloadFailed":
      return "Chrome could not download the local translation model. No remote provider was used.";
    case "textTooLong":
      return "The selected text is too long for Chrome Built-in AI. Select a shorter passage. No remote provider was used.";
    case "aborted":
      return "Chrome Built-in AI translation was cancelled. No remote provider was used.";
    case "unknown":
      return "Chrome Built-in AI translation failed. No remote provider was used.";
  }
}
```

- [ ] **Step 6: Run provider type and error tests**

Run:

```bash
pnpm vitest run tests/provider/types.test.ts tests/provider/localAiErrors.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/provider/types.ts src/provider/localAiErrors.ts tests/provider/types.test.ts tests/provider/localAiErrors.test.ts
git commit -m "feat: add Chrome Built-in AI provider types"
```

---

### Task 2: Browser Support and Readiness

**Files:**
- Create: `src/provider/browserSupport.ts`
- Modify: `src/provider/readiness.ts`
- Modify: `src/background/providerStatus.ts`
- Modify: `src/messaging/contracts.ts`
- Update: `tests/provider/browserSupport.test.ts`
- Update: `tests/provider/readiness.test.ts`
- Update: `tests/background/providerStatus.test.ts`

- [ ] **Step 1: Write browser support tests**

Create `tests/provider/browserSupport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getChromeBuiltInAiBrowserSupport,
  parseChromeMajorVersion,
} from "@/provider/browserSupport";

describe("browser support", () => {
  it("parses Chrome major versions", () => {
    expect(parseChromeMajorVersion("Mozilla/5.0 Chrome/138.0.7204.0 Safari/537.36")).toBe(138);
    expect(parseChromeMajorVersion("Mozilla/5.0 Edg/138.0.0.0 Safari/537.36")).toBeUndefined();
    expect(parseChromeMajorVersion("Mozilla/5.0 Firefox/126.0")).toBeUndefined();
  });

  it("allows desktop Chrome 138 or later", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/138.0.7204.0 Safari/537.36",
      }),
    ).toEqual({
      supported: true,
      reason: "supported",
      minimumChromeVersion: 138,
      detectedChromeVersion: 138,
    });
  });

  it("rejects Chrome versions below 138", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/137.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({
      supported: false,
      reason: "chromeVersionTooOld",
      detectedChromeVersion: 137,
    });
  });

  it("rejects Edge and Firefox", () => {
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 (Macintosh) Edg/138.0.0.0 Safari/537.36",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
    expect(
      getChromeBuiltInAiBrowserSupport({
        userAgent: "Mozilla/5.0 Firefox/126.0",
      }),
    ).toMatchObject({ supported: false, reason: "browserUnsupported" });
  });
});
```

- [ ] **Step 2: Add browser support helper**

Create `src/provider/browserSupport.ts`:

```ts
export const minimumChromeBuiltInAiVersion = 138;

export type ChromeBuiltInAiBrowserSupportReason =
  | "supported"
  | "browserUnsupported"
  | "chromeVersionTooOld"
  | "unknownChromeVersion";

export type ChromeBuiltInAiBrowserSupport = {
  supported: boolean;
  reason: ChromeBuiltInAiBrowserSupportReason;
  minimumChromeVersion: number;
  detectedChromeVersion?: number;
};

export function parseChromeMajorVersion(userAgent: string): number | undefined {
  if (/\b(?:Edg|OPR|Firefox)\//.test(userAgent)) {
    return undefined;
  }

  const match = /\bChrome\/(\d+)/.exec(userAgent);
  if (!match?.[1]) {
    return undefined;
  }

  const version = Number.parseInt(match[1], 10);
  return Number.isFinite(version) ? version : undefined;
}

export function getChromeBuiltInAiBrowserSupport(
  input: { userAgent?: string } = {},
): ChromeBuiltInAiBrowserSupport {
  const userAgent = input.userAgent ?? globalThis.navigator?.userAgent ?? "";
  const detectedChromeVersion = parseChromeMajorVersion(userAgent);

  if (/\b(?:Edg|OPR|Firefox)\//.test(userAgent) || !/\bChrome\//.test(userAgent)) {
    return {
      supported: false,
      reason: "browserUnsupported",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
      detectedChromeVersion,
    };
  }

  if (detectedChromeVersion === undefined) {
    return {
      supported: false,
      reason: "unknownChromeVersion",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
    };
  }

  if (detectedChromeVersion < minimumChromeBuiltInAiVersion) {
    return {
      supported: false,
      reason: "chromeVersionTooOld",
      minimumChromeVersion: minimumChromeBuiltInAiVersion,
      detectedChromeVersion,
    };
  }

  return {
    supported: true,
    reason: "supported",
    minimumChromeVersion: minimumChromeBuiltInAiVersion,
    detectedChromeVersion,
  };
}
```

- [ ] **Step 3: Update readiness tests for Built-in provider**

Add these cases to `tests/provider/readiness.test.ts`:

```ts
it("treats Chrome Built-in AI as ready when browser support is present", () => {
  const activeProfile: ProviderProfile = {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };

  expect(
    evaluateProviderReadiness([activeProfile], "chrome-built-in-ai", {
      chromeBuiltInAiBrowserSupport: {
        supported: true,
        reason: "supported",
        minimumChromeVersion: 138,
        detectedChromeVersion: 138,
      },
    }),
  ).toEqual({
    readiness: "ready",
    profile: activeProfile,
  });
});

it("rejects Chrome Built-in AI when Chrome is below the required version", () => {
  const activeProfile: ProviderProfile = {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };

  expect(
    evaluateProviderReadiness([activeProfile], "chrome-built-in-ai", {
      chromeBuiltInAiBrowserSupport: {
        supported: false,
        reason: "chromeVersionTooOld",
        minimumChromeVersion: 138,
        detectedChromeVersion: 137,
      },
    }).readiness,
  ).toBe("browserUnsupported");
});

it("formats Chrome Built-in AI provider labels without remote host details", () => {
  expect(
    formatProviderLabel({
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    }),
  ).toBe("Chrome Built-in AI / Local only");
});
```

- [ ] **Step 4: Extend readiness implementation**

Update `src/provider/readiness.ts` so the key definitions and functions are:

```ts
import {
  getChromeBuiltInAiBrowserSupport,
  type ChromeBuiltInAiBrowserSupport,
} from "@/provider/browserSupport";
import type { ProviderProfile } from "@/provider/types";

export type ProviderReadiness =
  | "ready"
  | "missingProvider"
  | "missingApiKey"
  | "missingBaseURL"
  | "missingTextModel"
  | "invalidActiveProvider"
  | "browserUnsupported";

type ProviderNotReady = Exclude<ProviderReadiness, "ready">;

export type ProviderReadinessContext = {
  chromeBuiltInAiBrowserSupport?: ChromeBuiltInAiBrowserSupport;
};

export type ProviderReadinessResult =
  | {
      readiness: "ready";
      profile: ProviderProfile;
    }
  | {
      readiness: ProviderNotReady;
      profile?: never;
    };

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isCompleteProfile(profile: ProviderProfile): boolean {
  if (profile.type === "chrome-built-in-ai") {
    return true;
  }

  return hasText(profile.apiKey) && hasText(profile.baseURL) && hasText(profile.textModel);
}

function isChromeBuiltInAiSupported(context: ProviderReadinessContext): boolean {
  return (
    context.chromeBuiltInAiBrowserSupport ?? getChromeBuiltInAiBrowserSupport()
  ).supported;
}

export function selectStoredActiveProviderId(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): string | undefined {
  if (hasText(activeProviderId) && profiles.some((profile) => profile.id === activeProviderId)) {
    return activeProviderId;
  }

  return profiles.find(isCompleteProfile)?.id;
}

export function evaluateProviderReadiness(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
  context: ProviderReadinessContext = {},
): ProviderReadinessResult {
  if (!hasText(activeProviderId)) {
    return { readiness: "missingProvider" };
  }

  const profile = profiles.find((candidate) => candidate.id === activeProviderId);
  if (!profile) {
    return { readiness: "invalidActiveProvider" };
  }

  if (profile.type === "chrome-built-in-ai") {
    return isChromeBuiltInAiSupported(context)
      ? { readiness: "ready", profile }
      : { readiness: "browserUnsupported" };
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
  context: ProviderReadinessContext = {},
): ProviderProfile | undefined {
  const result = evaluateProviderReadiness(profiles, activeProviderId, context);
  return result.readiness === "ready" ? result.profile : undefined;
}

export function formatProviderLabel(profile: ProviderProfile | undefined): string {
  if (!profile) {
    return "未配置翻译服务";
  }

  if (profile.type === "chrome-built-in-ai") {
    return `${profile.displayName} / Local only`;
  }

  try {
    return `${profile.displayName} / ${new URL(profile.baseURL).host}`;
  } catch {
    return profile.displayName;
  }
}
```

- [ ] **Step 5: Extend provider status contract**

In `src/messaging/contracts.ts`, extend provider status:

```ts
export type ProviderMode = "remote" | "local-only";
```

Update the `providerStatus` response shape:

```ts
| {
    type: "providerStatus";
    configured: boolean;
    readiness: ProviderReadiness;
    providerLabel: string;
    providerMode: ProviderMode;
  }
```

- [ ] **Step 6: Update provider status response builder**

Update `src/background/providerStatus.ts` so `buildProviderStatusResponse` includes `providerMode`:

```ts
export function buildProviderStatusResponse(
  profiles: ProviderProfile[],
  activeProviderId: string | undefined,
): Extract<BackgroundResponse, { type: "providerStatus" }> {
  const readiness = evaluateProviderReadiness(profiles, activeProviderId);

  return {
    type: "providerStatus",
    configured: readiness.readiness === "ready",
    readiness: readiness.readiness,
    providerLabel: formatProviderLabel(readiness.profile),
    providerMode:
      readiness.readiness === "ready" && readiness.profile.type === "chrome-built-in-ai"
        ? "local-only"
        : "remote",
  };
}
```

- [ ] **Step 7: Run readiness and status tests**

Run:

```bash
pnpm vitest run tests/provider/browserSupport.test.ts tests/provider/readiness.test.ts tests/background/providerStatus.test.ts tests/messaging/contracts.test.ts
```

Expected: PASS after updating existing provider status test expectations to include `providerMode`.

- [ ] **Step 8: Commit**

```bash
git add src/provider/browserSupport.ts src/provider/readiness.ts src/background/providerStatus.ts src/messaging/contracts.ts tests/provider/browserSupport.test.ts tests/provider/readiness.test.ts tests/background/providerStatus.test.ts tests/messaging/contracts.test.ts
git commit -m "feat: gate Chrome Built-in AI provider readiness"
```

---

### Task 3: Translation Provider Capability and OpenAI Adapter

**Files:**
- Create: `src/provider/translationProvider.ts`
- Create: `src/provider/openAiTranslationAdapter.ts`
- Create: `tests/provider/openAiTranslationAdapter.test.ts`
- Modify: `src/background/taskOrchestrator.ts`
- Update: `tests/background/taskOrchestrator.test.ts`

- [ ] **Step 1: Write OpenAI translation adapter test**

Create `tests/provider/openAiTranslationAdapter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import type { OpenAiCompatibleProviderProfile } from "@/provider/types";
import type { PageSegment } from "@/translation/types";

function profile(): OpenAiCompatibleProviderProfile {
  return {
    id: "openai",
    displayName: "OpenAI Compatible",
    type: "openai-compatible",
    baseURL: "https://api.example.test/v1",
    apiKey: "secret",
    textModel: "gpt-4.1-mini",
  };
}

function segment(id: string, sourceText: string): PageSegment {
  return {
    id,
    order: 1,
    sourceText,
    kind: "paragraph",
    pathHint: `body.${id}`,
    textHash: `hash-${id}`,
    priority: "viewport",
  };
}

describe("OpenAiTranslationAdapter", () => {
  it("translates page segments through the OpenAI-compatible provider", async () => {
    const generateText = vi.fn().mockResolvedValue({
      model: "gpt-4.1-mini",
      text: JSON.stringify({
        items: [
          { segmentId: "segment-1", translatedText: "你好。" },
          { segmentId: "segment-2", translatedText: "早上好。" },
        ],
      }),
    });
    const adapter = new OpenAiTranslationAdapter({ generateText });

    await expect(
      adapter.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          segment("segment-1", "Hello."),
          segment("segment-2", "Good morning."),
        ],
      }),
    ).resolves.toEqual({
      items: [
        { segmentId: "segment-1", translatedText: "你好。" },
        { segmentId: "segment-2", translatedText: "早上好。" },
      ],
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0].prompt).toContain("Target language: zh-CN");
  });
});
```

- [ ] **Step 2: Add translation provider interfaces**

Create `src/provider/translationProvider.ts`:

```ts
import type { ProviderProfile } from "@/provider/types";
import type { PageSegment, TranslationResultItem } from "@/translation/types";

export type TranslateTextRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  abortSignal?: AbortSignal;
};

export type TranslateTextResponse = {
  translatedText: string;
};

export type TranslateBatchRequest = {
  profile: ProviderProfile;
  sourceLanguage: string;
  targetLanguage: string;
  segments: PageSegment[];
  abortSignal?: AbortSignal;
};

export type TranslateBatchResponse = {
  items: TranslationResultItem[];
};

export type TranslationProvider = {
  translateText(request: TranslateTextRequest): Promise<TranslateTextResponse>;
  translateBatch(request: TranslateBatchRequest): Promise<TranslateBatchResponse>;
};
```

- [ ] **Step 3: Add OpenAI translation adapter**

Create `src/provider/openAiTranslationAdapter.ts`:

```ts
import type { TranslationProvider } from "@/provider/translationProvider";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  OpenAiCompatibleProviderProfile,
} from "@/provider/types";
import { parseTranslationBatchResult } from "@/translation/jsonResult";
import { buildTranslationPrompt } from "@/translation/prompt";

type OpenAiTextProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
};

function assertOpenAiProfile(
  profile: GenerateTextRequest["profile"],
): OpenAiCompatibleProviderProfile {
  return profile;
}

export class OpenAiTranslationAdapter implements TranslationProvider {
  constructor(private readonly provider: OpenAiTextProvider) {}

  async translateText(request: Parameters<TranslationProvider["translateText"]>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    const response = await this.translateBatch({
      profile: request.profile,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      abortSignal: request.abortSignal,
      segments: [
        {
          id: "selection",
          order: 1,
          sourceText: request.text,
          kind: "paragraph",
          pathHint: "selection",
          textHash: "selection",
          priority: "viewport",
        },
      ],
    });

    return {
      translatedText: response.items[0]?.translatedText ?? "",
    };
  }

  async translateBatch(request: Parameters<TranslationProvider["translateBatch"]>[0]) {
    if (request.profile.type !== "openai-compatible") {
      throw new Error("OpenAI translation adapter requires an OpenAI-compatible profile.");
    }

    const response = await this.provider.generateText({
      profile: assertOpenAiProfile(request.profile),
      prompt: buildTranslationPrompt({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        segments: request.segments,
      }),
      abortSignal: request.abortSignal,
    });

    return {
      items: parseTranslationBatchResult(response.text, request.segments),
    };
  }
}
```

- [ ] **Step 4: Refactor orchestrator dependency type**

In `src/background/taskOrchestrator.ts`, replace the provider dependency with:

```ts
import type { TranslationProvider } from "@/provider/translationProvider";
```

Update `TranslationTaskOrchestratorDependencies`:

```ts
export type TranslationTaskOrchestratorDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getProviderProfile: (providerId: string) => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  sendToContent: (tabId: number, message: ContentRequest) => Promise<ContentResponse>;
  emitProgress?: (progress: TranslationProgress, tabId: number) => void | Promise<void>;
  now: () => number;
  createTaskId: () => string;
};
```

In the batch processing method that currently calls `this.dependencies.provider.generateText`, replace prompt construction and parsing with:

```ts
const provider = this.dependencies.getTranslationProvider(context.profile);
const response = await provider.translateBatch({
  profile: context.profile,
  sourceLanguage: context.sourceLanguage,
  targetLanguage: context.targetLanguage,
  segments: batch,
  abortSignal: task.controller.signal,
});
const items = response.items;
```

Keep streaming logic in `OpenAiTranslationAdapter` out of scope for this task. If the orchestrator currently has a streaming fast path, remove that provider-specific path only after adding equivalent tests that prove non-streaming translation still completes and cancellation still aborts.

- [ ] **Step 5: Update orchestrator tests to use adapter shape**

In `tests/background/taskOrchestrator.test.ts`, update `createOrchestrator` to provide `getTranslationProvider`:

```ts
const translateBatch = vi.fn();

const orchestrator = new TranslationTaskOrchestrator({
  getActiveProfile,
  getProviderProfile,
  getTranslationProvider: () => ({ translateText: vi.fn(), translateBatch }),
  sendToContent,
  now,
  createTaskId,
  ...overrides,
});
```

Update assertions from `generateText` to `translateBatch`:

```ts
expect(translateBatch).toHaveBeenCalledTimes(1);
expect(translateBatch.mock.calls[0]?.[0]).toMatchObject({
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  segments: expect.arrayContaining([
    expect.objectContaining({ sourceText: "Hello world." }),
  ]),
});
expect(translateBatch.mock.calls[0]?.[0].abortSignal).toBeInstanceOf(AbortSignal);
```

- [ ] **Step 6: Run adapter and orchestrator tests**

Run:

```bash
pnpm vitest run tests/provider/openAiTranslationAdapter.test.ts tests/background/taskOrchestrator.test.ts
```

Expected: PASS with existing OpenAI-compatible full-page behavior preserved.

- [ ] **Step 7: Commit**

```bash
git add src/provider/translationProvider.ts src/provider/openAiTranslationAdapter.ts src/background/taskOrchestrator.ts tests/provider/openAiTranslationAdapter.test.ts tests/background/taskOrchestrator.test.ts
git commit -m "refactor: route page translation through provider capability"
```

---

### Task 4: Chrome Built-in Translator Provider and Resolver

**Files:**
- Create: `src/provider/chromeBuiltInAi.ts`
- Create: `src/provider/resolver.ts`
- Create: `tests/provider/chromeBuiltInAi.test.ts`
- Create: `tests/provider/resolver.test.ts`
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: Write Chrome Built-in provider tests**

Create `tests/provider/chromeBuiltInAi.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { LocalAiError } from "@/provider/localAiErrors";
import type { ChromeBuiltInAiProviderProfile } from "@/provider/types";

function profile(): ChromeBuiltInAiProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

describe("ChromeBuiltInTranslatorProvider", () => {
  it("translates text with the browser Translator API", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const create = vi.fn(async () => ({ translate }));
    const availability = vi.fn(async () => "available");
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({ availability, create }),
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).resolves.toEqual({ translatedText: "translated:Hello" });
    expect(availability).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    expect(create).toHaveBeenCalledWith({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
  });

  it("fails locally when the API is unavailable", async () => {
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => undefined,
    });

    await expect(
      provider.translateText({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "apiUnavailable",
    } satisfies Partial<LocalAiError>);
  });

  it("translates batches one item at a time", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);
    const provider = new ChromeBuiltInTranslatorProvider({
      getTranslatorApi: () => ({
        availability: vi.fn(async () => "available"),
        create: vi.fn(async () => ({ translate })),
      }),
    });

    await expect(
      provider.translateBatch({
        profile: profile(),
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        segments: [
          {
            id: "segment-1",
            order: 1,
            sourceText: "Hello",
            kind: "paragraph",
            pathHint: "body.p1",
            textHash: "hash-1",
            priority: "viewport",
          },
        ],
      }),
    ).resolves.toEqual({
      items: [{ segmentId: "segment-1", translatedText: "translated:Hello" }],
    });
  });
});
```

- [ ] **Step 2: Implement Chrome Built-in provider**

Create `src/provider/chromeBuiltInAi.ts`:

```ts
import { LocalAiError } from "@/provider/localAiErrors";
import type {
  TranslationProvider,
  TranslateBatchRequest,
  TranslateTextRequest,
} from "@/provider/translationProvider";

type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

type TranslatorCreateOptions = {
  sourceLanguage: string;
  targetLanguage: string;
};

type TranslatorInstance = {
  translate(text: string): Promise<string>;
  destroy?: () => void;
};

type TranslatorApi = {
  availability(options: TranslatorCreateOptions): Promise<TranslatorAvailability>;
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
};

type ChromeBuiltInTranslatorProviderDependencies = {
  getTranslatorApi?: () => TranslatorApi | undefined;
};

function getDefaultTranslatorApi(): TranslatorApi | undefined {
  const candidate = (globalThis as typeof globalThis & { Translator?: TranslatorApi }).Translator;
  return candidate;
}

function assertChromeBuiltInProfile(profile: TranslateTextRequest["profile"]): void {
  if (profile.type !== "chrome-built-in-ai") {
    throw new LocalAiError(
      "unknown",
      "Chrome Built-in AI translation requires a Chrome Built-in AI profile.",
    );
  }
}

export class ChromeBuiltInTranslatorProvider implements TranslationProvider {
  constructor(
    private readonly dependencies: ChromeBuiltInTranslatorProviderDependencies = {},
  ) {}

  async translateText(request: TranslateTextRequest) {
    assertChromeBuiltInProfile(request.profile);
    if (request.abortSignal?.aborted) {
      throw new LocalAiError("aborted", "Chrome Built-in AI translation was cancelled.");
    }

    const translatorApi =
      this.dependencies.getTranslatorApi?.() ?? getDefaultTranslatorApi();
    if (!translatorApi) {
      throw new LocalAiError(
        "apiUnavailable",
        "Chrome Built-in AI Translator API is not available.",
      );
    }

    const options = {
      sourceLanguage: request.sourceLanguage === "auto" ? "" : request.sourceLanguage,
      targetLanguage: request.targetLanguage,
    };
    const availability = await translatorApi.availability(options);
    if (availability === "unavailable") {
      throw new LocalAiError(
        "languagePairUnavailable",
        "Chrome Built-in AI is not available for this language pair.",
      );
    }
    if (availability === "downloadable" || availability === "downloading") {
      throw new LocalAiError(
        "modelDownloadRequired",
        "Chrome needs to download a local translation model before translating this language pair.",
      );
    }

    const translator = await translatorApi.create(options);
    try {
      return {
        translatedText: await translator.translate(request.text),
      };
    } catch (error) {
      if (request.abortSignal?.aborted) {
        throw new LocalAiError(
          "aborted",
          "Chrome Built-in AI translation was cancelled.",
          error,
        );
      }
      throw new LocalAiError(
        "unknown",
        "Chrome Built-in AI translation failed.",
        error,
      );
    } finally {
      translator.destroy?.();
    }
  }

  async translateBatch(request: TranslateBatchRequest) {
    const items = [];
    for (const segment of request.segments) {
      const response = await this.translateText({
        profile: request.profile,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        text: segment.sourceText,
        abortSignal: request.abortSignal,
      });
      items.push({
        segmentId: segment.id,
        translatedText: response.translatedText,
      });
    }

    return { items };
  }
}
```

- [ ] **Step 3: Write resolver tests**

Create `tests/provider/resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import { TranslationProviderResolver } from "@/provider/resolver";

describe("TranslationProviderResolver", () => {
  it("returns OpenAI adapter for OpenAI-compatible profiles", () => {
    const resolver = new TranslationProviderResolver({
      openAiProvider: { generateText: async () => ({ text: "{}", model: "test" }) },
      chromeBuiltInTranslatorProvider: new ChromeBuiltInTranslatorProvider(),
    });

    expect(
      resolver.getTranslationProvider({
        id: "openai",
        displayName: "OpenAI",
        type: "openai-compatible",
        baseURL: "https://api.example.test",
        apiKey: "secret",
        textModel: "gpt-4.1-mini",
      }),
    ).toBeInstanceOf(OpenAiTranslationAdapter);
  });

  it("returns Chrome Built-in translator for Chrome Built-in AI profiles", () => {
    const chromeProvider = new ChromeBuiltInTranslatorProvider();
    const resolver = new TranslationProviderResolver({
      openAiProvider: { generateText: async () => ({ text: "{}", model: "test" }) },
      chromeBuiltInTranslatorProvider: chromeProvider,
    });

    expect(
      resolver.getTranslationProvider({
        id: "chrome-built-in-ai",
        displayName: "Chrome Built-in AI",
        type: "chrome-built-in-ai",
      }),
    ).toBe(chromeProvider);
  });
});
```

- [ ] **Step 4: Implement resolver**

Create `src/provider/resolver.ts`:

```ts
import type { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { OpenAiTranslationAdapter } from "@/provider/openAiTranslationAdapter";
import type { TranslationProvider } from "@/provider/translationProvider";
import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderProfile,
} from "@/provider/types";

type OpenAiProvider = {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResponse>;
};

type TranslationProviderResolverDependencies = {
  openAiProvider: OpenAiProvider;
  chromeBuiltInTranslatorProvider: ChromeBuiltInTranslatorProvider;
};

export class TranslationProviderResolver {
  private readonly openAiTranslationAdapter: OpenAiTranslationAdapter;

  constructor(private readonly dependencies: TranslationProviderResolverDependencies) {
    this.openAiTranslationAdapter = new OpenAiTranslationAdapter(
      dependencies.openAiProvider,
    );
  }

  getTranslationProvider(profile: ProviderProfile): TranslationProvider {
    switch (profile.type) {
      case "openai-compatible":
        return this.openAiTranslationAdapter;
      case "chrome-built-in-ai":
        return this.dependencies.chromeBuiltInTranslatorProvider;
    }
  }
}
```

- [ ] **Step 5: Wire resolver in background**

In `entrypoints/background.ts`, add imports:

```ts
import { ChromeBuiltInTranslatorProvider } from "@/provider/chromeBuiltInAi";
import { TranslationProviderResolver } from "@/provider/resolver";
```

Replace provider setup:

```ts
const provider = new OpenAiCompatibleProvider();
const translationProviderResolver = new TranslationProviderResolver({
  openAiProvider: provider,
  chromeBuiltInTranslatorProvider: new ChromeBuiltInTranslatorProvider(),
});
```

Update orchestrator dependencies:

```ts
getTranslationProvider: (profile) =>
  translationProviderResolver.getTranslationProvider(profile),
```

- [ ] **Step 6: Run provider resolver and build checks**

Run:

```bash
pnpm vitest run tests/provider/chromeBuiltInAi.test.ts tests/provider/resolver.test.ts tests/background/taskOrchestrator.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/provider/chromeBuiltInAi.ts src/provider/resolver.ts entrypoints/background.ts tests/provider/chromeBuiltInAi.test.ts tests/provider/resolver.test.ts
git commit -m "feat: add Chrome Built-in translator provider"
```

---

### Task 5: Storage Normalization and Zero-Config Provider Selection

**Files:**
- Modify: `src/storage/repositories.ts`
- Modify: `src/provider/presets.ts`
- Modify: `entrypoints/options/App.vue`
- Update: `tests/storage/repositories.test.ts`
- Update: `tests/provider/presets.test.ts`
- Update: `tests/ui/options.test.ts`

- [ ] **Step 1: Write storage normalization tests**

Add to `tests/storage/repositories.test.ts`:

```ts
it("keeps Chrome Built-in AI profiles without requiring remote settings", async () => {
  const privateStorage = createInMemoryStorageArea();
  const repository = providerProfileRepository({ privateStorage });

  await repository.saveProfile({
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  });

  await expect(repository.listProfiles()).resolves.toEqual([
    {
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    },
  ]);
});
```

- [ ] **Step 2: Add Built-in provider constant**

In `src/provider/presets.ts`, add:

```ts
import type { ChromeBuiltInAiProviderProfile } from "@/provider/types";

export const chromeBuiltInAiProviderId = "chrome-built-in-ai";

export const chromeBuiltInAiProviderProfile: ChromeBuiltInAiProviderProfile = {
  id: chromeBuiltInAiProviderId,
  displayName: "Chrome Built-in AI",
  type: "chrome-built-in-ai",
};
```

Keep existing `providerPresets` limited to OpenAI-compatible presets.

- [ ] **Step 3: Normalize storage reads**

In `src/storage/repositories.ts`, add a profile parser:

```ts
function normalizeProviderProfile(value: unknown): ProviderProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "chrome-built-in-ai") {
    return {
      id: "chrome-built-in-ai",
      displayName:
        typeof value.displayName === "string" && value.displayName.trim()
          ? value.displayName
          : "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    };
  }

  if (value.type !== "openai-compatible") {
    return undefined;
  }

  return {
    id: typeof value.id === "string" ? value.id : "custom",
    displayName:
      typeof value.displayName === "string" ? value.displayName : "Custom Provider",
    presetId: typeof value.presetId === "string" ? value.presetId : undefined,
    type: "openai-compatible",
    baseURL: typeof value.baseURL === "string" ? value.baseURL : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    textModel: typeof value.textModel === "string" ? value.textModel : "",
    visionModel: typeof value.visionModel === "string" ? value.visionModel : undefined,
    requestParams: isRecord(value.requestParams) ? value.requestParams : undefined,
  };
}
```

Update `listProfiles`:

```ts
async function listProfiles(): Promise<ProviderProfile[]> {
  const result = await privateStorage.get({
    [storageKeys.providerProfiles]: [],
  });
  const rawProfiles = result[storageKeys.providerProfiles];
  return Array.isArray(rawProfiles)
    ? rawProfiles
        .map(normalizeProviderProfile)
        .filter((profile): profile is ProviderProfile => profile !== undefined)
    : [];
}
```

- [ ] **Step 4: Add options UI provider kind state**

In `entrypoints/options/App.vue`, import Built-in provider helpers:

```ts
import {
  chromeBuiltInAiProviderId,
  chromeBuiltInAiProviderProfile,
} from "@/provider/presets";
import { getChromeBuiltInAiBrowserSupport } from "@/provider/browserSupport";
```

Add state:

```ts
const selectedProviderType = ref<ProviderProfile["type"]>("openai-compatible");
const chromeBuiltInAiSupport = computed(() => getChromeBuiltInAiBrowserSupport());
const canSelectChromeBuiltInAi = computed(() => chromeBuiltInAiSupport.value.supported);
```

Update `buildProviderProfile`:

```ts
function buildProviderProfile(): ProviderProfile {
  if (selectedProviderType.value === "chrome-built-in-ai") {
    return chromeBuiltInAiProviderProfile;
  }

  const profileId = selectedPresetId.value;
  const modelContext = {
    id: profileId,
    presetId: selectedPresetId.value,
  };
  const normalizedTextModel = normalizeModelNameForProfile(modelContext, textModel.value);
  const normalizedVisionModel = visionModel.value.trim();

  return {
    id: profileId,
    displayName: displayName.value,
    presetId: selectedPresetId.value,
    type: "openai-compatible",
    baseURL: baseUrl.value,
    apiKey: apiKey.value,
    textModel: normalizedTextModel,
    visionModel: normalizedVisionModel || undefined,
    requestParams: {
      timeoutMs: normalizePositiveNumber(timeoutMs.value, 30000),
      temperature: normalizeTemperature(temperature.value),
      maxTokens: normalizePositiveInteger(maxTokens.value, 4096),
    },
  };
}
```

Update `applyProviderProfile`:

```ts
function applyProviderProfile(profile: ProviderProfile) {
  selectedProviderType.value = profile.type;

  if (profile.type === "chrome-built-in-ai") {
    selectedPresetId.value = chromeBuiltInAiProviderId;
    displayName.value = profile.displayName;
    return;
  }

  const presetId = profile.presetId ?? profile.id;
  selectedPresetId.value = providerPresets.some((item) => item.id === presetId)
    ? presetId
    : "custom";
  displayName.value = profile.displayName;
  baseUrl.value = profile.baseURL;
  apiKey.value = profile.apiKey;
  textModel.value = profile.textModel;
  visionModel.value = profile.visionModel ?? "";
  timeoutMs.value = profile.requestParams?.timeoutMs ?? 30000;
  temperature.value = profile.requestParams?.temperature ?? 0.3;
  maxTokens.value = profile.requestParams?.maxTokens ?? 4096;
}
```

- [ ] **Step 5: Update options template**

In `entrypoints/options/App.vue`, add provider type radios near the Provider section:

```vue
<fieldset class="provider-type-group">
  <legend>{{ t("providerType.legend") }}</legend>
  <label>
    <input
      v-model="selectedProviderType"
      type="radio"
      value="openai-compatible"
    />
    {{ t("providerType.openAiCompatible") }}
  </label>
  <label>
    <input
      v-model="selectedProviderType"
      type="radio"
      value="chrome-built-in-ai"
      :disabled="!canSelectChromeBuiltInAi"
    />
    {{ t("providerType.chromeBuiltInAi") }}
  </label>
  <p class="field-hint">
    {{ t("providerType.chromeBuiltInAiRequirement") }}
  </p>
  <p v-if="!canSelectChromeBuiltInAi" class="field-error">
    {{ t("providerType.chromeBuiltInAiUnavailable") }}
  </p>
</fieldset>
```

Wrap existing OpenAI-compatible fields in:

```vue
<template v-if="selectedProviderType === 'openai-compatible'">
  <!-- existing preset, base URL, API key, model, advanced fields, and test button -->
</template>
```

Add Built-in-only status:

```vue
<section v-else class="provider-local-card">
  <h3>Chrome Built-in AI</h3>
  <p>Runs locally in supported desktop Chrome versions. No API key required.</p>
  <p>Requires desktop Chrome 138 or later.</p>
</section>
```

- [ ] **Step 6: Add i18n message keys**

In `src/i18n/optionsMessages.ts`, add English-keyed message entries for both languages:

```ts
"providerType.legend": "Provider type",
"providerType.openAiCompatible": "OpenAI-compatible provider",
"providerType.chromeBuiltInAi": "Chrome Built-in AI",
"providerType.chromeBuiltInAiRequirement": "Requires desktop Chrome 138 or later. No API key required.",
"providerType.chromeBuiltInAiUnavailable": "Chrome Built-in AI is unavailable in this browser.",
```

Use localized Chinese values in the `zh-CN` message map and English values in `en-US`.

- [ ] **Step 7: Update options tests**

In `tests/ui/options.test.ts`, add assertions:

```ts
it("shows Chrome Built-in AI as a zero-configuration provider option", async () => {
  render(App);

  expect(await screen.findByText("Chrome Built-in AI")).toBeInTheDocument();
  expect(screen.getByText(/Chrome 138/)).toBeInTheDocument();
});
```

Use the existing test renderer and message language expectations in the file. If tests run in Chinese by default, assert the Chinese text from `optionsMessages`.

- [ ] **Step 8: Run storage and options tests**

Run:

```bash
pnpm vitest run tests/storage/repositories.test.ts tests/provider/presets.test.ts tests/ui/options.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/storage/repositories.ts src/provider/presets.ts src/i18n/optionsMessages.ts entrypoints/options/App.vue tests/storage/repositories.test.ts tests/provider/presets.test.ts tests/ui/options.test.ts
git commit -m "feat: add zero-config Built-in AI provider option"
```

---

### Task 6: Context Menu Selection Translation Contracts

**Files:**
- Modify: `src/messaging/contracts.ts`
- Modify: `src/background/contextMenu.ts`
- Create: `src/background/selectionTranslation.ts`
- Update: `tests/background/contextMenu.test.ts`
- Create: `tests/background/selectionTranslation.test.ts`

- [ ] **Step 1: Add message contract tests**

Update `tests/messaging/contracts.test.ts` with compile-time examples:

```ts
it("accepts selection translation background and content messages", () => {
  const backgroundRequest: BackgroundRequest = {
    type: "translateSelection",
    tabId: 7,
    text: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
  };
  const contentRequest: ContentRequest = {
    type: "showSelectionTranslation",
    sourceText: "Hello",
    translatedText: "你好",
  };

  expect(backgroundRequest.type).toBe("translateSelection");
  expect(contentRequest.type).toBe("showSelectionTranslation");
});
```

- [ ] **Step 2: Extend messaging contracts**

In `src/messaging/contracts.ts`, add to `ContentRequest`:

```ts
| {
    type: "showSelectionTranslation";
    sourceText: string;
    translatedText?: string;
    errorMessage?: string;
  }
```

Add to `BackgroundRequest`:

```ts
| {
    type: "translateSelection";
    tabId: number;
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
  }
```

- [ ] **Step 3: Extend context menu tests**

Add to `tests/background/contextMenu.test.ts`:

```ts
it("registers translate page and selection menu items", () => {
  registerContextMenus();

  expect(create).toHaveBeenCalledWith({
    id: translatePageMenuId,
    title: "Translate this page",
    contexts: ["page"],
  });
  expect(create).toHaveBeenCalledWith({
    id: translateSelectionMenuId,
    title: "Translate selection",
    contexts: ["selection"],
  });
});

it("routes selection clicks with selected text", async () => {
  const handler = vi.fn();

  onTranslateSelectionMenuClick(handler);

  const listener = addListener.mock.calls[0]?.[0];
  listener(
    {
      menuItemId: translateSelectionMenuId,
      selectionText: "Hello",
    },
    { id: 42 },
  );

  expect(handler).toHaveBeenCalledWith({
    tabId: 42,
    text: "Hello",
  });
});
```

- [ ] **Step 4: Update context menu implementation**

In `src/background/contextMenu.ts`, add:

```ts
export const translateSelectionMenuId = "yoyo.translateSelection";
```

Update `registerContextMenus`:

```ts
export function registerContextMenus(): void {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: translatePageMenuId,
      title: "Translate this page",
      contexts: ["page"],
    });
    browser.contextMenus.create({
      id: translateSelectionMenuId,
      title: "Translate selection",
      contexts: ["selection"],
    });
  });
}
```

Add selection click handler:

```ts
export type TranslateSelectionMenuInput = {
  tabId: number;
  text: string;
};

export function onTranslateSelectionMenuClick(
  handler: (input: TranslateSelectionMenuInput) => Promise<void>,
  onError: (error: unknown, tabId: number) => void = (error, tabId) => {
    console.error("[yoyo] failed to handle translate selection menu click", {
      tabId,
      error,
    });
  },
): void {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (
      info.menuItemId !== translateSelectionMenuId ||
      tab?.id === undefined ||
      typeof info.selectionText !== "string" ||
      info.selectionText.trim().length === 0
    ) {
      return;
    }

    const tabId = tab.id;

    void handler({ tabId, text: info.selectionText }).catch((error: unknown) => {
      onError(error, tabId);
    });
  });
}
```

- [ ] **Step 5: Write selection translation service tests**

Create `tests/background/selectionTranslation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { translateSelection } from "@/background/selectionTranslation";
import type { ProviderProfile } from "@/provider/types";

function profile(): ProviderProfile {
  return {
    id: "chrome-built-in-ai",
    displayName: "Chrome Built-in AI",
    type: "chrome-built-in-ai",
  };
}

describe("selection translation", () => {
  it("translates selected text through the active translation provider", async () => {
    const translateText = vi.fn(async () => ({ translatedText: "你好" }));
    const sendToContent = vi.fn(async () => ({ type: "contentActionResult", success: true }));

    await translateSelection(
      {
        tabId: 7,
        text: "Hello",
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      {
        getActiveProfile: async () => profile(),
        getTranslationProvider: () => ({ translateText, translateBatch: vi.fn() }),
        sendToContent,
      },
    );

    expect(translateText).toHaveBeenCalledWith({
      profile: profile(),
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      text: "Hello",
    });
    expect(sendToContent).toHaveBeenCalledWith(7, {
      type: "showSelectionTranslation",
      sourceText: "Hello",
      translatedText: "你好",
    });
  });
});
```

- [ ] **Step 6: Implement selection translation service**

Create `src/background/selectionTranslation.ts`:

```ts
import type { ContentRequest, ContentResponse } from "@/messaging/contracts";
import { formatLocalAiErrorMessage, LocalAiError } from "@/provider/localAiErrors";
import type { TranslationProvider } from "@/provider/translationProvider";
import type { ProviderProfile } from "@/provider/types";

export type TranslateSelectionInput = {
  tabId: number;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslateSelectionDependencies = {
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  sendToContent: (tabId: number, message: ContentRequest) => Promise<ContentResponse>;
};

function formatSelectionError(error: unknown): string {
  if (error instanceof LocalAiError) {
    return formatLocalAiErrorMessage(error.code);
  }

  return error instanceof Error ? error.message : "Selection translation failed.";
}

export async function translateSelection(
  input: TranslateSelectionInput,
  dependencies: TranslateSelectionDependencies,
): Promise<void> {
  const text = input.text.trim();
  if (!text) {
    return;
  }

  const profile = await dependencies.getActiveProfile();
  if (!profile) {
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      sourceText: text,
      errorMessage: "No active provider profile.",
    });
    return;
  }

  try {
    const response = await dependencies.getTranslationProvider(profile).translateText({
      profile,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      text,
    });
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      sourceText: text,
      translatedText: response.translatedText,
    });
  } catch (error) {
    await dependencies.sendToContent(input.tabId, {
      type: "showSelectionTranslation",
      sourceText: text,
      errorMessage: formatSelectionError(error),
    });
  }
}
```

- [ ] **Step 7: Run context menu and selection tests**

Run:

```bash
pnpm vitest run tests/messaging/contracts.test.ts tests/background/contextMenu.test.ts tests/background/selectionTranslation.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/messaging/contracts.ts src/background/contextMenu.ts src/background/selectionTranslation.ts tests/messaging/contracts.test.ts tests/background/contextMenu.test.ts tests/background/selectionTranslation.test.ts
git commit -m "feat: add selection translation background contract"
```

---

### Task 7: Content Selection Result Panel

**Files:**
- Create: `src/content/selectionPanel.ts`
- Modify: `entrypoints/content.ts`
- Create: `tests/content/selectionPanel.test.ts`

- [ ] **Step 1: Write selection panel tests**

Create `tests/content/selectionPanel.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { showSelectionTranslation } from "@/content/selectionPanel";

describe("selection panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders translated selection text", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      translatedText: "你好",
    });

    expect(document.body.textContent).toContain("Hello");
    expect(document.body.textContent).toContain("你好");
  });

  it("replaces previous panel content", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      translatedText: "你好",
    });
    showSelectionTranslation({
      sourceText: "Good morning",
      translatedText: "早上好",
    });

    expect(document.body.textContent).not.toContain("Hello");
    expect(document.body.textContent).toContain("Good morning");
  });

  it("renders error messages", () => {
    showSelectionTranslation({
      sourceText: "Hello",
      errorMessage: "Chrome Built-in AI is unavailable.",
    });

    expect(document.body.textContent).toContain("Chrome Built-in AI is unavailable.");
  });
});
```

- [ ] **Step 2: Implement selection panel**

Create `src/content/selectionPanel.ts`:

```ts
export type SelectionTranslationPanelInput = {
  sourceText: string;
  translatedText?: string;
  errorMessage?: string;
};

const panelId = "yoyo-selection-translation-panel";

function removeExistingPanel(): void {
  document.getElementById(panelId)?.remove();
}

function createTextBlock(label: string, text: string): HTMLElement {
  const block = document.createElement("div");
  const heading = document.createElement("strong");
  const body = document.createElement("p");

  heading.textContent = label;
  body.textContent = text;
  block.append(heading, body);
  return block;
}

export function showSelectionTranslation(input: SelectionTranslationPanelInput): void {
  removeExistingPanel();

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.style.position = "fixed";
  panel.style.right = "24px";
  panel.style.bottom = "24px";
  panel.style.zIndex = "2147483647";
  panel.style.maxWidth = "360px";
  panel.style.padding = "12px";
  panel.style.borderRadius = "12px";
  panel.style.background = "#111827";
  panel.style.color = "#f9fafb";
  panel.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.24)";
  panel.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";

  panel.append(createTextBlock("Source", input.sourceText));
  if (input.errorMessage) {
    panel.append(createTextBlock("Error", input.errorMessage));
  } else {
    panel.append(createTextBlock("Translation", input.translatedText ?? ""));
  }

  document.body.append(panel);
}
```

- [ ] **Step 3: Wire content message handling**

In `entrypoints/content.ts`, import:

```ts
import { showSelectionTranslation } from "@/content/selectionPanel";
```

In the existing content request switch, add:

```ts
case "showSelectionTranslation":
  showSelectionTranslation({
    sourceText: request.sourceText,
    translatedText: request.translatedText,
    errorMessage: request.errorMessage,
  });
  return { type: "contentActionResult", success: true };
```

- [ ] **Step 4: Run content panel tests**

Run:

```bash
pnpm vitest run tests/content/selectionPanel.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/selectionPanel.ts entrypoints/content.ts tests/content/selectionPanel.test.ts
git commit -m "feat: show selection translation panel"
```

---

### Task 8: Background Wiring for Built-in Full Page and Selection Translation

**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `src/background/notifications.ts`
- Update: `tests/background/taskOrchestrator.test.ts`
- Create or update: `tests/background/backgroundWiring.test.ts` if the project already has a background wiring test pattern

- [ ] **Step 1: Wire selection menu in background**

In `entrypoints/background.ts`, update imports:

```ts
import {
  onTranslatePageMenuClick,
  onTranslateSelectionMenuClick,
  registerContextMenus,
} from "@/background/contextMenu";
import { translateSelection } from "@/background/selectionTranslation";
```

After `onTranslatePageMenuClick(...)`, add:

```ts
onTranslateSelectionMenuClick(
  async ({ tabId, text }) => {
    await translateSelection(
      {
        tabId,
        text,
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
      },
      {
        getActiveProfile,
        getTranslationProvider: (profile) =>
          translationProviderResolver.getTranslationProvider(profile),
        sendToContent: (targetTabId, message) =>
          sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
      },
    );
  },
  (error, tabId) => {
    console.error("[yoyo] failed to handle translate selection menu click", {
      tabId,
      error,
    });
  },
);
```

- [ ] **Step 2: Add runtime message handling for selection translation**

In the `addRuntimeMessageListener` switch in `entrypoints/background.ts`, add:

```ts
case "translateSelection":
  await translateSelection(request, {
    getActiveProfile,
    getTranslationProvider: (profile) =>
      translationProviderResolver.getTranslationProvider(profile),
    sendToContent: (targetTabId, message) =>
      sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
  });
  return { type: "backgroundActionResult", success: true };
```

- [ ] **Step 3: Ensure full-page Built-in path cannot call OpenAI provider**

Add an orchestrator test that uses a Chrome Built-in profile and a fake provider:

```ts
it("uses the resolved translation provider for Chrome Built-in AI profiles", async () => {
  const translateBatch = vi.fn(async () => ({
    items: [{ segmentId: "segment-1", translatedText: "你好，世界。" }],
  }));
  const { orchestrator, sendToContent } = createOrchestrator({
    getActiveProfile: async () => ({
      id: "chrome-built-in-ai",
      displayName: "Chrome Built-in AI",
      type: "chrome-built-in-ai",
    }),
    getTranslationProvider: () => ({
      translateText: vi.fn(),
      translateBatch,
    }),
  });

  sendToContent.mockImplementation(async (_tabId, message) => {
    if (message.type === "collectSegments") {
      return {
        type: "collectSegmentsResult",
        taskId: message.taskId,
        segments: [segment()],
      };
    }

    return { type: "contentActionResult", success: true };
  });

  await expect(
    orchestrator.translatePage({
      tabId: 7,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    }),
  ).resolves.toMatchObject({ state: "completed" });
  expect(translateBatch).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 4: Run background integration tests**

Run:

```bash
pnpm vitest run tests/background/taskOrchestrator.test.ts tests/background/selectionTranslation.test.ts tests/background/contextMenu.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts tests/background/taskOrchestrator.test.ts
git commit -m "feat: wire Built-in AI translation flows"
```

---

### Task 9: Popup Local-Only Status and UI Tests

**Files:**
- Modify: `entrypoints/popup/App.vue`
- Update: `tests/ui/popup.test.ts`

- [ ] **Step 1: Update popup provider status handling test**

In `tests/ui/popup.test.ts`, add a mock provider status response:

```ts
{
  type: "providerStatus",
  configured: true,
  readiness: "ready",
  providerLabel: "Chrome Built-in AI / Local only",
  providerMode: "local-only",
}
```

Add an assertion:

```ts
expect(await screen.findByText(/Local only/)).toBeInTheDocument();
```

Use the existing mocked runtime message helpers from the test file.

- [ ] **Step 2: Add provider mode state in popup**

In `entrypoints/popup/App.vue`, add:

```ts
const providerMode = ref<"remote" | "local-only">("remote");
```

Update `applyProviderStatus`:

```ts
function applyProviderStatus(response: Extract<BackgroundResponse, { type: "providerStatus" }>) {
  isProviderConfigured.value = response.configured;
  providerLabel.value = response.providerLabel;
  providerMode.value = response.providerMode;

  if (!response.configured) {
    state.value = "onboarding";
    currentTaskId.value = "";
    errorMessage.value =
      response.readiness === "browserUnsupported"
        ? "Chrome Built-in AI requires desktop Chrome 138 or later."
        : "需要先配置 Provider，正在打开设置页面...";
  } else if (state.value === "onboarding") {
    state.value = "idle";
    errorMessage.value = "";
  }
}
```

Pass `providerMode` to the provider card if `ProviderCard.vue` supports extra metadata. If it does not, add a small text line near the current provider label:

```vue
<p v-if="providerMode === 'local-only'" class="provider-mode">
  Local only. No remote provider will be used.
</p>
```

- [ ] **Step 3: Run popup tests**

Run:

```bash
pnpm vitest run tests/ui/popup.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add entrypoints/popup/App.vue tests/ui/popup.test.ts
git commit -m "feat: show local-only provider status"
```

---

### Task 10: Final Verification and Documentation Cross-Check

**Files:**
- Modify: `README.md` if the feature is ready for user-facing documentation.
- Modify: `README-zh.md` if the feature is ready for user-facing documentation.
- Modify: `docs/privacy/chrome-web-store-disclosure.md` if permission or privacy disclosure text changes.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run tests/provider/types.test.ts tests/provider/localAiErrors.test.ts tests/provider/browserSupport.test.ts tests/provider/readiness.test.ts tests/provider/openAiTranslationAdapter.test.ts tests/provider/chromeBuiltInAi.test.ts tests/provider/resolver.test.ts tests/background/taskOrchestrator.test.ts tests/background/contextMenu.test.ts tests/background/selectionTranslation.test.ts tests/content/selectionPanel.test.ts tests/messaging/contracts.test.ts tests/storage/repositories.test.ts tests/ui/options.test.ts tests/ui/popup.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run standard verification**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit successfully.

- [ ] **Step 3: Manual browser checks**

Use a supported desktop Chrome version and an unsupported browser/version:

```text
Chrome 137 or lower:
- Chrome Built-in AI provider option is disabled or clearly unavailable.
- The UI says desktop Chrome 138 or later is required.

Chrome 138 or later:
- Chrome Built-in AI provider option is visible.
- Selecting it does not ask for Base URL, API Key, or model name.
- Popup displays Chrome Built-in AI / Local only.
- Full-page translation uses the resolved local translation provider.
- Context-menu selection translation shows a page panel with translated text or a local-only error.

Firefox or Edge:
- Chrome Built-in AI is unavailable or unsupported.
- No remote fallback is triggered by choosing Built-in AI.
```

- [ ] **Step 4: Update documentation only if the feature is user-visible in the target release**

If the feature ships in the next beta, add to `README.md`:

```markdown
- Chrome Built-in AI provider: on supported desktop Chrome versions, Yoyo can translate locally with no API key. This mode is local-only and does not fall back to remote providers automatically.
```

Add to `README-zh.md`:

```markdown
- Chrome Built-in AI Provider：在支持的桌面版 Chrome 中，悠悠可以无需 API Key 使用本地翻译能力。该模式是 local-only，不会自动回退到远端 Provider。
```

If the feature is hidden behind unreleased UI or not enabled for beta, do not update README files in this task.

- [ ] **Step 5: Commit final documentation changes if any**

If documentation changed:

```bash
git add README.md README-zh.md docs/privacy/chrome-web-store-disclosure.md
git commit -m "docs: document Chrome Built-in AI provider"
```

If documentation did not change:

```bash
git status --short
```

Expected: no uncommitted implementation changes remain.

---

## Self-Review

Spec coverage:

- Zero-configuration `Chrome Built-in AI` provider is covered by Tasks 1, 2, and 5.
- Chrome 138+ version gate is covered by Task 2 and surfaced in Task 5.
- Full-page translation through a capability resolver is covered by Tasks 3, 4, and 8.
- Context-menu selection translation is covered by Tasks 6, 7, and 8.
- Local-only provider semantics are covered by Tasks 1, 2, 4, 6, and 9.
- No automatic remote fallback is enforced by resolver and selection/full-page tests in Tasks 4, 6, and 8.
- Runtime API and language-pair availability are covered by Task 4.
- Model download prompt is represented as `modelDownloadRequired`; a richer confirmation UI can be added after the initial local error path is validated.
- Floating selection button is intentionally out of scope and only the reusable message path is created.

Placeholder scan:

- The plan contains no `TBD` or incomplete task placeholders.
- Every code-changing task includes concrete code snippets or exact replacement points.
- Every task includes a focused test command and expected result.

Type consistency:

- `ProviderProfile` is consistently modeled as a discriminated union.
- `TranslationProvider` request and response names are reused consistently across adapter, resolver, orchestrator, and selection translation tasks.
- `providerMode` is consistently `"remote" | "local-only"` across contracts and popup UI.
