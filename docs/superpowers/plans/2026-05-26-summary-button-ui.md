# Summary Button UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the popup action area so translate and summary appear as paired primary actions, with summary using a polished lighter treatment.

**Architecture:** Keep the change local to `entrypoints/popup/App.vue` and existing popup tests. Add an `action-grid` wrapper around the two buttons, keep existing click handlers and disabled computations, and style `.summary-action` as a dedicated paired action instead of relying on the generic `.secondary-action` visual.

**Tech Stack:** Vue 3 single-file component, TypeScript, scoped CSS, Vitest, Testing Library Vue, WXT popup.

---

## File Structure

- Modify `tests/ui/popup.test.ts`
  - Import `within`.
  - Update expectations for the shortened translate label.
  - Add an accessible group assertion for the paired popup actions.
- Modify `entrypoints/popup/App.vue`
  - Shorten the default primary label to the new paired-action copy.
  - Wrap translate and summary buttons in `action-grid`.
  - Add `role="group"` and an English accessible label for testable action grouping.
  - Move summary button off the generic `secondary-action` visual class.
  - Add scoped styles for `action-grid`, paired button sizing, and summary-specific hover/focus/disabled states.

No new component is needed because the state and handlers already live in `App.vue`, and extracting a component would only add prop plumbing for this small local layout.

---

### Task 1: Add Failing Popup Layout Test

**Files:**
- Modify: `tests/ui/popup.test.ts`

- [ ] **Step 1: Write the failing test update**

Update the import at the top of `tests/ui/popup.test.ts`:

```ts
import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
```

In the test named `renders the default popup controls without configured provider details`, replace the two existing button assertions with this block:

```ts
const pageActionsLabel = "Page actions";
const defaultPrimaryLabel = "\u7ffb\u8bd1\u9875\u9762";
const summaryLabel = "\u4e00\u952e\u603b\u7ed3";
const pageActions = screen.getByRole("group", { name: pageActionsLabel });

expect(within(pageActions).getByRole("button", { name: defaultPrimaryLabel })).toBeVisible();
expect(within(pageActions).getByRole("button", { name: summaryLabel })).toBeVisible();
```

In the test named `continues initialization when preference storage fails`, replace:

```ts
expect(await screen.findByRole("button", { name: "\u7ffb\u8bd1\u5f53\u524d\u9875\u9762" })).toBeVisible();
```

with:

```ts
expect(await screen.findByRole("button", { name: "\u7ffb\u8bd1\u9875\u9762" })).toBeVisible();
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm vitest run tests/ui/popup.test.ts
```

Expected result: FAIL because the popup does not yet expose a `Page actions` group and the translate button still uses the old default label.

- [ ] **Step 3: Commit is not allowed yet**

Do not commit after the red step. Continue to Task 2 and make the minimal production change.

---

### Task 2: Implement Paired Popup Actions

**Files:**
- Modify: `entrypoints/popup/App.vue`

- [ ] **Step 1: Shorten the default primary label**

In `primaryLabel`, replace the idle fallback return value:

```ts
return "\u7ffb\u8bd1\u9875\u9762";
```

Do not change the onboarding, translating, completed, or existing translations labels in this task.

- [ ] **Step 2: Wrap the two main action buttons**

Replace the current adjacent primary and summary button template block with:

```vue
<div
  class="action-grid"
  role="group"
  aria-label="Page actions"
>
  <button
    class="primary-action"
    type="button"
    :disabled="isPrimaryDisabled"
    @click="onPrimaryAction"
  >
    {{ primaryLabel }}
  </button>

  <button
    class="summary-action"
    type="button"
    :disabled="isSummaryDisabled"
    @click="onSummaryAction"
  >
    {{ isSummarizing ? t("button.summarizingPage") : t("button.summarizePage") }}
  </button>
</div>
```

This intentionally removes `secondary-action` from the summary button so the generic secondary style remains scoped to existing translation management actions.

- [ ] **Step 3: Add the paired action CSS**

In the `<style scoped>` block, add this rule before `.primary-action`:

```css
.action-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
```

Update `.primary-action` to keep paired sizing stable:

```css
.primary-action {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  color: #ffffff;
  background: linear-gradient(
    180deg,
    var(--yoyo-brand-700) 0%,
    var(--yoyo-brand-800) 100%
  );
  box-shadow: 0 10px 20px rgb(7 95 50 / 22%);
  font-size: 14px;
  font-weight: 750;
  line-height: 1.2;
  cursor: pointer;
}
```

Add the summary-specific styles after `.primary-action:focus-visible`:

```css
.summary-action {
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid #b9d8aa;
  border-radius: 12px;
  color: var(--yoyo-brand-800);
  background: linear-gradient(
    180deg,
    var(--yoyo-surface-muted) 0%,
    var(--yoyo-brand-100) 100%
  );
  box-shadow: 0 8px 18px rgb(7 95 50 / 10%);
  font-size: 14px;
  font-weight: 730;
  line-height: 1.2;
  cursor: pointer;
}

.summary-action:hover {
  border-color: var(--yoyo-border-strong);
  background: linear-gradient(
    180deg,
    var(--yoyo-brand-100) 0%,
    var(--yoyo-surface-muted) 100%
  );
}

.summary-action:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.summary-action:focus-visible {
  outline: 3px solid var(--yoyo-focus-ring);
  outline-offset: 3px;
}
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run:

```bash
pnpm vitest run tests/ui/popup.test.ts
```

Expected result: PASS for `tests/ui/popup.test.ts`.

- [ ] **Step 5: Commit the paired action implementation**

Run:

```bash
git add entrypoints/popup/App.vue tests/ui/popup.test.ts
git commit -m "Update popup summary action styling"
```

Expected result: commit succeeds with only the popup component and popup test changes.

---

### Task 3: Full Verification and Visual Check

**Files:**
- Verify: `entrypoints/popup/App.vue`
- Verify: `tests/ui/popup.test.ts`

- [ ] **Step 1: Run the standard verification commands**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected result: all commands pass.

- [ ] **Step 2: Build the extension popup for manual inspection**

Run:

```bash
pnpm build
```

Expected result: WXT builds successfully and updates `build/chrome-mv3`.

- [ ] **Step 3: Inspect the popup visually**

Open the built extension popup or the WXT dev popup and verify:

- Translate and summary buttons are in one row.
- Both buttons are the same height.
- The translate button remains visually stronger than the summary button.
- The summary button no longer appears as a plain white outline.
- English summary text does not overflow.
- Existing translation management buttons still use the generic secondary style.

- [ ] **Step 4: Commit verification-only follow-up only if needed**

If visual inspection reveals small CSS polish issues, apply the minimal CSS correction and run:

```bash
pnpm vitest run tests/ui/popup.test.ts
pnpm lint
```

Then commit:

```bash
git add entrypoints/popup/App.vue tests/ui/popup.test.ts
git commit -m "Polish popup paired action layout"
```

If no follow-up changes are needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Paired translate and summary actions are implemented in Task 2.
- Shortened translate copy is implemented in Task 2 and tested in Task 1.
- Summary keeps existing click behavior through unchanged `onSummaryAction` and is covered by existing popup tests.
- Generic existing translation actions remain on `.secondary-action` because Task 2 removes that class only from the summary button.
- Hover, focus, disabled, and visual verification are covered in Task 2 CSS and Task 3 manual checks.

Placeholder scan:

- No placeholder steps are present.
- Every code-changing step includes exact code.
- Every verification step includes exact commands and expected outcomes.

Type and naming consistency:

- The accessible group name is consistently `Page actions`.
- The new container class is consistently `action-grid`.
- The summary-specific class remains `summary-action`.
