# Browser product E2E

The suite in `product-v3.spec.mjs` drives the real `static/index.html` page and
uses Playwright route interception for every API call. In particular,
`/api/novelai/generate` is mocked, so no NovelAI request, token, or Anlas is
used.

## Run

Install Node.js 22.5+ and Playwright in an environment with the repository
dependencies installed, then start the normal local services (or point at an
already-running Node/Python integration server). If Playwright is not added to
the project workspace, `npx --yes` can provide it for a one-off run:

```sh
npm install
npx playwright install chromium
E2E_BASE_URL=http://127.0.0.1:8787 npx playwright test e2e/product-v3.spec.mjs
```

One-off equivalent:

```sh
npx --yes playwright@latest install chromium
E2E_BASE_URL=http://127.0.0.1:8787 npx --yes playwright@latest test e2e/product-v3.spec.mjs
```

The current Phase F machine has no `node`, `npm`, `npx`, or Playwright binary;
therefore execution is intentionally reported as BLOCKED, not silently
replaced by a static test.
