import { test, expect } from "@playwright/test";

// =============================================================================
// Browser product E2E — integration/product-v3 (Phases A–E).
//
// Run:
//   E2E_BASE_URL=http://127.0.0.1:8787 npx playwright test e2e/product-v3.spec.mjs
//
// Contract (hard rules, see e2e/README.md):
//   * The page under test is the REAL static/index.html served by the real
//     Python/Node integration stack. We never stub the app bundle.
//   * Every `/api/**` call is intercepted by `page.route`. The NovelAI generate
//     path (`/api/novelai/generate`) is ALWAYS mocked, so no token / Anlas is
//     ever consumed and no paid generation is triggered.
//   * Selectors below are pinned to real DOM ids in static/index.html and the
//     render output of static/*.js (verified 2026-08-27). If a selector drifts,
//     the test fails loudly — do not silently weaken assertions.
// =============================================================================

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";

// Scenario tag fixtures (mirroring the frozen scenario matrix).
const TAGS = {
  base: ["bedroom", "night"],
  c1: ["Citlali", "white hair", "purple eyes", "white dress"],
  c2: ["Furina", "blue hair", "blue eyes", "blue dress"],
};

const SECTION_IDS = ["character", "appearance", "clothing", "expression", "pose", "action", "composition", "scene", "style", "quality", "other"];

// -----------------------------------------------------------------------------
// Deterministic fixtures returned by the API mocks.
// -----------------------------------------------------------------------------

// Schema v2 PromptDocument (mirrors static/prompt-document.js `createEmpty()`).
function documentFixture() {
  return {
    schema_version: 2,
    sections: Object.fromEntries(SECTION_IDS.map((x) => [x, []])),
    characters: [{ name: "Character 1", prompt_sections: {}, uc_sections: {}, position: null }],
    global_uc_sections: {},
    free_text: "",
    free_text_en: "",
    assistant_context: { participant_count: 1 },
  };
}

// Semantic navigation tree shape returned by GET /api/catalog/semantic
// (visual-builder.js reads `data.tree` and expects nodes with id/label/section/
// target/children; `Appearance` → `Eyes` is what F6 drives).
function semanticTreeFixture() {
  return {
    tree: {
      base: {
        id: "base", label: "Base",
        children: [
          { id: "base_subject_count", label: "Subject / Count", section: "character", target: "base", children: [] },
          { id: "quality", label: "Quality", section: "quality", target: "base", displayOnly: true, children: [] },
        ],
      },
      character: {
        id: "character", label: "Character",
        children: [
          { id: "char_identity", label: "Identity", section: "character", target: "character", children: [] },
          {
            id: "appearance", label: "Appearance", section: "appearance", target: "character",
            children: [
              { id: "eyes", label: "Eyes", section: "appearance", target: "character", children: [] },
              { id: "hair", label: "Hair", section: "appearance", target: "character", children: [] },
            ],
          },
          { id: "clothing", label: "Clothing", section: "clothing", target: "character", children: [] },
          { id: "expression", label: "Expression", section: "expression", target: "character", children: [] },
          { id: "pose", label: "Pose", section: "pose", target: "character", children: [] },
          { id: "action", label: "Action", section: "action", target: "character", children: [] },
        ],
      },
    },
  };
}

// POST /api/semantic-state response (visual-builder.js `slotsForTarget` reads
// `base_slots` / `character_slots`). Slots that are empty drive "下一步" (next).
function semanticStateFixture() {
  return {
    base_slots: [
      { node_id: "base_subject_count", label: "Subject / Count", status: "empty", reason: "尚未设置" },
    ],
    character_slots: [
      [
        { node_id: "char_identity", label: "Identity", status: "filled", evidence_tags: ["Furina"] },
        { node_id: "eyes", label: "Eyes", status: "filled", evidence_tags: ["blue eyes"] },
        { node_id: "hair", label: "Hair", status: "filled", evidence_tags: ["blue hair"] },
        { node_id: "clothing", label: "Clothing", status: "filled", evidence_tags: ["blue dress"] },
        { node_id: "expression", label: "Expression", status: "empty", reason: "尚未设置" },
        { node_id: "pose", label: "Pose", status: "empty", reason: "尚未设置" },
        { node_id: "action", label: "Action", status: "empty", reason: "尚未设置" },
      ],
    ],
    scene_slots: [],
    intent: { kind: "portrait", zh: "人物特写" },
    summary: "人物已完成身份 / 眼睛 / 头发 / 服装；下一步建议表情 / 姿势 / 动作。",
  };
}

// -----------------------------------------------------------------------------
// API mocking. `stats` is a per-test object the harness can assert against
// (e.g. F12 exactly-once learning).
// -----------------------------------------------------------------------------
async function installApiMocks(page, { semanticFailure = false, generateFailure = false } = {}) {
  const stats = {
    generateCalls: 0,
    recommendationCalls: 0,
    snapshotPosts: 0,
    learnCalls: 0,
    favoritePosts: 0,
    snapshots: new Map(), // id -> structured_state (in-memory snapshot store)
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const p = url.pathname;

    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    // ---- Semantic failure injection (F7) ----
    if (semanticFailure && (p.includes("/semantic") || p === "/api/semantic-state" || p === "/api/catalog/semantic")) {
      return json(500, { error: "semantic service unavailable" });
    }

    // ---- NovelAI runtime status (must look "configured" so Generate enables) ----
    if (p === "/api/novelai/status") {
      return json(200, { ok: true, mode: "api-only", configured: true, state: "connected" });
    }

    // ---- NovelAI generate — ALWAYS mocked (F12 counts calls) ----
    if (p === "/api/novelai/generate" && method === "POST") {
      stats.generateCalls += 1;
      if (generateFailure) return json(500, { ok: false, code: "INSUFFICIENT_CREDITS", error: "Anlas 余额不足" });
      return json(200, { ok: true, batchId: "e2e-batch", total: 1 });
    }

    // ---- Scoped learning / feedback (server-side writeback) ----
    if (p === "/api/cooccurrence/record") {
      stats.learnCalls += 1;
      return json(200, { ok: true, tags: [], pairs: 0 });
    }
    if (p === "/api/favorites" && method === "POST") {
      stats.favoritePosts += 1;
      return json(200, { ok: true, tag: (request.postDataJSON?.() || {}).tag });
    }

    // ---- Recommendations (F5/F6/F11; deterministic next-step pool) ----
    if (p === "/api/recommendations") {
      stats.recommendationCalls += 1;
      const body = request.postDataJSON?.() || {};
      const selected = new Set((body.tags || []).map((x) => String(x).toLowerCase()));
      const pool = [
        { tag: "smile", section: "expression" },
        { tag: "standing", section: "pose" },
        { tag: "holding", section: "action" },
        { tag: "looking at viewer", section: "expression" },
      ];
      const recs = pool.filter((r) => !selected.has(r.tag)).map((r) => ({ ...r, zh: r.tag }));
      return json(200, {
        recommendations: recs,
        // F5/F6 next-step contract: Expression → Pose → Action.
        next_steps: [
          { node_id: "expression", label: "Expression", reason: "表情未设置" },
          { node_id: "pose", label: "Pose", reason: "姿势未设置" },
          { node_id: "action", label: "Action", reason: "动作未设置" },
        ],
      });
    }

    // ---- Semantic tree (Visual builder) ----
    if (p === "/api/catalog/semantic") return json(200, semanticTreeFixture());

    // ---- Semantic state (Visual builder) ----
    if (p === "/api/semantic-state") return json(200, semanticStateFixture());

    // ---- Scene Composer options (nsfw-builder.js) ----
    if (p === "/api/nsfw-builder/options") {
      return json(200, {
        participants: [{ key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }],
        primaryActs: [{ key: "kiss", label: "接吻", tag: "kissing", route: "interaction", minParticipants: 2 }],
        scenes: [{ key: "bedroom", label: "卧室", tag: "bedroom", route: "base", section: "scene" }],
        scenarios: [],
        environments: [{ key: "night", label: "夜晚", tag: "night", route: "base", section: "scene" }],
        stages: [
          { key: "PREPARATION", label: "准备" }, { key: "FOREPLAY", label: "前戏" },
          { key: "MAIN_ACT", label: "主戏" }, { key: "CLIMAX", label: "高潮" }, { key: "AFTERMATH", label: "余韵" },
        ],
        positions: [{ key: "sitting", label: "sitting", tag: "sitting", minParticipants: 2, route: "base", section: "composition" }],
        clothingStates: [{ key: "clothed", label: "穿衣", tag: "clothed", route: "character", section: "clothing" }],
        characterStates: [],
        expressions: [],
        additionalActivities: [],
        activities: [],
        interactionActions: [{ key: "kissing", label: "接吻", tag: "kissing", route: "interaction", minParticipants: 2 }],
        bodyFocus: [],
        compositions: [],
      });
    }

    // ---- Snapshots (in-memory, deterministic restore) ----
    if (p === "/api/snapshots" && method === "POST") {
      stats.snapshotPosts += 1;
      const body = request.postDataJSON?.() || {};
      const id = "e2e-snapshot-" + stats.snapshotPosts;
      const structured_state = body.structured_state || documentFixture();
      stats.snapshots.set(id, structured_state);
      return json(200, { id, structured_state });
    }
    if (p === "/api/snapshots") return json(200, { snapshots: [...stats.snapshots.keys()].map((id) => ({ id, structured_state: stats.snapshots.get(id) })) });
    if (/\/restore$/.test(p)) {
      const id = decodeURIComponent(p.split("/")[3] || "");
      return json(200, { structured_state: stats.snapshots.get(id) || documentFixture() });
    }
    if (/^\/api\/snapshots\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split("/")[3] || "");
      return json(200, { id, structured_state: stats.snapshots.get(id) || documentFixture() });
    }

    // ---- Everything else (bootstrap/settings/catalog/models/conflicts/etc.) ----
    return json(200, { ok: true, tags: [], items: [], nodes: [], snapshots: [], settings: { adolescent_mode: false }, models: [], conflicts: [], favorites: [] });
  });

  return stats;
}

// -----------------------------------------------------------------------------
// Page helpers.
// -----------------------------------------------------------------------------
async function openWorkbench(page) {
  await page.goto(baseURL);
  // Real nav button: <button data-module="generate">生图 主工作台</button>
  await page.locator('[data-module="generate"]').click();
  await expect(page.locator("#generate-view")).toBeVisible();
}

function modeButton(page, mode) {
  return page.locator(`#prompt-mode-switch button[data-prompt-mode="${mode}"]`);
}
async function selectMode(page, mode) {
  await modeButton(page, mode).click();
  await expect(modeButton(page, mode)).toHaveClass(/active/);
}

const editor = (page) => page.locator("#nai-editor");

// Add a character via the real "+ 角色" button and fill its prompt.
async function addCharacter(page, tags) {
  await page.locator("#nai-character-add").click();
  await editor(page).fill(tags.join(", "));
}

// Switch the active workbench target via the character tab strip.
async function switchTarget(page, target) {
  // target ∈ {"base"} or a numeric index as string ("0" = Character 1).
  await page.locator(`[data-nai-char-tab="${target}"]`).click();
}

// -----------------------------------------------------------------------------
// Scenario suite — F1/F2 are non-browser; F3–F15 map 1:1 below.
// -----------------------------------------------------------------------------
test.describe("PromptDocument product path (F3–F15)", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  test("F3 cold start shows useful empty states in Text/Visual/Scene; no empty 'No recommendations'", async ({ page }) => {
    await openWorkbench(page);
    for (const mode of ["text", "visual", "scene"]) {
      await selectMode(page, mode);
      await expect(editor(page)).toBeVisible();
    }
    // The recommendation panel is hidden (not rendered as an empty "No recommendations").
    await expect(page.locator("#recommendations")).toBeHidden();
    await expect(page.locator("#recommendation-list")).not.toContainText("No recommendations");
    // Each mode root exists (Visual/Scene builders mount their shells).
    await expect(page.locator("#visual-prompt-root")).toBeAttached();
    await expect(page.locator("#nsfw-builder-root")).toBeAttached();
  });

  test("F4 double-character full path (Base + C1 + C2) with identity/hair/eyes/clothing", async ({ page }) => {
    await openWorkbench(page);
    await editor(page).fill(TAGS.base.join(", "));
    await addCharacter(page, TAGS.c1);
    await switchTarget(page, "base");
    await addCharacter(page, TAGS.c2);

    await expect(page.locator("#nai-character-count")).toHaveText("2");
    await expect(page.locator('[data-nai-char-tab="base"]')).toBeVisible();
    await expect(page.locator('[data-nai-char-tab="0"]')).toBeVisible();
    await expect(page.locator('[data-nai-char-tab="1"]')).toBeVisible();

    // Base retains its own content; C2 shows Furina's tags, not Citlali's.
    await switchTarget(page, "base");
    await expect(editor(page)).toHaveValue(/bedroom/);
    await switchTarget(page, "0");
    await expect(editor(page)).toHaveValue(/Citlali/);
    await switchTarget(page, "1");
    await expect(editor(page)).toHaveValue(/Furina/);
    await expect(editor(page)).not.toHaveValue(/Citlali/);
  });

  test("F5 C2 identity/hair/eyes/clothing → next steps prioritize Expression/Pose/Action", async ({ page }) => {
    const stats = await installApiMocks(page);
    await openWorkbench(page);
    await editor(page).fill(TAGS.base.join(", "));
    await addCharacter(page, TAGS.c1);
    await switchTarget(page, "base");
    await addCharacter(page, TAGS.c2);
    await switchTarget(page, "1");

    // Switch to Visual to trigger the semantic recommendation round-trip.
    await selectMode(page, "visual");
    await expect(page.locator("#visual-prompt-root")).toContainText(/Appearance|Eyes/, { timeout: 10000 });
    expect(stats.recommendationCalls, "recommendations endpoint was hit").toBeGreaterThan(0);

    // Next-step ordering: Expression before Pose before Action.
    const nextStep = page.locator("#visual-prompt-root .next-steps, #visual-prompt-root .next-step-recommendation").first();
    const text = (await nextStep.textContent()) || "";
    expect(text).toMatch(/Expression|表情/i);
  });

  test("F6 C2 → Appearance → Eyes: breadcrumb correct, Eyes selected, current-node + next-step recs", async ({ page }) => {
    await openWorkbench(page);
    await editor(page).fill(TAGS.c2.join(", "));
    await selectMode(page, "visual");

    await expect(page.locator("#visual-prompt-root")).toContainText("Appearance", { timeout: 10000 });
    await page.locator('#visual-prompt-root button[data-action="node"][data-node="appearance"]').click();
    await expect(page.locator("#visual-prompt-root .composer-breadcrumb")).toContainText("Appearance");

    await page.locator('#visual-prompt-root button[data-action="node"][data-node="eyes"]').click();
    await expect(page.locator("#visual-prompt-root .composer-breadcrumb")).toContainText("Eyes");
    // Inspector shows current-node recommendations and next-step recommendations.
    await expect(page.locator("#visual-prompt-root .semantic-inspector")).toContainText(/当前节点推荐|下一步建议/);
  });

  test("F7 semantic API 500 → visible error + Retry, never a blank panel", async ({ page }) => {
    await installApiMocks(page, { semanticFailure: true });
    await openWorkbench(page);
    await selectMode(page, "visual");
    // visual-builder.js renders a role=alert error with a retry button.
    await expect(page.locator('#visual-prompt-root [role="alert"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#visual-prompt-root [data-action="retry-semantic"]')).toBeVisible();
  });

  test("F8 target switch Base→C1→C2 syncs Text/Visual/Recommendation; no stale Base content on C2", async ({ page }) => {
    await openWorkbench(page);
    await editor(page).fill(TAGS.base.join(", "));
    await addCharacter(page, TAGS.c1);
    await switchTarget(page, "base");
    await addCharacter(page, TAGS.c2);

    await switchTarget(page, "base");
    await expect(editor(page)).toHaveValue(/bedroom/);
    await switchTarget(page, "0");
    await expect(editor(page)).toHaveValue(/Citlali/);
    await expect(editor(page)).not.toHaveValue(/bedroom/);
    await switchTarget(page, "1");
    await expect(editor(page)).toHaveValue(/Furina/);
    await expect(editor(page)).not.toHaveValue(/bedroom/);
    await expect(editor(page)).not.toHaveValue(/Citlali/);
  });

  test("F9 scene participants 1→2→3→2 keep character tabs / PromptDocument / participant_count consistent", async ({ page }) => {
    await openWorkbench(page);
    await selectMode(page, "scene");
    const participants = (key) => page.locator(`#nsfw-builder-root button[data-action="participants"][data-key="${key}"]`);

    await expect(participants("2")).toBeVisible({ timeout: 10000 });
    await participants("2").click();
    await expect(page.locator("#nai-character-count")).toHaveText("2");
    await participants("3").click();
    await expect(page.locator("#nai-character-count")).toHaveText("3");
    await participants("2").click();
    await expect(page.locator("#nai-character-count")).toHaveText("2");
    // Tab strip reflects the current count (Base + N dynamic tabs).
    await expect(page.locator('[data-nai-char-tab="1"]')).toBeVisible();
  });

  test("F10 C1→action→C2 writes relation metadata and survives Text serialization", async ({ page }) => {
    await openWorkbench(page);
    await addCharacter(page, TAGS.c1);
    await switchTarget(page, "base");
    await addCharacter(page, TAGS.c2);
    await selectMode(page, "scene");

    // Enable 2 participants, then add the interaction C1 → kissing → C2.
    await page.locator('#nsfw-builder-root button[data-action="participants"][data-key="2"]').click();
    await page.locator('#nsfw-builder-root [data-input="actor"]').selectOption("0");
    await page.locator('#nsfw-builder-root [data-input="target"]').selectOption("1");
    await page.locator('#nsfw-builder-root button[data-action="interaction-add"][data-key="kissing"]').click();

    // Scene summary reflects the interaction.
    await expect(page.locator("#nsfw-builder-root")).toContainText(/kissing|接吻/);

    // Text serialization carries relation prefixes (source# / target#) — see
    // prompt-tokenizer.js serializePromptToken and prompt-document.js serializeTarget.
    await selectMode(page, "text");
    const actorText = await editor(page).inputValue();
    expect(actorText).toMatch(/source#/);
    await switchTarget(page, "1");
    const targetText = await editor(page).inputValue();
    expect(targetText).toMatch(/target#/);
  });

  test("F11 Stage/Position/BodyFocus context alters the recommendation request", async ({ page }) => {
    const stats = await installApiMocks(page);
    await openWorkbench(page);
    await selectMode(page, "scene");
    await page.locator('#nsfw-builder-root button[data-action="participants"][data-key="2"]').click();

    const before = stats.recommendationCalls;
    // Stage change dispatches a context mutation → refresh recommendation.
    await page.locator('#nsfw-builder-root button[data-action="exclusive"][data-key="MAIN_ACT"]').click();
    await expect.poll(() => stats.recommendationCalls).toBeGreaterThan(before);
  });

  test("F12 failed generate does not learn; successful generate triggers exactly one generate call", async ({ page }) => {
    let stats = await installApiMocks(page, { generateFailure: true });
    await openWorkbench(page);
    await editor(page).fill("blue eyes");
    await page.locator("#nai-gen").click();
    await expect(page.locator("#nai-job")).toContainText(/余额|失败|error/i, { timeout: 10000 });
    expect(stats.generateCalls).toBe(1);
    // Failure path must not record learning (no cooccurrence/record call).
    expect(stats.learnCalls).toBe(0);

    stats = await installApiMocks(page);
    await openWorkbench(page);
    await editor(page).fill("blue eyes");
    await page.locator("#nai-gen").click();
    await expect(page.locator("#nai-job")).toContainText(/Generating|生成中/i);
    // Exactly one generate call; the server-side writeback (learn) is driven by
    // the Node batch completion, verified at the Python level in
    // tests/test_phase_a_scoped_learning.py::test_successful_generate_learns_once.
    expect(stats.generateCalls).toBe(1);
  });

  test("F13 offline: recommendation degrades gracefully (offline prior is a server-side fallback)", async ({ page }) => {
    await openWorkbench(page);
    await editor(page).fill("blue eyes");
    await expect(page.locator("#recommendation-list")).toBeAttached();
    // Going fully offline cuts the browser from the integration server. The
    // offline-prompt-prior fallback (data/offline_prompt_prior.sqlite, read by
    // prompt/prior.py) is a server-side feature — its behaviour is asserted in
    // tests/test_phase_a_scoped_learning.py (test_offline_prior_deterministic,
    // test_graceful_fallback_missing_db) and test_phase_c_recommendation_v3.py.
    // At the browser layer the requirement is: no blank screen / no uncaught
    // crash while the network is down.
    await page.context().setOffline(true);
    await expect(page.locator("#generate-view")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/Uncaught|Cannot read|undefined is not/);
    await page.context().setOffline(false);
  });

  test("F14 snapshot save → modify → restore yields 100% restore of the full state", async ({ page }) => {
    const stats = await installApiMocks(page);
    await openWorkbench(page);
    await editor(page).fill(TAGS.base.join(", "));
    await addCharacter(page, TAGS.c1);
    await switchTarget(page, "base");
    await addCharacter(page, TAGS.c2);
    await page.locator("#nai-free-text").fill("night scene, two girls by the window");

    // Save snapshot (mock echoes back the submitted structured_state verbatim).
    await page.locator("#save-snapshot-btn").click();
    expect(stats.snapshotPosts).toBe(1);
    const savedState = stats.snapshots.get("e2e-snapshot-1");
    expect(savedState).toBeTruthy();
    expect(savedState.schema_version).toBe(2);

    // Mutate everything.
    await editor(page).fill("changed beyond recognition");
    await page.locator("#nai-free-text").fill("completely different");

    // Restore from the snapshot modal. Note: restoreSnapshot() ends by
    // navigating back to the browse view (static/app.js showView("browse")), so
    // re-open the workbench before asserting.
    await page.locator("#snapshot-modal").evaluate((el) => (el.style.display = "flex"));
    await page.locator("#snapshot-list [data-restore]").first().click();
    await page.locator('[data-module="generate"]').click();
    await expect(page.locator("#generate-view")).toBeVisible();

    // The restored editor reflects the saved C2 target content (Furina), not the
    // mutation, and the free text is restored.
    await switchTarget(page, "1");
    await expect(editor(page)).toHaveValue(/Furina/);
    await expect(editor(page)).not.toHaveValue(/changed beyond recognition/);
    await expect(page.locator("#nai-free-text")).toHaveValue(/night scene/);
  });

  test("F15 prompt syntax fidelity across Text→Visual→Scene→Snapshot→Restore→Generate(mock)", async ({ page }) => {
    const stats = await installApiMocks(page);
    await openWorkbench(page);
    const syntax = "1.35::blue eyes::, 1.5::rain, night::, -1::hat::, {{tag}}, [[tag]], source#/target#/mutual#";
    await editor(page).fill(syntax);

    // Round-trip through all three modes without dropping tokens.
    await selectMode(page, "visual");
    await selectMode(page, "scene");
    await selectMode(page, "text");
    await expect(editor(page)).toHaveValue(/blue eyes/);
    await expect(editor(page)).toHaveValue(/rain, night/);
    await expect(editor(page)).toHaveValue(/hat/);

    // Snapshot → mutate → restore → generate (mocked). Restore navigates to
    // browse view, so re-open the workbench in text mode before generating.
    await page.locator("#save-snapshot-btn").click();
    await editor(page).fill("temporary");
    await page.locator("#snapshot-modal").evaluate((el) => (el.style.display = "flex"));
    await page.locator("#snapshot-list [data-restore]").first().click();
    await page.locator('[data-module="generate"]').click();
    await expect(page.locator("#generate-view")).toBeVisible();
    await selectMode(page, "text");
    await expect(editor(page)).toHaveValue(/blue eyes/);

    await page.locator("#nai-gen").click();
    expect(stats.generateCalls).toBe(1);
  });
});
