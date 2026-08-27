# Phase F independent review

## Scope and method

Independent API/logic walk-through of the product path on `integration/product-v3`:
cold start → Base and two character targets → scoped recommendations → Visual
navigation → Scene participants/interactions → snapshot restore → mocked
generation. This review did not treat the development phase conclusions as
evidence; it inspected the implementation and the Python regression suite.

## Confirmed findings

- **Prompt contract is centralized.** `static/prompt-document.js:47-60` normalizes
  schema v2, while `:81-118` keeps recommendation context target-local and
  `:215-241` carries participant and interaction metadata. This is the correct
  authority boundary for Text/Visual/Scene convergence.
- **Cross-character relation metadata survives serialization.**
  `static/prompt-document.js:233-241` writes source/target/mutual entries and
  `static/prompt-tokenizer.js`/`prompt-document.js` preserve relation and weight
  syntax instead of flattening it.
- **Generation is API-only and protected.** `server/server.mjs:191-212` exposes
  the explicit API-only status and rejects non-loopback API origins; the actual
  generation route delegates to `ApiBatchController` and `NovelAIProvider`.
  No paid request was made in this review.
- **Failure paths are non-blank.** Python translation diagnostics are implemented
  at `app.py:1876-1942`, including upstream Baidu error details; Node proxy
  failure returns an explicit `PYTHON_SERVICE_UNAVAILABLE` at
  `server/server.mjs:171-187`.
- **Regression evidence is green.** The available Python suite completed 279
  tests and 12 subtests successfully. JavaScript execution could not be
  independently run because the required runtime is absent (see blockers).

## No material findings

No concrete product defect was established from the API/logic walk-through.
The browser-level usability claims remain **unverified** until the E2E harness
can run with Node 22.5+ and Playwright; that is an environment blocker, not a
product pass.

## Minimal follow-up

Run `e2e/product-v3.spec.mjs` in a Node/Playwright environment and triage any
selector or bootstrap fixture mismatch before declaring F1–F15 browser PASS.
