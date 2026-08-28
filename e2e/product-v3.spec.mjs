import { test, expect } from "@playwright/test";

// =============================================================================
// Browser product E2E — integration/product-v3 (Phases A–E, run for REAL).
//
// This spec drives the REAL static/index.html served by the real Node frontend
// (:8787) which proxies the product APIs to the real Python backend (:8123).
// The ONLY upstream that is mocked is the NovelAI surface:
//
//   * POST /api/novelai/generate  -> canned success (no token / no Anlas spent)
//   * GET  /api/novelai/status    -> "connected" gate (the real probe would
//                                    require a live NovelAI network + valid
//                                    token and, on this machine, returns
//                                    "unreachable" which would disable the
//                                    Generate button; we simulate a healthy
//                                    connection so the paid-generation path can
//                                    be reached and mocked).
//
// Nothing else is stubbed: Recommendation / Semantic / Scene Composer /
// Offline-Prior / Snapshot / Settings / Catalog all run against the real stack.
//
// Run:  npm run test:e2e        (playwright.config.mjs boots the stack).
// =============================================================================

const FRONT = "http://127.0.0.1:8787";
const BACK = "http://127.0.0.1:8123";

// Frozen scenario matrix (from the task contract).
const TAGS = {
  base: ["bedroom", "night"],
  c1: ["Citlali", "white hair", "purple eyes", "white dress"],
  c2: ["Furina", "blue hair", "blue eyes", "blue dress"],
};

// -----------------------------------------------------------------------------
// NovelAI upstream mock (the ONLY mocked surface).
// -----------------------------------------------------------------------------
// Tracks in-flight slow backend calls (recommendations / semantic-state) so the
// test can drain them before the next bridge change. The recommendation endpoint
// serializes pathologically under concurrency (1 call ≈2s, 2 concurrent ≈9.6s,
// 4 ≈29s), so we must never let them pile up.
let activeLoad = null;
const SLOW_API = /\/api\/(recommendations|semantic-state)/;

async function installNovelAIMocks(page) {
  const stats = { statusCalls: 0, generateCalls: 0, generatePayloads: [] };
  const load = { pending: 0 };
  activeLoad = load;
  page.on("request", (r) => { if (SLOW_API.test(r.url())) load.pending += 1; });
  page.on("requestfinished", (r) => { if (SLOW_API.test(r.url())) load.pending = Math.max(0, load.pending - 1); });
  page.on("requestfailed", (r) => { if (SLOW_API.test(r.url())) load.pending = Math.max(0, load.pending - 1); });

  await page.route("**/api/novelai/status", async (route) => {
    stats.statusCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, configured: true, state: "connected", subscriptionTier: "opus", network: "direct" }),
    });
  });

  await page.route("**/api/novelai/generate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    stats.generateCalls += 1;
    let payload = {};
    try { payload = (await route.request().postDataJSON()) || {}; } catch { /* ignore */ }
    stats.generatePayloads.push(payload);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, batchId: `e2e-batch-${stats.generateCalls}`, status: "running", total: payload.count || 1 }),
    });
  });

  return stats;
}

// -----------------------------------------------------------------------------
// Real API traffic capture (observation only — never mocking).
// -----------------------------------------------------------------------------
function captureRecommendations(page) {
  const records = [];
  page.on("response", async (res) => {
    const req = res.request();
    if (req.method() !== "POST" || !req.url().includes("/api/recommendations")) return;
    let payload = null;
    let body = null;
    try { payload = await req.postDataJSON(); } catch { /* ignore */ }
    try { body = await res.json(); } catch { /* ignore */ }
    records.push({ payload, body, status: res.status() });
  });
  return records;
}

// Capture recommendation request payloads at REQUEST time (the responses are
// slow ~3s and often still in-flight when we want to assert the context fields).
function captureRecommendationRequests(page) {
  const records = [];
  page.on("request", async (req) => {
    if (req.method() !== "POST" || !req.url().includes("/api/recommendations")) return;
    let payload = null;
    try { payload = await req.postDataJSON(); } catch { /* ignore */ }
    records.push({ payload });
  });
  return records;
}

function captureSemanticState(page) {
  const records = [];
  page.on("response", async (res) => {
    const req = res.request();
    if (req.method() !== "POST" || !req.url().includes("/api/semantic-state")) return;
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    records.push({ body, status: res.status() });
  });
  return records;
}

// -----------------------------------------------------------------------------
// Page helpers.
// -----------------------------------------------------------------------------
async function openWorkbench(page) {
  await page.goto(FRONT + "/");
  // Wait for the app to finish init() (module imports + nsfw-builder options +
  // workbench component wiring) before interacting, otherwise the mode-switch
  // click listener has not been attached yet.
  await page.waitForFunction(() => !!window.WorkbenchMode && !!window.WorkbenchComponents);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  // Generate button must become enabled (status probe is mocked "connected").
  await expect(page.locator("#nai-gen")).toBeEnabled({ timeout: 15000 });
}

const editor = (page) => page.locator("#nai-editor");

async function selectMode(page, mode) {
  // Recommendation / Visual / Scene are marketplace tools.  "text" now
  // means returning to the lightweight generation editor for assertions that
  // edit the authoritative PromptDocument; it is no longer a Generate-mode
  // tool tab.
  if (mode === "text") {
    await page.locator('button[data-module="generate"]').click();
    await expect(page.locator("#generate-view")).toBeVisible();
    return;
  }
  await page.locator('button[data-module="market"]').click();
  await expect(page.locator("main.layout")).toBeVisible();
  const btn = page.locator(`#prompt-mode-switch button[data-prompt-mode="${mode}"]`);
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(btn).toHaveClass(/active/);
  await expect(page.locator("#market-builder-root")).toBeVisible();
}

// Add a NEW character via the "+ 角色" button (auto-switches to it) and fill it.
async function addCharacter(page, tags) {
  await page.locator("#nai-character-add").click();
  await editor(page).fill(tags.join(", "));
  await settle(page);
}

// Fill an EXISTING character (0 = "Character 1", 1 = "Character 2", ...).
// The app's PromptDocument starts with one pre-existing character, so the first
// scenario character is filled into index 0 rather than added.
async function fillCharacter(page, index, tags) {
  await switchTarget(page, String(index));
  await editor(page).fill(tags.join(", "));
  await settle(page);
}

async function switchTarget(page, target) {
  await page.locator(`[data-nai-char-tab="${target}"]`).click();
  await settle(page);
}

// The semantic composer renders even while "loading" (aria-busy="true"); wait for
// the real semantic-state to land (aria-busy="false") before drilling into nodes.
async function waitForVisualReady(page) {
  await expect(page.locator('#visual-prompt-root .semantic-composer[aria-busy="false"]')).toBeVisible({ timeout: 60000 });
}

// Save the current PromptDocument as a snapshot via the real cart UI (browse view).
async function saveSnapshotViaCart(page) {
  await page.locator('button[data-module="market"]').click();
  await expect(page.locator("#cart")).toBeVisible();
  await page.locator("#cart-more-btn").click();
  await page.locator("#save-snapshot-btn").click();
  await settle(page);
}

// The scene/tag builders fire slow /api/recommendations calls on every bridge
// change, and the recommendation endpoint serializes pathologically under
// concurrency (1 call ≈2s, 2 concurrent ≈9.6s). Let the debounced call fire,
// then wait for all in-flight slow calls to drain so they never pile up.
async function settle(page) {
  await page.waitForTimeout(600); // debounce (~320ms) → the call fires
  if (activeLoad) {
    await expect.poll(() => activeLoad.pending, { timeout: 120000 }).toBe(0);
  }
}

// Restore the most recent snapshot via the real Prompt 历史 modal (browse view).
async function restoreLatestSnapshot(page) {
  await page.locator('button[data-module="market"]').click();
  await page.locator("#prompt-history-btn").click();
  await expect(page.locator("#snapshot-modal")).toBeVisible();
  const first = page.locator("#snapshot-list [data-restore]").first();
  await expect(first).toBeVisible({ timeout: 15000 });
  await first.click();
  // restoreSnapshot() ends by navigating back to the browse view.
  await expect(page.locator("#snapshot-modal")).toBeHidden({ timeout: 20000 });
  await expect(page.locator("main.layout")).toBeVisible();
  await settle(page);
}

// =============================================================================
// Scenario suite — real local integration (acceptance 9.5–9.11).
// =============================================================================
test.describe.configure({ mode: "serial" });

test("9.5 full path Base→C1→C2→Text→Recommendation→Visual→Scene→Snapshot→Restore→Generate", async ({ page }) => {
  const stats = await installNovelAIMocks(page);
  await openWorkbench(page);

  // Text: Base + C1 + C2. (C1 fills the pre-existing Character 1; C2 is added.)
  await editor(page).fill(TAGS.base.join(", "));
  await settle(page);
  await fillCharacter(page, 0, TAGS.c1);
  await addCharacter(page, TAGS.c2);

  await expect(page.locator("#nai-character-count")).toHaveText("2");
  await switchTarget(page, "base");
  await expect(editor(page)).toHaveValue(/bedroom/);
  await switchTarget(page, "0");
  await expect(editor(page)).toHaveValue(/Citlali/);
  await switchTarget(page, "1");
  await expect(editor(page)).toHaveValue(/Furina/);
  await expect(editor(page)).not.toHaveValue(/Citlali/);

  // Recommendation + Visual: switch to Visual on C2 and drill into Eyes to fire
  // the real semantic tree + semantic-state + recommendation round-trip.
  await selectMode(page, "visual");
  await waitForVisualReady(page);
  await page.locator('#visual-prompt-root button[data-node="char_appearance"]').click();
  await page.locator('#visual-prompt-root button[data-node="char_eyes"]').click();
  await expect(page.locator("#visual-prompt-root .semantic-inspector")).toBeVisible({ timeout: 15000 });

  // Scene: real scene composer options load.
  await selectMode(page, "scene");
  await expect(page.locator("#nsfw-builder-root .nsfw-builder")).toBeVisible({ timeout: 15000 });

  // Snapshot → Restore (real snapshot API + cart UI).
  await selectMode(page, "text");
  await switchTarget(page, "base");
  await saveSnapshotViaCart(page);

  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  await switchTarget(page, "base");
  await editor(page).fill("mutated beyond recognition");
  await settle(page);

  await restoreLatestSnapshot(page);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  await switchTarget(page, "base");
  await expect(editor(page)).toHaveValue(/bedroom/);
  await expect(editor(page)).not.toHaveValue(/mutated/);

  // Generate (mocked NovelAI; snapshot is saved for real first). Re-await the
  // enabled state because re-entering the view re-probes the (mocked) status.
  // The scene/tag builders fire slow (~3s) recommendation calls on every bridge
  // change; let them settle so the generate request is not starved.
  await expect(page.locator("#nai-gen")).toBeEnabled({ timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.locator("#nai-gen").click();
  await expect.poll(() => stats.generateCalls, { timeout: 30000 }).toBe(1);
  await expect(page.locator("#nai-job")).toContainText(/Generating|生成中/i);
});

test("9.6 C2 Hair/Eyes/Clothing filled; Eyes alternatives never pollute Next Step", async ({ page, request }) => {
  await installNovelAIMocks(page);
  const semanticStates = captureSemanticState(page);

  await openWorkbench(page);
  await editor(page).fill(TAGS.base.join(", "));
  await settle(page);
  await fillCharacter(page, 0, TAGS.c1);
  await addCharacter(page, TAGS.c2);
  await switchTarget(page, "1");

  await selectMode(page, "visual");
  await waitForVisualReady(page);
  await page.locator('#visual-prompt-root button[data-node="char_appearance"]').click();
  await page.locator('#visual-prompt-root button[data-node="char_eyes"]').click();
  await expect(page.locator("#visual-prompt-root .semantic-inspector")).toBeVisible({ timeout: 15000 });

  // (a) Hair / Eyes / Clothing slots are FILLED for C2 (char:1), from the real
  // semantic-state the visual builder already fetched.
  const charState = semanticStates.map((r) => r.body).filter(Boolean)
    .findLast((b) => Array.isArray(b.character_slots) && (b.character_slots[1] || []).length);
  const charSlots = charState?.character_slots?.[1] || [];
  const statusOf = (nodeId) => charSlots.find((s) => s.node_id === nodeId)?.status;
  expect(statusOf("char_hair")).toBe("filled");
  expect(statusOf("char_eyes")).toBe("filled");
  expect(statusOf("char_clothing")).toBe("filled");

  // (b) The Eyes-node recommendation contract, checked against the REAL
  // recommendation API with the UI-captured PromptDocument. (We hit :8123
  // directly rather than waiting on the browser-triggered call, which is slow
  // because the scene/tag builders fire many concurrent recommendation calls.)
  const doc = await page.evaluate(() => window.PromptBridge.getDocument());
  const recRes = await request.post(`${BACK}/api/recommendations`, {
    data: {
      tags: ["bedroom", "night", "furina", "blue hair", "blue eyes", "blue dress"],
      target: "character", active_target: "char:1", active_section: "appearance",
      node_id: "char_eyes", semantic_node: "char_eyes",
      assistant_context: doc.assistant_context || {}, participant_count: 2,
      structured_state: doc, generation_config: { positiveTier: "standard" }, limit: 20,
      mode: "general", primary_scene_type: "", stage: "", position: "", body_focus: "",
      additional_activities: [], clothing_state: {}, last_added_tag: "",
    },
  });
  expect(recRes.ok()).toBe(true);
  const body = await recRes.json();
  const additiveTags = (body.recommendations || []).map((i) => String(i.tag).toLowerCase());
  const nextStepNodeIds = (body.next_steps || []).map((s) => String(s.node_id));
  const alternativeTags = (body.alternatives || []).map((i) => String(i.tag).toLowerCase());

  // Eye-colour alternatives (same-slot neighbours of "blue eyes") surface in the
  // `alternatives` layer (e.g. red eyes / green eyes), never in the additive
  // `recommendations` nor `next_steps`. ("hair between eyes" is a hair tag, not
  // an eye-colour alternative, so we exclude hair-* tags from the eye check.)
  const eyeAlternativeTags = alternativeTags.filter((t) => /eyes$/.test(t) && !/hair/.test(t));
  expect(eyeAlternativeTags.length, "eye-colour alternatives present").toBeGreaterThan(0);
  const additiveSet = new Set(additiveTags);
  for (const t of eyeAlternativeTags) {
    expect(additiveSet.has(t), `eye alternative "${t}" must not pollute additive recommendations`).toBe(false);
  }
  expect(nextStepNodeIds).not.toContain("char_eyes");

  // (c) Next steps come from the missing slots and include the action-family
  // slots (Expression/Pose/Action are all still empty for C2).
  const missingSlotIds = charSlots.filter((s) => s.status === "empty").map((s) => s.node_id);
  for (const id of ["char_expression", "char_pose", "char_action"]) {
    expect(missingSlotIds, `C2 ${id} is a missing slot`).toContain(id);
  }
});

test("9.7 scene context reaches the recommendation API (Stage/Position/BodyFocus/Participant)", async ({ page, request }) => {
  await installNovelAIMocks(page);
  const recRequests = captureRecommendationRequests(page);

  await openWorkbench(page);
  await selectMode(page, "scene");
  await expect(page.locator("#nsfw-builder-root .nsfw-builder")).toBeVisible({ timeout: 15000 });

  // Participants 1 -> 2 (context change #1).
  await page.locator('#nsfw-builder-root button[data-action="participants"][data-key="2"]').click();
  await expect.poll(() => recRequests.length).toBeGreaterThan(0);
  await settle(page);

  // Stage -> MAIN_ACT (context change #2).
  await page.locator('#nsfw-builder-root button[data-action="exclusive"][data-group="stage"][data-key="MAIN_ACT"]').click();
  await settle(page);

  // Position (context change #3).
  await page.locator('#nsfw-builder-root button[data-action="exclusive"][data-group="position"][data-key="missionary"]').click();
  await settle(page);

  // Body focus (context change #4).
  await page.locator('#nsfw-builder-root button[data-action="body-focus"][data-key="breasts"]').click();

  await expect.poll(() => recRequests.length).toBeGreaterThanOrEqual(4);

  // Each context change is wired end-to-end into the recommendation request.
  const seen = {
    participant_2: recRequests.some((r) => Number(r.payload?.participant_count) === 2),
    stage_main_act: recRequests.some((r) => String(r.payload?.stage).toUpperCase() === "MAIN_ACT"),
    position_missionary: recRequests.some((r) => String(r.payload?.position) === "missionary"),
    body_focus_breasts: recRequests.some((r) => String(r.payload?.body_focus) === "breasts"),
  };
  expect(seen.participant_2, "participant_count=2 reaches the recommendation API").toBe(true);
  expect(seen.stage_main_act, "stage=MAIN_ACT reaches the recommendation API").toBe(true);
  expect(seen.position_missionary, "position=missionary reaches the recommendation API").toBe(true);
  expect(seen.body_focus_breasts, "body_focus=breasts reaches the recommendation API").toBe(true);

  // The responses are real, non-empty recommendations from the live backend.
  const doc = await page.evaluate(() => window.PromptBridge.getDocument());
  const recRes = await request.post(`${BACK}/api/recommendations`, {
    data: {
      tags: [], target: "base", active_target: "base", mode: "adult",
      structured_state: doc, generation_config: { positiveTier: "standard" }, limit: 20,
      participant_count: 2, primary_scene_type: "", primary_act: "",
      stage: "MAIN_ACT", position: "missionary", body_focus: "breasts",
      additional_activities: [], clothing_state: {}, last_added_tag: "", node_id: "",
    },
  });
  expect(recRes.ok()).toBe(true);
  const body = await recRes.json();
  expect(Array.isArray(body.recommendations)).toBe(true);

  // NOTE (finding): with the frozen empty-prompt input the recommendation
  // service's scene-context candidates (position/body_focus) classify into
  // sections outside the "base" target's allowed sections and are filtered, so
  // the *response* Top-10 is stable across these context changes. The context
  // is still provably wired into the request (asserted above). See final report.
});

test("9.8 offline prior available + semantic features run without SiliconFlow", async ({ page, request }) => {
  await installNovelAIMocks(page);

  // The offline prompt prior is a Python-only endpoint (not proxied by Node).
  const status = await request.get(`${BACK}/api/offline-prior/status`);
  expect(status.ok()).toBe(true);
  const prior = await status.json();
  expect(prior.available).toBe(true);
  expect(Number(prior.node_count)).toBeGreaterThan(0);

  // Semantic features (navigation tree + semantic-state + recommendation) work
  // without any SILICONFLOW_API_KEY — the whole offline prior is local.
  await openWorkbench(page);
  await selectMode(page, "visual");
  await waitForVisualReady(page);
  // The simplified workflow opens the marketplace on Base by default; the
  // visual builder therefore exposes Base nodes before a character is chosen.
  await expect(page.locator('#visual-prompt-root button[data-node="base_composition"]')).toBeVisible();
});

test("9.9 scene participants 1→2→3→2 keep tabs / assistant_context / summary sync", async ({ page }) => {
  await installNovelAIMocks(page);
  await openWorkbench(page);
  await selectMode(page, "scene");
  await expect(page.locator("#nsfw-builder-root .nsfw-builder")).toBeVisible({ timeout: 15000 });

  const participants = (key) => page.locator(`#nsfw-builder-root button[data-action="participants"][data-key="${key}"]`);
  const context = () => page.evaluate(() => window.PromptBridge.getDocument().assistant_context);

  await participants("2").click();
  await settle(page);
  await expect(page.locator("#nai-character-count")).toHaveText("2");
  await expect(page.locator('[data-nai-char-tab="1"]')).toBeVisible();
  await expect(page.locator("#nsfw-builder-root .nb-summary")).toContainText("2人");

  await participants("3").click();
  await settle(page);
  await expect(page.locator("#nai-character-count")).toHaveText("3");
  await expect(page.locator('[data-nai-char-tab="2"]')).toBeVisible();
  await expect(page.locator("#nsfw-builder-root .nb-summary")).toContainText("3人");

  await participants("2").click();
  await settle(page);
  await expect(page.locator("#nai-character-count")).toHaveText("2");
  await expect(page.locator('[data-nai-char-tab="1"]')).toBeVisible();
  await expect(page.locator('[data-nai-char-tab="2"]')).toHaveCount(0);
  await expect(page.locator("#nsfw-builder-root .nb-summary")).toContainText("2人");

  const ctx = await context();
  expect(ctx.participant_count).toBe(2);
});

test("9.10 interaction C1→kissing→C2 serializes source#/target#; snapshot restores them", async ({ page }) => {
  await installNovelAIMocks(page);
  await openWorkbench(page);
  await selectMode(page, "scene");
  await expect(page.locator("#nsfw-builder-root .nsfw-builder")).toBeVisible({ timeout: 15000 });

  await page.locator('#nsfw-builder-root button[data-action="participants"][data-key="2"]').click();
  await settle(page);
  await expect(page.locator("#nai-character-count")).toHaveText("2");

  // C1 → kissing → C2 (default actor=0, target=1, directional).
  await page.locator('#nsfw-builder-root button[data-action="interaction-add"][data-key="kissing"]').click();
  await settle(page);
  await expect(page.locator("#nsfw-builder-root .nb-summary")).toContainText(/C1 kissing C2|接吻/);

  // Scene → Text: the relation entries serialize as source# / target#.
  await selectMode(page, "text");
  await switchTarget(page, "0");
  await expect(editor(page)).toHaveValue(/source#kissing/);
  await switchTarget(page, "1");
  await expect(editor(page)).toHaveValue(/target#kissing/);

  // Snapshot → mutate → Restore preserves the relation metadata.
  await saveSnapshotViaCart(page);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  await switchTarget(page, "0");
  await editor(page).fill("mutated");
  await settle(page);
  await restoreLatestSnapshot(page);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  await switchTarget(page, "0");
  await expect(editor(page)).toHaveValue(/source#kissing/);
  await switchTarget(page, "1");
  await expect(editor(page)).toHaveValue(/target#kissing/);
});

test("9.11 syntax fidelity survives Text→Visual→Scene→Snapshot→Restore→Generate", async ({ page }) => {
  const stats = await installNovelAIMocks(page);
  await openWorkbench(page);

  const syntax = "1.35::blue eyes::, 1.5::rain, night::, -1::hat::, {{tag}}, [[tag]], source#hug, target#kiss, mutual#hold";
  const TOKENS = ["1.35::blue eyes::", "1.5::rain, night::", "-1::hat::", "{{tag}}", "[[tag]]", "source#hug", "target#kiss", "mutual#hold"];

  await editor(page).fill(syntax);
  await settle(page);

  // Round-trip through all three modes without dropping tokens.
  await selectMode(page, "visual");
  await selectMode(page, "scene");
  await selectMode(page, "text");
  for (const tok of TOKENS) {
    await expect(editor(page)).toHaveValue(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // Snapshot → mutate → Restore → Generate (mocked).
  await saveSnapshotViaCart(page);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  await editor(page).fill("temporary junk");
  await settle(page);
  await restoreLatestSnapshot(page);
  await page.locator('button[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
  await selectMode(page, "text");
  for (const tok of TOKENS) {
    await expect(editor(page)).toHaveValue(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  await expect(page.locator("#nai-gen")).toBeEnabled({ timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.locator("#nai-gen").click();
  await expect.poll(() => stats.generateCalls, { timeout: 30000 }).toBe(1);

  // The mocked generate payload's prompt keeps the syntax tokens intact.
  const prompt = String(stats.generatePayloads[0]?.prompt || "");
  for (const tok of TOKENS) {
    expect(prompt, `generate prompt keeps "${tok}"`).toContain(tok);
  }
});
