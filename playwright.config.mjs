// playwright.config.mjs — Browser product E2E against the REAL local stack.
//
// The spec (e2e/product-v3.spec.mjs) drives the real static/index.html served by
// the real Node frontend (:8787), which proxies the product APIs to the real
// Python backend (:8123). The ONLY NovelAI upstream that is mocked is the paid
// generation path (POST /api/novelai/generate) plus the /api/novelai/status
// probe gate — no Recommendation / Semantic / Scene / Offline-Prior / Snapshot
// API is stubbed.
//
// Two webServer entries:
//   (a) Python FastAPI backend (:8123) — auto-start of the Node layer is
//       suppressed via TAGS_MARKET_AUTOSTART_NAI=0 because we start Node
//       ourselves in (b).
//   (b) Node frontend (:8787) — started with --experimental-sqlite exactly like
//       app.py's own autostart (store.mjs uses node:sqlite).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 2,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    headless: true,
  },
  webServer: [
    {
      command: "bash -c 'export TAGS_MARKET_AUTOSTART_NAI=0; source .venv/bin/activate; python app.py'",
      url: "http://127.0.0.1:8123/docs",
      timeout: 120_000,
      reuseExistingServer: true,
    },
    {
      command: "node --experimental-sqlite server/server.mjs --port 8787",
      url: "http://127.0.0.1:8787/",
      timeout: 60_000,
      reuseExistingServer: true,
    },
  ],
});
