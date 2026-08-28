# Browser product E2E (Phase F)

`e2e/product-v3.spec.mjs` drives the **real** `static/index.html` page served by
the real integration stack (Node frontend at `:8787` proxying the Python FastAPI
backend at `:8123`). The product APIs — Recommendation / Semantic / Scene
Composer / Offline-Prior / Snapshot / Settings / Catalog — all run **for real**
against the local SQLite data.

The only upstream that is mocked is the NovelAI surface:

- `POST /api/novelai/generate` → canned success (no token, no Anlas consumed).
- `GET /api/novelai/status` → simulated "connected" gate. The real probe would
  need a live NovelAI network + valid token; without it the probe reports
  `unreachable` and the Generate button stays disabled. We simulate a healthy
  connection purely so the paid-generation path can be reached and then mocked.

No Recommendation / Semantic / Scene / Offline-Prior API is ever stubbed.

## Requirements

- Node.js `>=22.5.0` (matches `package.json` `engines`).
- `@playwright/test` + Chromium (see install below).
- A Python virtualenv (`.venv`) with the project dependencies installed.

## Install

```sh
npm install
npx playwright install chromium
```

## Run

```sh
npm run test:e2e
```

`playwright.config.mjs` boots the real stack for you: it starts the Python
backend (`:8123`, with `TAGS_MARKET_AUTOSTART_NAI=0` so it does not double-start
the Node layer) and then the Node frontend (`:8787`). If those ports are already
serving the app, Playwright reuses them (`reuseExistingServer: true`).

## Scenario map (real integration)

| Test | Scenario | What it verifies |
| --- | --- | --- |
| 9.5  | Full path | Base(bedroom,night) → C1(Citlali) → C2(Furina) → Text → Recommendation → Visual → Scene → Snapshot → Restore → Generate(mock) |
| 9.6  | Semantic separation | C2 Hair/Eyes/Clothing filled; Eyes semantic alternatives surface in `alternatives` but never pollute the additive recommendations or `next_steps` |
| 9.7  | Context A/B | Stage/Position/BodyFocus/Participant changes are wired end-to-end into the recommendation API request payload |
| 9.8  | Offline prior | `/api/offline-prior/status` → `available=true`; semantic features run without `SILICONFLOW_API_KEY` |
| 9.9  | Scene participants | 1→2→3→2 keeps character tabs / `assistant_context` / scene summary in sync |
| 9.10 | Interaction | C1→kissing→C2 serializes `source#`/`target#`; Snapshot→Restore preserves them |
| 9.11 | Syntax fidelity | `1.35::`, `1.5::…::`, `-1::`, `{{}}`, `[[]]`, `source#`/`target#`/`mutual#` survive Text→Visual→Scene→Snapshot→Restore→Generate |

## Mocking contract

The only routes intercepted by `page.route` are `**/api/novelai/generate` and
`**/api/novelai/status`. Everything else hits the real backend. `stats`
returned by `installNovelAIMocks()` exposes `generateCalls` / `statusCalls` and
the `generatePayloads` array so tests can assert the generate request payload.

`captureRecommendations(page)` / `captureSemanticState(page)` are observation
helpers — they record the real API responses (never mock them) so tests can
assert on the actual semantic-state and recommendation payloads.
