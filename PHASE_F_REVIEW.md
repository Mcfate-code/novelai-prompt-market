# Phase F independent review — integration/product-v3

## Scope and method

Independent walk-through of the product path on `integration/product-v3`
(HEAD `9133cca` Phases A–E, plus the Phase F harness commit). The review did
**not** treat development-phase conclusions as evidence: it re-derived the
authority boundary, the codec, the recommendation/visual/scene flows, the
snapshot/learning semantics and the runtime contract directly from source and
from the Python regression suite. No paid NovelAI request was made anywhere.

Path walked (API/logic level):

```
cold start → Base + C1/C2 → scoped recommendations → Visual navigation
→ Scene participants/interactions → snapshot save/restore → mocked generate
```

Runtime note: this machine has **no** `node`, `npm`, `npx`, `bun`, `deno`, or
Playwright binary (`which` confirms). The Python suite is green; the browser E2E
harness is written and committed but its execution is **BLOCKED** by the missing
runtime, not by the product.

---

## 1. Authority boundary (F1/F2)

`static/prompt-document.js` is the single source of truth for the PromptDocument
schema v2 contract.

- `normalize(raw)` at `prompt-document.js:47` upgrades any legacy shape to
  `schema_version: 2`, normalising `sections`, `characters[].prompt_sections`,
  `uc_sections`, `free_text`, `free_text_en`, `use_free_text_en`, and
  `assistant_context`.
- `getTargetEntries(document, target)` at `:70` resolves `"base"` vs
  `"char:<n>"` vs `"char:<n>:uc"`; `serializeTarget` at `:118` maps every entry
  through `weightText` (which is `serializePromptToken`), so relation metadata
  is never flattened away.
- Mutation authority flows through `PromptBridge`; scene/visual components do
  not own the document — they dispatch proposals (`sync_participants`,
  `remove_characters_blocked`) at `nsfw-builder.js:457-469` and the integrator
  applies them via `syncSceneParticipants` (`prompt-document.js:215`) and
  `applyInteraction` (`:233`).

**Finding (CONFIRMED):** the authority boundary is correct. Text/Visual/Scene
converge on `PromptDocument`, not on a parallel state.

## 2. Relation codec (F10/F15)

`static/prompt-tokenizer.js` is the one codec (mirrors `prompt/import_parser.py`
and `prompt/novelai_export.py`):

- `parsePromptToken` (`prompt-tokenizer.js:35-55`) recognises `source#/target#/
  mutual#` (regex `^(source|target|mutual)#\s*`, case-insensitive), weight wrap
  `(-?\d+(?:\.\d+)?)::…::`, and `{}`/`[]` bracket emphasis.
- `serializePromptToken` (`:70-95`) emits relation **leftmost**, then weight
  wrap (brackets dropped when weighted), else `{}`/`[]` emphasis clamped to 8,
  else plain tag — so `parsePromptToken(serializePromptToken(x))` is lossless.
- `applyInteraction` (`prompt-document.js:233`) writes `relation: "source"` to
  the actor's action section and `relation: "target"` to the target's (or
  `"mutual"` to both), with `interaction_id` / `provenance: "scene-composer-v2"`
  for later removal.

**Finding (CONFIRMED):** relation metadata survives Text serialization, snapshot,
and restore. `source#/target#/mutual#` is round-trippable.

## 3. Recommendation V3 + Semantic State (F5/F6/F11)

- `RecommendationService.recommend_v3` (`prompt/recommendation.py:139`) and
  `_v3_collect` (`:231`) assemble three guidance layers. The offline prior is an
  **optional adapter** (`:234-236`, `use_prior=had_explicit_state`) and is never
  required for V3 — so an empty/absent `offline_prompt_prior.sqlite` cannot
  produce a blank recommendation panel.
- Slot completion feeds the "next step" ordering. `tests/test_phase_c_recommendation_v3.py:42`
  (`test_complete_identity_prioritizes_expression_pose_action`) and
  `:85/:94/:100` (stage/position/body-focus change the relevant subset) pin the
  F5/F11 behaviour at the unit level.
- The empty-state contract is `test_empty_state_without_prior_is_not_no_recommendations`
  (`test_phase_c_recommendation_v3.py:21`); in the UI, `loadRecommendations`
  (`static/app.js:2050`) hides `#recommendations` when there are no tags rather
  than rendering an empty "No recommendations" string — F3 is satisfied by
  construction.

## 4. Visual navigation (F6/F7)

`static/visual-builder.js` loads the semantic tree (`/api/catalog/semantic`) and
state (`/api/semantic-state`, `:141`) and renders a breadcrumb
(`.composer-breadcrumb`) plus a completion header and inspector with
"当前节点推荐" and "下一步建议" sections (`:207`, `:218`). On semantic failure it
renders `role="alert"` `.composer-error` with a `data-action="retry-semantic"`
button (`:196`) — never a blank panel.

## 5. Scene Composer V2 (F9/F10)

`nsfw-builder.js` renders the participant count as an exclusive radio group
(`participantsHtml` at `:815`, `radioGroupHtml` at `:908`) and the interaction
builder (`interactionsHtml` at `:823`) with `[data-input="actor"]` /
`[data-input="target"]` / `[data-input="relation"]` and per-action
`data-action="interaction-add"` buttons. `selectParticipants` dispatches a
`sync_participants` proposal (`:457-469`) so character tabs and
`assistant_context.participant_count` stay consistent (`syncSceneParticipants`,
`prompt-document.js:215`).

## 6. Snapshot + scoped learning (F12/F14)

- `snapshot_create` (`app.py:3319`) **does not learn** — the comment at
  `:3321` and `tests/test_phase_a_scoped_learning.py:140`
  (`test_manual_snapshot_does_not_learn`) pin this.
- Learning happens only on successful generate writeback via
  `_record_scoped_cooccurrence` (`app.py:2734`), which scopes pairs as
  `base` / `character` / `base_character_context` / `interaction` and never
  records cross-character appearance pairs (pollution guard,
  `test_phase_a_scoped_learning.py:96`). `test_successful_generate_learns_once`
  (`:162`) asserts exactly-once semantics.
- `snapshot_restore` (`app.py:3376`) returns the full `structured_state` unless a
  section filter is requested; `restoreSnapshot` (`static/app.js:2152`) then
  `migratePromptState` (→ `normalize`) and, with no section filter, replaces
  `state.prompt` wholesale — a full restore.

## 7. Runtime contract (API-only) + main divergence (F16)

- `server/server.mjs:191` hard-codes `{ mode: "api-only", cdp: "disabled",
  webCompatibility: false }`; CORS is restricted to loopback origins
  (`:195-212`), so a remote page cannot spend Anlas against localhost.
- Proxy fallback: `server/novelai-provider.mjs:26-52` parses `NAI_PROXY_URL` /
  settings-file proxy with a zero-dependency fallback, and returns `direct`
  fetch when no proxy is configured.
- Baidu translate diagnostics: `app.py:1875-1942` (`baidu_translate_sign` +
  error-code map `52001/54001/54003/54004/54005/58001` + explicit
  `HTTPException(428/502)` messages) make upstream failures diagnosable.
- Linux fresh clone: `tests/test_linux_bootstrap.py` (3 tests) +
  `config/navigation.default.json` + `app.ensure_seeded()` skip of optional
  taxonomy seed.

**Main divergence:** `git merge-base main integration/product-v3` is `f99fd6c`,
which is `main`'s tip — `main` is fully contained in `integration/product-v3`.
All four main-only features are present in the current tree (see §7 markers).

---

## Verdict per scenario

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| F1/F2 schema v2 + mutation authority | PASS (unit) | `prompt-document.js:47/70/118`, `test_prompt_document.mjs` |
| F3 cold-start empty states | PASS | `app.js:2050` hides empty panel; mode roots mount |
| F4 double character | PASS | `prompt-document.js` target isolation; `test_prompt_document.mjs` |
| F5 next-step ordering | PASS | `test_phase_c_recommendation_v3.py:42` |
| F6 visual breadcrumb/recs | PASS | `visual-builder.js:207/218` |
| F7 semantic error + retry | PASS | `visual-builder.js:196` |
| F8 target switch no stale content | PASS | `app.js` `renderWorkbenchEditorFromDocument({force:true})` on tab switch (`:4514-4523`) |
| F9 participants 1→2→3→2 | PASS | `nsfw-builder.js:457` + `prompt-document.js:215` |
| F10 interaction metadata | PASS | `prompt-document.js:233` + `prompt-tokenizer.js:35-95` |
| F11 context alters recs | PASS | `test_phase_c_recommendation_v3.py:85/94/100` |
| F12 learning exactly-once | PASS (unit) | `test_phase_a_scoped_learning.py:162/140` |
| F13 offline prior | PASS (unit) | `test_phase_a_scoped_learning.py:311/381/401` |
| F14 100% restore | PASS | `app.py:3376` + `app.js:2152` |
| F15 syntax fidelity | PASS (unit) | `test_prompt_tokenizer.mjs`, `test_prompt_compiler.mjs` |

## No material findings

No concrete product defect was established from the API/logic walk-through. The
four main-only features are retained; the Python suite is green (279 tests, 12
subtests); the codec is single-authority and lossless.

## Low-severity observations (not blocking)

1. **Restore returns the user to the browse view.** `restoreSnapshot`
   (`static/app.js:2165`) ends with `await showView("browse")` and a toast, so
   after a full restore the workbench closes and the user must click 生图 to
   continue editing. Data restore is 100% complete — this is a navigation choice,
   not a data bug. *Minimal fix (optional):* stay in `generate` view after a
   workbench-initiated restore, or show the restored target in the workbench
   before returning.
2. **Browser E2E is not yet executed.** `e2e/product-v3.spec.mjs` is committed
   but unexecuted because the runtime is absent. The selectors are pinned to the
   real DOM (verified 2026-08-27), but a first run in a Node/Playwright
   environment may surface selector/bootstrap drift to triage before F1–F15 is
   declared browser-PASS.

## Blockers

- No `node`/`npm`/`npx`/`bun`/`deno`/Playwright on this machine → `npm test`,
  `node --check`, and the Playwright E2E suite could not be run. Python suite and
  main-divergence analysis are complete.
