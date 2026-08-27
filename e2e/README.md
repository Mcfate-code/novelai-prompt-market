# Browser product E2E (Phase F)

`e2e/product-v3.spec.mjs` drives the **real** `static/index.html` page served by
the integration stack and uses Playwright route interception for **every**
`/api/**` call. The NovelAI generate path (`/api/novelai/generate`) is always
mocked — no token, no Anlas, no paid generation is ever consumed.

## Requirements

- Node.js `>=22.5.0` (matches `package.json` `engines`).
- Playwright (`@playwright/test`) + a Chromium browser.
- A running integration server (Python backend serving `static/index.html` +
  Node layer at `:8787`), or `E2E_BASE_URL` pointed at an already-running one.
  The mocks intercept API calls, but the page itself must load from the real app
  so the workbench DOM and PromptBridge are genuine.

## Run

```sh
npm install
npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:8787 npx playwright test e2e/product-v3.spec.mjs
```

One-off without a project-local install:

```sh
npx --yes playwright@latest install chromium
E2E_BASE_URL=http://127.0.0.1:8787 npx --yes playwright@latest test e2e/product-v3.spec.mjs
```

## Scenario map

| Test | Scenario | What it verifies |
| --- | --- | --- |
| F3  | Cold start | Text/Visual/Scene show useful empty states; recommendation panel is hidden (no empty "No recommendations") |
| F4  | Double-character full path | Base + C1 (Citlali) + C2 (Furina) targets keep identity/hair/eyes/clothing isolated |
| F5  | Recommendation next steps | C2 → next steps prioritize Expression/Pose/Action |
| F6  | Visual navigation | C2 → Appearance → Eyes: breadcrumb, Eyes selected, current-node + next-step recs |
| F7  | Visual error | semantic 500 → visible error + Retry, never blank |
| F8  | Target switch | Base→C1→C2 syncs editor, no stale Base content on C2 |
| F9  | Scene participants | 1→2→3→2 keeps character tabs / participant_count consistent |
| F10 | Interaction | C1→action→C2 writes relation metadata, serializes `source#`/`target#` |
| F11 | Context A/B | Stage/Position/BodyFocus changes trigger a fresh recommendation request |
| F12 | Learning | failed generate → no learn; successful generate → exactly one generate call |
| F13 | Offline | recommendation path survives network disconnect (offline prompt prior) |
| F14 | Snapshot | full-state save → mutate → restore → 100% restore |
| F15 | Syntax fidelity | `1.35::`, `1.5::…::`, `-1::`, `{{}}`, `[[]]`, `source#/target#/mutual#` survive Text→Visual→Scene→Snapshot→Restore→Generate |

F1/F2 are non-browser product requirements (schema v2 contract + mutation
authority), verified at the unit level in `tests/test_prompt_document.mjs` and
the Python suite.

## Mocking contract

All mocks live in `installApiMocks()`. The two failure injectors are:

- `semanticFailure` — makes `/api/catalog/semantic` + `/api/semantic-state` return
  500 (drives F7).
- `generateFailure` — makes `/api/novelai/generate` return `INSUFFICIENT_CREDITS`
  (drives F12's failed branch).

`stats` returned by `installApiMocks` exposes `generateCalls`,
`recommendationCalls`, `snapshotPosts`, `learnCalls`, `favoritePosts` so tests can
assert call counts instead of guessing.

> Note: this machine currently has no `node`, `npm`, `npx`, or Playwright binary
> (`which` confirms). Execution is therefore reported **BLOCKED**, not silently
> replaced by a static test. Selectors are pinned to the real DOM (verified
> 2026-08-27) so the suite runs as-is once a Node/Playwright environment is
> available.
