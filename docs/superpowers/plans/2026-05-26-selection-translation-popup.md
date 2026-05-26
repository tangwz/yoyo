# Selection Translation Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a selection-anchored translation popup with provider dropdown, copy action, and selection-scoped provider preference.

**Architecture:** Content owns popup UI, positioning, copy, and stale-result guards. Background owns provider option resolution, selection-scoped provider preference, and translation execution. Storage adds a small synced preference that does not change global `activeProviderId`.

**Tech Stack:** WXT MV3, TypeScript, DOM APIs, Vitest, jsdom, pnpm.

---

## 文件结构

- `src/storage/defaults.ts`：新增 selection translation preference 类型与默认值。
- `src/storage/storageKeys.ts`：新增 `yoyo.selectionTranslationPreferences` key。
- `src/storage/repositories.ts`：新增 selection translation preference repository，并挂到 `createStorageRepositories()`。
- `src/messaging/contracts.ts`：新增 selection popup provider option、popup state、config/result response，以及 provider-specific translate request。
- `src/background/selectionTranslation.ts`：扩展 provider 选择、配置生成、provider-specific 翻译和 request id 结果。
- `src/background/contextMenuActions.ts`：让 context menu 划词翻译不再预取 global active provider。
- `entrypoints/background.ts`：接入新 storage repository 和 background message handlers。
- `entrypoints/content.ts`：把 runtime message sender 注入 selection popup runtime。
- `src/content/selectionPanel.ts`：重写为弹窗 runtime，负责渲染、定位、下拉切换、复制、关闭和 stale result guard。
- `tests/storage/repositories.test.ts`：覆盖新 repository。
- `tests/messaging/contracts.test.ts`：覆盖新消息类型。
- `tests/background/selectionTranslation.test.ts`：覆盖 selection provider resolution 和 provider-specific 翻译。
- `tests/background/contextMenuActions.test.ts`：覆盖 context menu 不再绑定 global active provider。
- `tests/content/selectionPanel.test.ts`：覆盖 popup UI、交互和隐私标记。

---

### Task 1: Selection Translation Preference Storage

**Files:**
- Modify: `src/storage/defaults.ts`
- Modify: `src/storage/storageKeys.ts`
- Modify: `src/storage/repositories.ts`
- Test: `tests/storage/repositories.test.ts`

- [ ] **Step 1: Write failing storage tests**

Add `selectionTranslationPreferenceRepository` and `defaultSelectionTranslationPreferences` to the imports in `tests/storage/repositories.test.ts`:

```ts
import {
  createInMemoryStorageArea,
  providerProfileRepository,
  selectionTranslationPreferenceRepository,
  subtitlePreferenceRepository,
  translationPreferenceRepository,
  uiPreferenceRepository,
} from "@/storage/repositories";
import {
  defaultSelectionTranslationPreferences,
} from "@/storage/defaults";
```

Add these tests inside `describe("storage repositories", () => { ... })`:

```ts
it("stores selection translation preferences in sync storage", async () => {
  const local = createInMemoryStorageArea();
  const sync = createInMemoryStorageArea();
  const repository = selectionTranslationPreferenceRepository({
    syncedStorage: sync,
  });

  await expect(repository.get()).resolves.toEqual(
    defaultSelectionTranslationPreferences,
  );

  await repository.save({ providerId: "provider-1" });

  expect(await sync.get("yoyo.selectionTranslationPreferences")).toEqual({
    "yoyo.selectionTranslationPreferences": { providerId: "provider-1" },
  });
  expect(await local.get("yoyo.selectionTranslationPreferences")).toEqual({});
});

it("normalizes corrupt selection translation preferences", async () => {
  const sync = createInMemoryStorageArea();
  const repository = selectionTranslationPreferenceRepository({
    syncedStorage: sync,
  });

  for (const storedValue of [null, "", 1, true, ["provider-1"]]) {
    await sync.set({ "yoyo.selectionTranslationPreferences": storedValue });

    await expect(repository.get()).resolves.toEqual(
      defaultSelectionTranslationPreferences,
    );
  }
});

it("drops invalid selection translation provider ids", async () => {
  const sync = createInMemoryStorageArea();
  const repository = selectionTranslationPreferenceRepository({
    syncedStorage: sync,
  });

  for (const providerId of ["", "   ", 1, true, null, ["provider-1"]]) {
    await sync.set({
      "yoyo.selectionTranslationPreferences": { providerId },
    });

    await expect(repository.get()).resolves.toEqual(
      defaultSelectionTranslationPreferences,
    );
  }
});
```

- [ ] **Step 2: Run storage tests and verify failure**

Run:

```bash
pnpm test tests/storage/repositories.test.ts
```

Expected: fail because `selectionTranslationPreferenceRepository` and `defaultSelectionTranslationPreferences` are not exported.

- [ ] **Step 3: Add storage defaults and key**

In `src/storage/defaults.ts`, add:

```ts
export type SelectionTranslationPreferences = {
  providerId?: string;
};

export const defaultSelectionTranslationPreferences: SelectionTranslationPreferences = {};
```

In `src/storage/storageKeys.ts`, add:

```ts
selectionTranslationPreferences: "yoyo.selectionTranslationPreferences",
```

- [ ] **Step 4: Implement repository**

In `src/storage/repositories.ts`, import the new default/type:

```ts
import {
  defaultSelectionTranslationPreferences,
  defaultTranslationPreferences,
  defaultUiPreferences,
  isUiLanguage,
  type SelectionTranslationPreferences,
  type UiPreferences,
} from "@/storage/defaults";
```

Add the dependency type:

```ts
type SelectionTranslationPreferenceRepositoryDependencies = {
  syncedStorage: StorageArea;
};
```

Add the normalizer near other normalizers:

```ts
function normalizeSelectionTranslationPreferences(
  value: unknown,
): SelectionTranslationPreferences {
  if (!isRecord(value)) {
    return defaultSelectionTranslationPreferences;
  }

  const providerId =
    typeof value.providerId === "string" && value.providerId.trim().length > 0
      ? value.providerId
      : undefined;

  return providerId === undefined ? {} : { providerId };
}
```

Add the repository:

```ts
export function selectionTranslationPreferenceRepository({
  syncedStorage,
}: SelectionTranslationPreferenceRepositoryDependencies) {
  async function get(): Promise<SelectionTranslationPreferences> {
    const result = await syncedStorage.get({
      [storageKeys.selectionTranslationPreferences]:
        defaultSelectionTranslationPreferences,
    });

    return normalizeSelectionTranslationPreferences(
      result[storageKeys.selectionTranslationPreferences],
    );
  }

  async function save(preferences: SelectionTranslationPreferences): Promise<void> {
    await syncedStorage.set({
      [storageKeys.selectionTranslationPreferences]:
        normalizeSelectionTranslationPreferences(preferences),
    });
  }

  return { get, save };
}
```

Extend `StorageRepositories`:

```ts
selectionTranslationPreferences: ReturnType<
  typeof selectionTranslationPreferenceRepository
>;
```

Extend `createStorageRepositories()`:

```ts
selectionTranslationPreferences: selectionTranslationPreferenceRepository({
  syncedStorage: storage.sync,
}),
```

- [ ] **Step 5: Run storage tests and verify pass**

Run:

```bash
pnpm test tests/storage/repositories.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/defaults.ts src/storage/storageKeys.ts src/storage/repositories.ts tests/storage/repositories.test.ts
git commit -m "Add selection translation preferences"
```

---

### Task 2: Messaging Contract for Selection Popup

**Files:**
- Modify: `src/messaging/contracts.ts`
- Test: `tests/messaging/contracts.test.ts`

- [ ] **Step 1: Write failing messaging tests**

In `tests/messaging/contracts.test.ts`, add a test after the existing selection translation request test:

```ts
it("supports selection translation popup configuration", () => {
  const request = {
    type: "getSelectionTranslationConfig",
  } satisfies BackgroundRequest;

  const response = {
    type: "selectionTranslationConfig",
    configured: true,
    targetLanguage: "zh-CN",
    selectedProviderId: "provider-1",
    providerOptions: [
      {
        id: "provider-1",
        label: "DeepSeek / deepseek-v4-flash",
        providerMode: "remote",
      },
      {
        id: "chrome-built-in-ai",
        label: "Chrome Built-in AI",
        providerMode: "local-only",
      },
    ],
  } satisfies BackgroundResponse;

  expect(request.type).toBe("getSelectionTranslationConfig");
  expect(response.providerOptions[0]?.label).toBe(
    "DeepSeek / deepseek-v4-flash",
  );
});

it("supports saving the selection translation provider", () => {
  const request = {
    type: "setSelectionTranslationProvider",
    providerId: "provider-1",
  } satisfies BackgroundRequest;

  expect(request).toEqual({
    type: "setSelectionTranslationProvider",
    providerId: "provider-1",
  });
});

it("supports provider-specific selection translation requests", () => {
  const request = {
    type: "translateSelectionWithProvider",
    requestId: "selection-request-1",
    text: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    providerId: "provider-1",
  } satisfies BackgroundRequest;

  const result = {
    type: "selectionTranslationResult",
    requestId: "selection-request-1",
    providerId: "provider-1",
    translatedText: "你好",
  } satisfies BackgroundResponse;

  const error = {
    type: "selectionTranslationError",
    requestId: "selection-request-2",
    providerId: "provider-1",
    message: "Provider failed.",
  } satisfies BackgroundResponse;

  expect(request.providerId).toBe("provider-1");
  expect(result.translatedText).toBe("你好");
  expect(error.message).toBe("Provider failed.");
});

it("supports selection translation popup states in content messages", () => {
  const loading = {
    type: "showSelectionTranslation",
    requestId: "selection-request-1",
    state: "loading",
    sourceText: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    selectedProviderId: "provider-1",
    providerOptions: [
      {
        id: "provider-1",
        label: "DeepSeek / deepseek-v4-flash",
        providerMode: "remote",
      },
    ],
  } satisfies ContentRequest;

  const translated = {
    ...loading,
    state: "translated",
    translatedText: "你好",
  } satisfies ContentRequest;

  const failed = {
    ...loading,
    state: "failed",
    errorMessage: "Provider failed.",
  } satisfies ContentRequest;

  expect(loading.state).toBe("loading");
  expect(translated.translatedText).toBe("你好");
  expect(failed.errorMessage).toBe("Provider failed.");
});
```

- [ ] **Step 2: Run messaging tests and verify failure**

Run:

```bash
pnpm test tests/messaging/contracts.test.ts
```

Expected: fail because the new request/response variants and `providerMode` option type do not exist.

- [ ] **Step 3: Add contract types**

In `src/messaging/contracts.ts`, add:

```ts
export type SelectionTranslationProviderOption = {
  id: string;
  label: string;
  providerMode: ProviderMode;
};
```

Replace the two current `showSelectionTranslation` content variants with:

```ts
  | {
      type: "showSelectionTranslation";
      requestId: string;
      state: "loading";
      sourceText: string;
      sourceLanguage: string;
      targetLanguage: string;
      selectedProviderId?: string;
      providerOptions: SelectionTranslationProviderOption[];
    }
  | {
      type: "showSelectionTranslation";
      requestId: string;
      state: "translated";
      sourceText: string;
      sourceLanguage: string;
      targetLanguage: string;
      selectedProviderId?: string;
      providerOptions: SelectionTranslationProviderOption[];
      translatedText: string;
    }
  | {
      type: "showSelectionTranslation";
      requestId: string;
      state: "failed";
      sourceText: string;
      sourceLanguage: string;
      targetLanguage: string;
      selectedProviderId?: string;
      providerOptions: SelectionTranslationProviderOption[];
      errorMessage: string;
    }
```

Add to `BackgroundRequest`:

```ts
  | { type: "getSelectionTranslationConfig" }
  | {
      type: "setSelectionTranslationProvider";
      providerId: string;
    }
  | {
      type: "translateSelectionWithProvider";
      requestId: string;
      text: string;
      sourceLanguage: string;
      targetLanguage: string;
      providerId: string;
    }
```

Add to `BackgroundResponse`:

```ts
  | {
      type: "selectionTranslationConfig";
      configured: true;
      targetLanguage: string;
      selectedProviderId: string;
      providerOptions: SelectionTranslationProviderOption[];
    }
  | {
      type: "selectionTranslationConfig";
      configured: false;
      targetLanguage: string;
      selectedProviderId?: never;
      providerOptions: SelectionTranslationProviderOption[];
      message: string;
    }
  | {
      type: "selectionTranslationResult";
      requestId: string;
      providerId: string;
      translatedText: string;
    }
  | {
      type: "selectionTranslationError";
      requestId: string;
      providerId?: string;
      message: string;
    }
```

- [ ] **Step 4: Run messaging tests and verify pass**

Run:

```bash
pnpm test tests/messaging/contracts.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/contracts.ts tests/messaging/contracts.test.ts
git commit -m "Add selection translation message contracts"
```

---

### Task 3: Background Provider Resolution and Translation

**Files:**
- Modify: `src/background/selectionTranslation.ts`
- Modify: `src/background/contextMenuActions.ts`
- Test: `tests/background/selectionTranslation.test.ts`
- Test: `tests/background/contextMenuActions.test.ts`

- [ ] **Step 1: Write failing background tests for provider resolution**

In `tests/background/selectionTranslation.test.ts`, extend the dependency mocks:

```ts
const listProfiles = vi.fn<TranslateSelectionDependencies["listProfiles"]>();
const getSelectionProviderId = vi.fn<
  TranslateSelectionDependencies["getSelectionProviderId"]
>();
```

Reset and default them in `beforeEach`:

```ts
listProfiles.mockReset();
getSelectionProviderId.mockReset();

listProfiles.mockResolvedValue([openAiProfile, chromeBuiltInProfile]);
getSelectionProviderId.mockResolvedValue("provider-1");
```

Return them from `dependencies()`:

```ts
return {
  listProfiles,
  getSelectionProviderId,
  getActiveProfile,
  getTranslationProvider,
  detectSourceLanguage,
  prepareChromeBuiltInAi,
  sendToContent,
};
```

Add tests:

```ts
it("uses the saved selection provider by default", async () => {
  const secondProfile = {
    id: "provider-2",
    displayName: "Second Provider",
    type: "openai-compatible",
    baseURL: "https://api.second.example.com/v1",
    apiKey: "sk-second",
    textModel: "gpt-5",
  } satisfies ProviderProfile;
  listProfiles.mockResolvedValue([openAiProfile, secondProfile]);
  getSelectionProviderId.mockResolvedValue("provider-2");

  await translateSelection(
    {
      tabId: 42,
      requestId: "selection-request-1",
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    },
    dependencies(),
  );

  expect(translateText).toHaveBeenCalledWith(
    expect.objectContaining({ profile: secondProfile }),
  );
  expect(sendToContent).toHaveBeenCalledWith(
    42,
    expect.objectContaining({
      type: "showSelectionTranslation",
      requestId: "selection-request-1",
      state: "translated",
      selectedProviderId: "provider-2",
      translatedText: "你好",
    }),
  );
});

it("uses an explicit provider id over the saved selection provider", async () => {
  const secondProfile = {
    id: "provider-2",
    displayName: "Second Provider",
    type: "openai-compatible",
    baseURL: "https://api.second.example.com/v1",
    apiKey: "sk-second",
    textModel: "gpt-5",
  } satisfies ProviderProfile;
  listProfiles.mockResolvedValue([openAiProfile, secondProfile]);
  getSelectionProviderId.mockResolvedValue("provider-1");

  await translateSelection(
    {
      tabId: 42,
      requestId: "selection-request-2",
      providerId: "provider-2",
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    },
    dependencies(),
  );

  expect(translateText).toHaveBeenCalledWith(
    expect.objectContaining({ profile: secondProfile }),
  );
});

it("falls back when the saved selection provider is unavailable", async () => {
  listProfiles.mockResolvedValue([openAiProfile]);
  getSelectionProviderId.mockResolvedValue("missing-provider");

  await translateSelection(
    {
      tabId: 42,
      requestId: "selection-request-3",
      text: "Hello",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
    },
    dependencies(),
  );

  expect(translateText).toHaveBeenCalledWith(
    expect.objectContaining({ profile: openAiProfile }),
  );
});
```

- [ ] **Step 2: Write failing context menu test**

In `tests/background/contextMenuActions.test.ts`, update the selection translation test to omit `getActiveProfile` and assert only the request:

```ts
it("uses the stored target language for selection translation", async () => {
  const translateSelection = vi.fn(async () => undefined);

  await handleTranslateSelectionMenuClick(
    { tabId: 42, text: "Hello" },
    {
      getStoredTargetLanguage: async () => "ko",
      translateSelection,
    },
  );

  expect(translateSelection).toHaveBeenCalledWith({
    tabId: 42,
    text: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "ko",
  });
});
```

Apply the same dependency shape to the fallback target language test.

- [ ] **Step 3: Run background tests and verify failure**

Run:

```bash
pnpm test tests/background/selectionTranslation.test.ts tests/background/contextMenuActions.test.ts
```

Expected: fail because dependencies and message shape still use the old active-provider-only path.

- [ ] **Step 4: Implement provider option and selection helpers**

In `src/background/selectionTranslation.ts`, update imports:

```ts
import type {
  ContentRequest,
  ContentResponse,
  SelectionTranslationProviderOption,
} from "@/messaging/contracts";
import {
  evaluateProviderReadiness,
} from "@/provider/readiness";
```

Update `TranslateSelectionInput`:

```ts
export type TranslateSelectionInput = {
  tabId: number;
  requestId?: string;
  providerId?: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
};
```

Update dependencies:

```ts
export type TranslateSelectionDependencies = {
  listProfiles: () => Promise<ProviderProfile[]>;
  getSelectionProviderId: () => Promise<string | undefined>;
  getActiveProfile: () => Promise<ProviderProfile | undefined>;
  getTranslationProvider: (profile: ProviderProfile) => TranslationProvider;
  detectSourceLanguage?: (text: string) => Promise<string | undefined>;
  prepareChromeBuiltInAi?: (
    sourceLanguage: string,
    targetLanguage: string,
  ) => Promise<void>;
  sendToContent: (
    tabId: number,
    message: ContentRequest,
  ) => Promise<ContentResponse | undefined>;
};
```

Add helpers:

```ts
function createSelectionRequestId(): string {
  return `selection-${Date.now()}-${crypto.randomUUID()}`;
}

function providerModelLabel(profile: ProviderProfile): string {
  return profile.type === "openai-compatible"
    ? `${profile.displayName} / ${profile.textModel}`
    : "Chrome Built-in AI";
}

export function buildSelectionProviderOptions(
  profiles: ProviderProfile[],
): SelectionTranslationProviderOption[] {
  return profiles.flatMap((profile) => {
    const readiness = evaluateProviderReadiness(profiles, profile.id);
    if (readiness.readiness !== "ready") {
      return [];
    }

    return [
      {
        id: profile.id,
        label: providerModelLabel(profile),
        providerMode:
          profile.type === "chrome-built-in-ai" ? "local-only" : "remote",
      },
    ];
  });
}

function selectSelectionProvider(
  profiles: ProviderProfile[],
  requestedProviderId: string | undefined,
  savedProviderId: string | undefined,
  activeProfile: ProviderProfile | undefined,
): ProviderProfile | undefined {
  const options = buildSelectionProviderOptions(profiles);
  const readyIds = new Set(options.map((option) => option.id));
  const preferredIds = [
    requestedProviderId,
    savedProviderId,
    activeProfile?.id,
    options[0]?.id,
  ];
  const selectedId = preferredIds.find(
    (providerId) => providerId !== undefined && readyIds.has(providerId),
  );

  return selectedId
    ? profiles.find((profile) => profile.id === selectedId)
    : undefined;
}
```

- [ ] **Step 5: Update translation flow**

In `translateSelection`, resolve profiles and request id before provider calls:

```ts
const requestId = input.requestId ?? createSelectionRequestId();
const [profiles, savedProviderId, activeProfile] = await Promise.all([
  dependencies.listProfiles(),
  dependencies.getSelectionProviderId(),
  dependencies.getActiveProfile(),
]);
const providerOptions = buildSelectionProviderOptions(profiles);
const profile = selectSelectionProvider(
  profiles,
  input.providerId,
  savedProviderId,
  activeProfile,
);
```

When no profile is available, send:

```ts
await sendSelectionTranslationError(
  {
    tabId: input.tabId,
    requestId,
    sourceText,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    providerOptions,
    providerId: input.providerId,
    errorMessage: "No active provider profile.",
  },
  dependencies,
);
```

Before provider execution, send loading:

```ts
await dependencies.sendToContent(input.tabId, {
  type: "showSelectionTranslation",
  requestId,
  state: "loading",
  sourceText,
  sourceLanguage: input.sourceLanguage,
  targetLanguage: input.targetLanguage,
  selectedProviderId: profile.id,
  providerOptions,
});
```

On success, send:

```ts
await dependencies.sendToContent(input.tabId, {
  type: "showSelectionTranslation",
  requestId,
  state: "translated",
  sourceText,
  sourceLanguage,
  targetLanguage: input.targetLanguage,
  selectedProviderId: profile.id,
  providerOptions,
  translatedText: response.translatedText,
});
```

Change `sendSelectionTranslationError` to accept structured input:

```ts
async function sendSelectionTranslationError(
  input: {
    tabId: number;
    requestId: string;
    sourceText: string;
    sourceLanguage: string;
    targetLanguage: string;
    providerOptions: SelectionTranslationProviderOption[];
    providerId?: string;
    errorMessage: string;
  },
  dependencies: Pick<TranslateSelectionDependencies, "sendToContent">,
): Promise<void> {
  await dependencies.sendToContent(input.tabId, {
    type: "showSelectionTranslation",
    requestId: input.requestId,
    state: "failed",
    sourceText: input.sourceText,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    selectedProviderId: input.providerId,
    providerOptions: input.providerOptions,
    errorMessage: input.errorMessage,
  });
}
```

- [ ] **Step 6: Update context menu action shape**

In `src/background/contextMenuActions.ts`, change `TranslateSelectionMenuClickDependencies`:

```ts
export type TranslateSelectionMenuClickDependencies = {
  getStoredTargetLanguage: () => Promise<string>;
  translateSelection: (input: TranslateSelectionMenuInput) => Promise<void>;
};
```

Update `handleTranslateSelectionMenuClick`:

```ts
export async function handleTranslateSelectionMenuClick(
  input: TranslateSelectionMenuClickInput,
  dependencies: TranslateSelectionMenuClickDependencies,
): Promise<void> {
  await dependencies.translateSelection({
    tabId: input.tabId,
    text: input.text,
    sourceLanguage: "auto",
    targetLanguage: await getStoredTargetLanguageOrDefault(
      dependencies.getStoredTargetLanguage,
    ),
  });
}
```

- [ ] **Step 7: Run tests and verify pass**

Run:

```bash
pnpm test tests/background/selectionTranslation.test.ts tests/background/contextMenuActions.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/background/selectionTranslation.ts src/background/contextMenuActions.ts tests/background/selectionTranslation.test.ts tests/background/contextMenuActions.test.ts
git commit -m "Resolve selection translation providers"
```

---

### Task 4: Background Entrypoint Message Wiring

**Files:**
- Modify: `entrypoints/background.ts`
- Test: `tests/background/selectionTranslation.test.ts`
- Test: `tests/messaging/contracts.test.ts`

- [ ] **Step 1: Add helper tests for config shape**

In `tests/background/selectionTranslation.test.ts`, import the config helper after it is introduced in this task:

```ts
import {
  buildSelectionTranslationConfig,
  translateSelection,
  type TranslateSelectionDependencies,
} from "@/background/selectionTranslation";
```

Add tests:

```ts
it("builds configured selection popup config from ready providers", async () => {
  const config = buildSelectionTranslationConfig({
    profiles: [openAiProfile, chromeBuiltInProfile],
    savedProviderId: "provider-1",
    activeProfile: chromeBuiltInProfile,
    targetLanguage: "zh-CN",
  });

  expect(config).toEqual({
    type: "selectionTranslationConfig",
    configured: true,
    targetLanguage: "zh-CN",
    selectedProviderId: "provider-1",
    providerOptions: [
      {
        id: "provider-1",
        label: "Work Provider / gpt-5-mini",
        providerMode: "remote",
      },
      {
        id: "chrome-built-in-ai",
        label: "Chrome Built-in AI",
        providerMode: "local-only",
      },
    ],
  });
});

it("builds missing provider config when no ready providers exist", async () => {
  const config = buildSelectionTranslationConfig({
    profiles: [],
    savedProviderId: undefined,
    activeProfile: undefined,
    targetLanguage: "zh-CN",
  });

  expect(config).toEqual({
    type: "selectionTranslationConfig",
    configured: false,
    targetLanguage: "zh-CN",
    providerOptions: [],
    message: "No translation provider is configured.",
  });
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
pnpm test tests/background/selectionTranslation.test.ts
```

Expected: fail because `buildSelectionTranslationConfig` is not exported.

- [ ] **Step 3: Implement config helper**

In `src/background/selectionTranslation.ts`, import `BackgroundResponse`:

```ts
import type {
  BackgroundResponse,
  ContentRequest,
  ContentResponse,
  SelectionTranslationProviderOption,
} from "@/messaging/contracts";
```

Add:

```ts
export function buildSelectionTranslationConfig(input: {
  profiles: ProviderProfile[];
  savedProviderId: string | undefined;
  activeProfile: ProviderProfile | undefined;
  targetLanguage: string;
}): Extract<BackgroundResponse, { type: "selectionTranslationConfig" }> {
  const providerOptions = buildSelectionProviderOptions(input.profiles);
  const selectedProfile = selectSelectionProvider(
    input.profiles,
    undefined,
    input.savedProviderId,
    input.activeProfile,
  );

  if (!selectedProfile) {
    return {
      type: "selectionTranslationConfig",
      configured: false,
      targetLanguage: input.targetLanguage,
      providerOptions,
      message: "No translation provider is configured.",
    };
  }

  return {
    type: "selectionTranslationConfig",
    configured: true,
    targetLanguage: input.targetLanguage,
    selectedProviderId: selectedProfile.id,
    providerOptions,
  };
}
```

- [ ] **Step 4: Wire background dependencies**

In `entrypoints/background.ts`, import `buildSelectionTranslationConfig`:

```ts
import {
  buildSelectionTranslationConfig,
  translateSelection,
} from "@/background/selectionTranslation";
```

Add helper:

```ts
async function getSelectionProviderId(): Promise<string | undefined> {
  return (await storage.selectionTranslationPreferences.get()).providerId;
}
```

Update context menu `handleTranslateSelectionMenuClick` call:

```ts
await handleTranslateSelectionMenuClick(input, {
  getStoredTargetLanguage,
  translateSelection: (request) =>
    translateSelection(request, {
      listProfiles,
      getSelectionProviderId,
      getActiveProfile,
      getTranslationProvider: (profile) =>
        translationProviderResolver.getTranslationProvider(profile),
      detectSourceLanguage: (sourceText) =>
        getChromeBuiltInAiOffscreenClient().detectLanguage(sourceText),
      prepareChromeBuiltInAi,
      sendToContent: (targetTabId, message) =>
        sendTabMessage<ContentRequest, ContentResponse>(targetTabId, message),
    }),
});
```

Update runtime `translateSelection` handler with the same dependencies.

Add handlers:

```ts
case "getSelectionTranslationConfig": {
  const [targetLanguage, profiles, savedProviderId, activeProfile] =
    await Promise.all([
      getStoredTargetLanguage(),
      listProfiles(),
      getSelectionProviderId(),
      getActiveProfile(),
    ]);

  return buildSelectionTranslationConfig({
    profiles,
    savedProviderId,
    activeProfile,
    targetLanguage,
  });
}
case "setSelectionTranslationProvider":
  await storage.selectionTranslationPreferences.save({
    providerId: request.providerId,
  });
  return { type: "backgroundActionResult", success: true };
case "translateSelectionWithProvider": {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    return {
      type: "selectionTranslationError",
      requestId: request.requestId,
      providerId: request.providerId,
      message: "Cannot translate selection without a sender tab id.",
    };
  }

  let latestMessage:
    | Extract<ContentRequest, { type: "showSelectionTranslation" }>
    | undefined;
  await translateSelection(
    {
      tabId,
      requestId: request.requestId,
      providerId: request.providerId,
      text: request.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
    },
    {
      listProfiles,
      getSelectionProviderId,
      getActiveProfile,
      getTranslationProvider: (profile) =>
        translationProviderResolver.getTranslationProvider(profile),
      detectSourceLanguage: (sourceText) =>
        getChromeBuiltInAiOffscreenClient().detectLanguage(sourceText),
      prepareChromeBuiltInAi,
      sendToContent: async (_targetTabId, message) => {
        if (message.type === "showSelectionTranslation") {
          latestMessage = message;
        }
        return { type: "contentActionResult", success: true };
      },
    },
  );

  if (latestMessage?.state === "translated") {
    return {
      type: "selectionTranslationResult",
      requestId: latestMessage.requestId,
      providerId: latestMessage.selectedProviderId ?? request.providerId,
      translatedText: latestMessage.translatedText,
    };
  }

  return {
    type: "selectionTranslationError",
    requestId: request.requestId,
    providerId: latestMessage?.selectedProviderId ?? request.providerId,
    message:
      latestMessage?.state === "failed"
        ? latestMessage.errorMessage
        : "Selection translation failed.",
  };
}
```

- [ ] **Step 5: Run focused checks**

Run:

```bash
pnpm typecheck
pnpm test tests/background/selectionTranslation.test.ts tests/messaging/contracts.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/background.ts src/background/selectionTranslation.ts tests/background/selectionTranslation.test.ts
git commit -m "Wire selection translation background messages"
```

---

### Task 5: Selection Popup Runtime UI

**Files:**
- Modify: `src/content/selectionPanel.ts`
- Modify: `entrypoints/content.ts`
- Test: `tests/content/selectionPanel.test.ts`

- [ ] **Step 1: Replace content tests with popup behavior tests**

In `tests/content/selectionPanel.test.ts`, update the success render test:

```ts
it("renders only translated selection text in an anchored popup", () => {
  showSelectionTranslation({
    requestId: "selection-request-1",
    state: "translated",
    sourceText: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    selectedProviderId: "provider-1",
    providerOptions: [
      {
        id: "provider-1",
        label: "DeepSeek / deepseek-v4-flash",
        providerMode: "remote",
      },
    ],
    translatedText: "你好",
  });

  const panel = document.getElementById("yoyo-selection-translation-panel");

  expect(panel).not.toBeNull();
  expect(panel?.textContent).toContain("你好");
  expect(panel?.textContent).not.toContain("Hello");
  expect(panel?.getAttribute("data-yoyo-extension")).toBe(
    "selection-translation-panel",
  );
  expect(panel?.classList.contains("notranslate")).toBe(true);
  expect(panel?.getAttribute("translate")).toBe("no");
});
```

Add tests:

```ts
it("renders provider dropdown and icon-only actions", () => {
  showSelectionTranslation({
    requestId: "selection-request-1",
    state: "translated",
    sourceText: "Hello",
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    selectedProviderId: "provider-1",
    providerOptions: [
      {
        id: "provider-1",
        label: "DeepSeek / deepseek-v4-flash",
        providerMode: "remote",
      },
    ],
    translatedText: "你好",
  });

  const panel = document.getElementById("yoyo-selection-translation-panel");
  const select = panel?.querySelector("select");
  const copyButton = panel?.querySelector<HTMLButtonElement>(
    'button[data-yoyo-selection-action="copy"]',
  );
  const closeButton = panel?.querySelector<HTMLButtonElement>(
    'button[data-yoyo-selection-action="close"]',
  );

  expect(panel?.querySelector("[data-yoyo-selection-brand]")?.textContent).toBe("Y");
  expect(select?.value).toBe("provider-1");
  expect(copyButton?.getAttribute("aria-label")).toBe("Copy translation");
  expect(copyButton?.textContent).not.toContain("Copy");
  expect(closeButton?.getAttribute("aria-label")).toBe("Close translation popup");
});

it("retranslates when the provider dropdown changes", () => {
  const sendBackgroundMessage = vi.fn(async () => ({
    type: "selectionTranslationResult",
    requestId: "selection-request-2",
    providerId: "provider-2",
    translatedText: "早上好",
  }));

  showSelectionTranslation(
    {
      requestId: "selection-request-1",
      state: "translated",
      sourceText: "Good morning",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: [
        {
          id: "provider-1",
          label: "DeepSeek / deepseek-v4-flash",
          providerMode: "remote",
        },
        {
          id: "provider-2",
          label: "OpenAI / gpt-5-mini",
          providerMode: "remote",
        },
      ],
      translatedText: "早",
    },
    { sendBackgroundMessage },
  );

  const select = document.querySelector<HTMLSelectElement>(
    "#yoyo-selection-translation-panel select",
  );
  expect(select).not.toBeNull();

  select!.value = "provider-2";
  select!.dispatchEvent(new Event("change", { bubbles: true }));

  expect(sendBackgroundMessage).toHaveBeenCalledWith({
    type: "setSelectionTranslationProvider",
    providerId: "provider-2",
  });
  expect(sendBackgroundMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "translateSelectionWithProvider",
      text: "Good morning",
      providerId: "provider-2",
    }),
  );
});

it("ignores stale provider switch results", async () => {
  const sendBackgroundMessage = vi
    .fn()
    .mockResolvedValueOnce({ type: "backgroundActionResult", success: true })
    .mockResolvedValueOnce({
      type: "selectionTranslationResult",
      requestId: "stale-request",
      providerId: "provider-2",
      translatedText: "旧结果",
    });

  showSelectionTranslation(
    {
      requestId: "selection-request-1",
      state: "translated",
      sourceText: "Good morning",
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      selectedProviderId: "provider-1",
      providerOptions: [
        {
          id: "provider-1",
          label: "DeepSeek / deepseek-v4-flash",
          providerMode: "remote",
        },
        {
          id: "provider-2",
          label: "OpenAI / gpt-5-mini",
          providerMode: "remote",
        },
      ],
      translatedText: "早",
    },
    { sendBackgroundMessage, createRequestId: () => "selection-request-2" },
  );

  const select = document.querySelector<HTMLSelectElement>(
    "#yoyo-selection-translation-panel select",
  );
  select!.value = "provider-2";
  select!.dispatchEvent(new Event("change", { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();

  expect(document.body.textContent).not.toContain("旧结果");
});
```

- [ ] **Step 2: Run content tests and verify failure**

Run:

```bash
pnpm test tests/content/selectionPanel.test.ts
```

Expected: fail because `selectionPanel.ts` still renders source text, has no dropdown, and has no dependency injection.

- [ ] **Step 3: Implement popup runtime types and defaults**

In `src/content/selectionPanel.ts`, replace the input type with the content request variant:

```ts
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentRequest,
} from "@/messaging/contracts";
import { sendRuntimeMessage } from "@/messaging/runtime";
import { elapsedMs, nowMs, tracePerf } from "@/utils/perfTrace";

export type SelectionTranslationPanelInput = Extract<
  ContentRequest,
  { type: "showSelectionTranslation" }
>;

export type SelectionPanelDependencies = {
  sendBackgroundMessage?: (
    message: BackgroundRequest,
  ) => Promise<BackgroundResponse>;
  clipboard?: Pick<Clipboard, "writeText">;
  createRequestId?: () => string;
};
```

Add module state:

```ts
const panelId = "yoyo-selection-translation-panel";
let currentInput: SelectionTranslationPanelInput | undefined;
let currentRequestId: string | undefined;
let currentDependencies: Required<SelectionPanelDependencies> | undefined;

function defaultCreateRequestId(): string {
  return `selection-${Date.now()}-${crypto.randomUUID()}`;
}

function resolveDependencies(
  dependencies: SelectionPanelDependencies = {},
): Required<SelectionPanelDependencies> {
  return {
    sendBackgroundMessage:
      dependencies.sendBackgroundMessage ??
      ((message) => sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message)),
    clipboard: dependencies.clipboard ?? navigator.clipboard,
    createRequestId: dependencies.createRequestId ?? defaultCreateRequestId,
  };
}
```

- [ ] **Step 4: Implement DOM rendering**

Add helpers:

```ts
function createIconButton(input: {
  action: "copy" | "close";
  label: string;
  text: string;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.yoyoSelectionAction = input.action;
  button.setAttribute("aria-label", input.label);
  button.textContent = input.text;
  button.style.width = "34px";
  button.style.height = "34px";
  button.style.border = "0";
  button.style.borderRadius = "7px";
  button.style.background = input.action === "copy" ? "#f3f4f6" : "transparent";
  button.style.color = "#4b5563";
  button.style.cursor = "pointer";
  button.style.display = "grid";
  button.style.placeItems = "center";
  button.style.font = "18px/1 ui-sans-serif, system-ui, sans-serif";
  return button;
}

function createProviderSelect(input: SelectionTranslationPanelInput): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Selection translation provider");
  select.style.flex = "1";
  select.style.minWidth = "0";
  select.style.height = "38px";
  select.style.border = "1px solid #dbe7db";
  select.style.borderRadius = "8px";
  select.style.background = "#f3f7f3";
  select.style.color = "#1f2937";
  select.style.font = "700 14px/1.2 ui-sans-serif, system-ui, sans-serif";
  select.style.padding = "0 10px";

  for (const option of input.providerOptions) {
    const element = document.createElement("option");
    element.value = option.id;
    element.textContent = option.label;
    select.append(element);
  }

  if (input.selectedProviderId) {
    select.value = input.selectedProviderId;
  }

  return select;
}

function createBody(input: SelectionTranslationPanelInput): HTMLElement {
  const body = document.createElement("div");
  body.style.font = "700 24px/1.42 ui-sans-serif, system-ui, sans-serif";
  body.style.color = "#1f2937";
  body.style.whiteSpace = "pre-wrap";
  body.style.overflowWrap = "anywhere";
  body.style.maxHeight = "min(320px, calc(100vh - 180px))";
  body.style.overflow = "auto";

  if (input.state === "loading") {
    body.textContent = "Translating...";
  } else if (input.state === "translated") {
    body.textContent = input.translatedText;
  } else {
    body.textContent = input.errorMessage;
  }

  return body;
}
```

Render in `showSelectionTranslation`:

```ts
export function showSelectionTranslation(
  input: SelectionTranslationPanelInput,
  dependencies?: SelectionPanelDependencies,
): void {
  const startedAt = nowMs();
  currentInput = input;
  currentRequestId = input.requestId;
  currentDependencies = resolveDependencies(dependencies);

  removeExistingPanel();

  const panel = document.createElement("aside");
  panel.id = panelId;
  panel.className = "notranslate";
  panel.setAttribute("translate", "no");
  panel.setAttribute("role", input.state === "failed" ? "alert" : "status");
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute("data-yoyo-extension", "selection-translation-panel");
  applyPanelStyle(panel);

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "10px";
  header.style.marginBottom = "16px";

  const brand = document.createElement("div");
  brand.dataset.yoyoSelectionBrand = "true";
  brand.textContent = "Y";
  brand.style.width = "34px";
  brand.style.height = "34px";
  brand.style.borderRadius = "8px";
  brand.style.background = "#16a34a";
  brand.style.color = "#ffffff";
  brand.style.display = "grid";
  brand.style.placeItems = "center";
  brand.style.font = "900 18px/1 ui-sans-serif, system-ui, sans-serif";

  const select = createProviderSelect(input);
  select.addEventListener("change", () => {
    void handleProviderChange(select.value);
  });

  const copyButton = createIconButton({
    action: "copy",
    label: "Copy translation",
    text: "⧉",
  });
  copyButton.addEventListener("click", () => {
    void handleCopy(copyButton);
  });

  const closeButton = createIconButton({
    action: "close",
    label: "Close translation popup",
    text: "×",
  });
  closeButton.addEventListener("click", removeExistingPanel);

  header.append(brand, select, copyButton, closeButton);
  panel.append(header, createBody(input));
  document.body.append(panel);
  positionPanel(panel);

  tracePerf("content.selectionPanel.done", {
    stage: "selection",
    sourceCharCount: input.sourceText.length,
    outputCharCount: input.state === "translated" ? input.translatedText.length : 0,
    durationMs: elapsedMs(startedAt),
    success: input.state === "translated",
  });
}
```

- [ ] **Step 5: Implement styling, positioning, provider change, and copy**

Add:

```ts
function applyPanelStyle(panel: HTMLElement): void {
  panel.style.position = "fixed";
  panel.style.zIndex = "2147483647";
  panel.style.boxSizing = "border-box";
  panel.style.width = "min(560px, calc(100vw - 32px))";
  panel.style.padding = "14px";
  panel.style.border = "1px solid #dfe7df";
  panel.style.borderRadius = "8px";
  panel.style.background = "#ffffff";
  panel.style.color = "#1f2937";
  panel.style.boxShadow = "0 18px 44px rgba(15, 23, 42, 0.20)";
  panel.style.font = "14px/1.5 ui-sans-serif, system-ui, sans-serif";
}

function getSelectionRect(): DOMRect | undefined {
  const range = window.getSelection()?.rangeCount
    ? window.getSelection()?.getRangeAt(0)
    : undefined;
  const rect = range?.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    return undefined;
  }
  return rect;
}

function positionPanel(panel: HTMLElement): void {
  const margin = 16;
  const selectionRect = getSelectionRect();
  const panelRect = panel.getBoundingClientRect();
  const fallbackLeft = window.innerWidth - panelRect.width - 24;
  const fallbackTop = window.innerHeight - panelRect.height - 24;
  const anchorLeft = selectionRect
    ? selectionRect.left + selectionRect.width / 2 - panelRect.width / 2
    : fallbackLeft;
  const preferredTop = selectionRect
    ? selectionRect.top - panelRect.height - 12
    : fallbackTop;
  const flippedTop = selectionRect ? selectionRect.bottom + 12 : fallbackTop;
  const top =
    preferredTop >= margin
      ? preferredTop
      : Math.min(flippedTop, window.innerHeight - panelRect.height - margin);
  const left = Math.min(
    Math.max(anchorLeft, margin),
    window.innerWidth - panelRect.width - margin,
  );

  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, top)}px`;
}

async function handleProviderChange(providerId: string): Promise<void> {
  if (!currentInput || !currentDependencies) {
    return;
  }

  const requestId = currentDependencies.createRequestId();
  currentRequestId = requestId;
  await currentDependencies.sendBackgroundMessage({
    type: "setSelectionTranslationProvider",
    providerId,
  });

  showSelectionTranslation(
    {
      type: "showSelectionTranslation",
      requestId,
      state: "loading",
      sourceText: currentInput.sourceText,
      sourceLanguage: currentInput.sourceLanguage,
      targetLanguage: currentInput.targetLanguage,
      selectedProviderId: providerId,
      providerOptions: currentInput.providerOptions,
    },
    currentDependencies,
  );

  const response = await currentDependencies.sendBackgroundMessage({
    type: "translateSelectionWithProvider",
    requestId,
    text: currentInput.sourceText,
    sourceLanguage: currentInput.sourceLanguage,
    targetLanguage: currentInput.targetLanguage,
    providerId,
  });

  if (requestId !== currentRequestId) {
    return;
  }

  if (response.type === "selectionTranslationResult") {
    showSelectionTranslation(
      {
        type: "showSelectionTranslation",
        requestId,
        state: "translated",
        sourceText: currentInput.sourceText,
        sourceLanguage: currentInput.sourceLanguage,
        targetLanguage: currentInput.targetLanguage,
        selectedProviderId: response.providerId,
        providerOptions: currentInput.providerOptions,
        translatedText: response.translatedText,
      },
      currentDependencies,
    );
  } else if (response.type === "selectionTranslationError") {
    showSelectionTranslation(
      {
        type: "showSelectionTranslation",
        requestId,
        state: "failed",
        sourceText: currentInput.sourceText,
        sourceLanguage: currentInput.sourceLanguage,
        targetLanguage: currentInput.targetLanguage,
        selectedProviderId: response.providerId,
        providerOptions: currentInput.providerOptions,
        errorMessage: response.message,
      },
      currentDependencies,
    );
  }
}

async function handleCopy(button: HTMLButtonElement): Promise<void> {
  if (!currentInput || currentInput.state !== "translated" || !currentDependencies) {
    return;
  }

  const originalLabel = button.getAttribute("aria-label") ?? "Copy translation";
  try {
    await currentDependencies.clipboard.writeText(currentInput.translatedText);
    button.dataset.yoyoCopyState = "copied";
    button.setAttribute("aria-label", "Copied");
  } catch {
    button.dataset.yoyoCopyState = "failed";
    button.setAttribute("aria-label", "Copy failed");
  }

  window.setTimeout(() => {
    button.dataset.yoyoCopyState = "";
    button.setAttribute("aria-label", originalLabel);
  }, 1200);
}
```

- [ ] **Step 6: Wire content entrypoint**

In `entrypoints/content.ts`, update:

```ts
showSelectionTranslation(request, {
  sendBackgroundMessage: (message) =>
    sendRuntimeMessage<BackgroundRequest, BackgroundResponse>(message),
});
```

- [ ] **Step 7: Run content tests and verify pass**

Run:

```bash
pnpm test tests/content/selectionPanel.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/content/selectionPanel.ts entrypoints/content.ts tests/content/selectionPanel.test.ts
git commit -m "Render selection translation popup"
```

---

### Task 6: Integration, Typecheck, and Manual QA

**Files:**
- Inspect: `entrypoints/background.ts`
- Inspect: `entrypoints/content.ts`
- Inspect: `src/messaging/contracts.ts`
- Inspect: `src/background/selectionTranslation.ts`
- Inspect: `src/content/selectionPanel.ts`
- Inspect: `tests`

- [ ] **Step 1: Run full static checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass. If `vue-tsc` reports contract exhaustiveness errors, update the affected switch statements to handle the new request/response variants explicitly.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
pnpm test
```

Expected: pass.

- [ ] **Step 3: Run extension verification**

Run:

```bash
pnpm verify:extension
```

Expected: pass.

- [ ] **Step 4: Manual QA**

Use a local extension build and verify:

```bash
pnpm build
```

Manual checks:

- Configure at least two ready providers.
- Select text on a normal web page and trigger selection translation.
- Confirm the popup appears near the selected text and not in the bottom-right corner.
- Confirm the popup body displays only translated text.
- Confirm the provider dropdown lists configured ready providers.
- Change provider and confirm the same selected text retranslates immediately.
- Confirm the selected provider is remembered for the next selection translation.
- Confirm page translation, summary, and YouTube subtitle provider behavior still use their existing provider selection.
- Click copy and confirm translated text is copied.
- Click close and confirm the popup is removed.
- Select text near viewport edges and confirm the popup remains within the viewport.

- [ ] **Step 5: Commit integration fixes when verification changed files**

Run:

```bash
git status --short
```

When the output lists files changed during verification fixes, commit those exact files:

```bash
git add entrypoints/background.ts entrypoints/content.ts src tests
git commit -m "Verify selection translation popup integration"
```

When the output is empty, stop this task without creating a commit.
