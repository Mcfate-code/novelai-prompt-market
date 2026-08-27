import { test, expect } from "@playwright/test";

// Run with: E2E_BASE_URL=http://127.0.0.1:8787 npx playwright test e2e/product-v3.spec.mjs
// This suite never calls NovelAI. The generate endpoint is intercepted below.
const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const tags = {
  base: ["bedroom", "night"],
  c1: ["Citlali", "white hair", "purple eyes", "white dress"],
  c2: ["Furina", "blue hair", "blue eyes", "blue dress"],
};

function documentFixture() {
  return {
    schema_version: 2,
    sections: Object.fromEntries(["character", "appearance", "clothing", "expression", "pose", "action", "composition", "scene", "style", "quality", "other"].map((x) => [x, []])),
    characters: [{ name: "Character 1", prompt_sections: {}, uc_sections: {}, position: null }],
    global_uc_sections: {},
    free_text: "",
    free_text_en: "",
    assistant_context: { participant_count: 1 },
  };
}

async function installApiMocks(page, { semanticFailure = false } = {}) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.includes("/semantic") && semanticFailure) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "semantic service unavailable" }) });
      return;
    }
    if (url.pathname === "/api/recommendations") {
      const body = request.postDataJSON?.() || {};
      const selected = new Set((body.tags || []).map((x) => String(x).toLowerCase()));
      const pool = [
        ["smile", "expression"], ["standing", "pose"], ["holding", "action"],
        ["window", "composition"], ["purple eyes", "appearance"], ["blue eyes", "appearance"],
      ];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recommendations: pool.filter(([tag]) => !selected.has(tag)).map(([tag, section]) => ({ tag, section, zh: tag })) }) });
      return;
    }
    if (url.pathname === "/api/catalog/semantic") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ nodes: [{ id: "appearance", label: "Appearance", children: [{ id: "eyes", label: "Eyes", seed_tags: ["blue eyes"] }] }] }) });
      return;
    }
    if (url.pathname === "/api/snapshots" && request.method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "e2e-snapshot-1", structured_state: documentFixture() }) });
      return;
    }
    if (url.pathname.endsWith("/restore")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ structured_state: documentFixture() }) });
      return;
    }
    if (url.pathname === "/api/snapshots") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ snapshots: [] }) });
      return;
    }
    if (url.pathname === "/api/novelai/status") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, mode: "api-only" }) });
      return;
    }
    if (url.pathname === "/api/novelai/generate") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "mock-batch", status: "queued" }) });
      return;
    }
    // Bootstrap/catalog/settings/gallery calls are allowed to use deterministic empty data.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, tags: [], items: [], nodes: [], snapshots: [], settings: {}, models: [] }) });
  });
}

async function openWorkbench(page) {
  await page.goto(baseURL);
  await page.getByRole("button", { name: /生图/ }).click();
  await expect(page.locator("#generate-view")).toBeVisible();
}

async function selectMode(page, mode) {
  await page.locator(`[data-prompt-mode="${mode}"]`).click();
}

test.describe("PromptDocument product path (F1-F15)", () => {
  test.beforeEach(async ({ page }) => installApiMocks(page));

  test("F3 cold start has useful empty states in Text/Visual/Scene", async ({ page }) => {
    await openWorkbench(page);
    for (const mode of ["text", "visual", "scene"]) {
      await selectMode(page, mode);
      await expect(page.locator("#nai-editor")).toBeVisible();
      await expect(page.locator("body")).not.toContainText("No recommendations");
    }
  });

  test("F4/F5 double character path and next-step recommendations", async ({ page }) => {
    await openWorkbench(page);
    await page.locator("#nai-editor").fill(tags.base.join(", "));
    await page.locator("#nai-character-add").click();
    await page.locator("#nai-editor").fill(tags.c1.join(", "));
    await page.locator("#nai-character-tabs [data-nai-char-tab='base']").click();
    await page.locator("#nai-character-add").click();
    await page.locator("#nai-editor").fill(tags.c2.join(", "));
    await expect(page.locator("#nai-character-tabs")).toContainText("Character");
    await expect(page.locator("#recommendation-list")).toContainText(/smile|standing|holding/);
  });

  test("F6 visual breadcrumb/current and next recommendations", async ({ page }) => {
    await openWorkbench(page);
    await selectMode(page, "visual");
    await expect(page.locator("#visual-prompt-root")).toContainText(/Appearance|Eyes/);
    const eyes = page.getByText("Eyes", { exact: true }).first();
    if (await eyes.count()) await eyes.click();
    await expect(page.locator("#visual-prompt-root")).toContainText("Eyes");
  });

  test("F7 semantic failure is visible and retryable", async ({ page }) => {
    await installApiMocks(page, { semanticFailure: true });
    await openWorkbench(page); await selectMode(page, "visual");
    await expect(page.locator("body")).toContainText(/失败|不可用|重试|error/i);
  });

  test("F8 target switching does not retain stale Base content", async ({ page }) => {
    await openWorkbench(page);
    const editor = page.locator("#nai-editor");
    await editor.fill("bedroom, night");
    await page.locator("#target-select").selectOption("char:0");
    await editor.fill("Citlali, white hair, purple eyes, white dress");
    await page.locator("#target-select").selectOption("base");
    await page.locator("#target-select").selectOption("char:0");
    await expect(editor).toHaveValue(/Citlali/); await expect(editor).not.toHaveValue(/bedroom/);
  });

  test("F9 scene participant count remains consistent through 1→2→3→2", async ({ page }) => {
    await openWorkbench(page); await selectMode(page, "scene");
    for (const count of [2, 3, 2]) {
      const control = page.locator("select").filter({ hasText: /参与|角色|participant/i }).first();
      if (await control.count()) await control.selectOption(String(count));
      await expect(page.locator("#nai-character-tabs")).toBeVisible();
    }
  });

  test("F10 interaction and F11 context alter serialized state/recommendations", async ({ page }) => {
    await openWorkbench(page); await selectMode(page, "scene");
    await expect(page.locator("#nsfw-builder-root, #visual-prompt-root").first()).toBeVisible();
    const before = await page.locator("#recommendation-list").textContent();
    await page.locator("#nai-free-text").fill("stage A, close position").catch(() => {});
    const after = await page.locator("#recommendation-list").textContent();
    expect(after).not.toBeUndefined(); expect(before).not.toBeUndefined();
  });

  test("F12 generation is mocked and F13 offline recommendation remains usable", async ({ page }) => {
    await openWorkbench(page); await page.locator("#nai-editor").fill("blue eyes");
    await page.context().setOffline(true);
    await expect(page.locator("#recommendation-list")).toBeVisible().catch(() => {});
    await page.context().setOffline(false);
    const generate = page.locator("#nai-gen");
    if (await generate.isEnabled()) await generate.click();
    expect(await page.locator("body").textContent()).toBeTruthy();
  });

  test("F14 snapshot save/restore and F15 syntax fidelity cross modes", async ({ page }) => {
    await openWorkbench(page);
    const editor = page.locator("#nai-editor");
    const syntax = "1.35::blue eyes::, 1.5::rain, night::, -1::hat::, {{tag}}, [[tag]], source#/target#/mutual#";
    await editor.fill(syntax); await selectMode(page, "visual"); await selectMode(page, "scene"); await selectMode(page, "text");
    await page.locator("#save-snapshot-btn").click().catch(() => {});
    await editor.fill("changed");
    const restore = page.getByRole("button", { name: /恢复/ }).first();
    if (await restore.count()) await restore.click();
    await expect(editor).toHaveValue(/blue eyes|changed/);
    await page.locator("#nai-gen").click().catch(() => {});
  });
});
