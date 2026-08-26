import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationRecipe, normalizeGenerationRequest, requestForSeed } from "./generation-request.mjs";

test("normalizes a V5 text generation request", () => {
  const request = normalizeGenerationRequest({
    mode: "txt2img",
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-curated", width: 833, height: 1215, steps: 30, guidance: 4.5, seed: 42, seed_mode: "fixed" },
    count: 3,
  });
  assert.equal(request.settings.width, 832);
  assert.equal(request.settings.height, 1216);
  assert.equal(request.settings.seed, 42);
  assert.equal(request.count, 3);
});

test("keeps characters structured and supports automatic positions", () => {
  const request = normalizeGenerationRequest({
    prompt: "2girls",
    characters: [
      { prompt: "girl, red hair", negative_prompt: "blue hair", position: "auto" },
      { prompt: "girl, blue hair", uc: "red hair", position: { x: 0.8, y: 0.4 } },
    ],
  });
  assert.equal(request.prompt, "2girls");
  assert.equal(request.characters.length, 2);
  assert.equal(request.characters[0].position, null);
  assert.deepEqual(request.characters[1].position, { x: 0.8, y: 0.4 });
});

test("normalizes img2img without storing base64 in the recipe", () => {
  const request = normalizeGenerationRequest({
    mode: "img2img",
    prompt: "watercolor",
    img2img: { source_image: "data:image/png;base64,AAAA", source_image_path: "data/gallery/base.jpg", strength: 0.45, noise: 0.12 },
  });
  const recipe = createGenerationRecipe(request, 123);
  assert.equal(request.img2img.source_image, "data:image/png;base64,AAAA");
  assert.equal(recipe.img2img.source_image_path, "data/gallery/base.jpg");
  assert.equal("source_image" in recipe.img2img, false);
  assert.equal(recipe.settings.seed, 123);
});

test("rejects active references and invalid fixed seeds", () => {
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", references: [{ type: "vibe" }] }), /仅预留接口/);
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", settings: { seed_mode: "fixed" } }), /Seed 需为 0~4294967295/);
});

test("normalizes legacy model ids and rejects unsupported ones", () => {
  const normalized = normalizeGenerationRequest({
    prompt: "1girl",
    settings: { model: "nai-diffusion-v5-full", width: 832, height: 1216 },
  });
  assert.equal(normalized.settings.model, "nai-diffusion-5-full");
  assert.throws(() => normalizeGenerationRequest({
    prompt: "1girl",
    settings: { model: "nai-diffusion-unknown", width: 832, height: 1216 },
  }), /不支持的模型/);
});

test("rejects unsupported sampler", () => {
  assert.throws(() => normalizeGenerationRequest({
    prompt: "1girl",
    settings: { sampler: "unknown-sampler", width: 832, height: 1216 },
  }), /不支持的采样器/);
});

test("creates a one-image request for a concrete seed", () => {
  const request = normalizeGenerationRequest({ prompt: "x", count: 4 });
  const one = requestForSeed(request, 99);
  assert.equal(one.count, 1);
  assert.equal(one.settings.seed, 99);
  assert.equal(request.count, 4);
});

test("maps official resolution categories and permits a local serial batch", () => {
  const small = normalizeGenerationRequest({ prompt: "x", resolution_category: "small_portrait", count: 6 });
  assert.deepEqual([small.settings.width, small.settings.height], [512, 768]);
  assert.equal(small.count, 6);
  const normal = normalizeGenerationRequest({ prompt: "x", resolution_category: "normal_portrait", count: 4 });
  assert.deepEqual([normal.settings.width, normal.settings.height], [832, 1216]);
  assert.equal(normalizeGenerationRequest({ prompt: "x", resolution_category: "normal_portrait", count: 100 }).count, 100);
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", resolution_category: "normal_portrait", count: 101 }), /1-100/);
  const custom = normalizeGenerationRequest({ prompt: "x", settings: { width: 512, height: 512 }, count: 6 });
  assert.equal(custom.count, 6);
});

test("keeps snapshot_id through normalization, one-image requests and recipes", () => {
  const request = normalizeGenerationRequest({ prompt: "x", snapshot_id: "snapshot-123", count: 2 });
  const one = requestForSeed(request, 99);
  const recipe = createGenerationRecipe(one);
  assert.equal(request.snapshot_id, "snapshot-123");
  assert.equal(one.snapshot_id, "snapshot-123");
  assert.equal(recipe.snapshot_id, "snapshot-123");
});

test("keeps the quality toggle through normalization and recipes", () => {
  const request = normalizeGenerationRequest({ prompt: "x", quality_toggle: false });
  const one = requestForSeed(request, 99);
  const recipe = createGenerationRecipe(one);
  assert.equal(request.quality_toggle, false);
  assert.equal(one.quality_toggle, false);
  assert.equal(recipe.quality_toggle, false);
});

test("normalizes and passes through uc_preset (off/light/heavy/furry_focus/human_focus)", () => {
  for (const value of ["off", "light", "heavy", "furry_focus", "human_focus"]) {
    const request = normalizeGenerationRequest({ prompt: "x", uc_preset: value });
    assert.equal(request.uc_preset, value, `normalized uc_preset must be ${value}`);
    const one = requestForSeed(request, 99);
    const recipe = createGenerationRecipe(one);
    assert.equal(one.uc_preset, value);
    assert.equal(recipe.uc_preset, value);
  }
});

test("defaults uc_preset to heavy for legacy requests without the field", () => {
  const request = normalizeGenerationRequest({ prompt: "x" });
  assert.equal(request.uc_preset, "heavy");
});

test("rejects an unknown uc_preset in normalization", () => {
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", uc_preset: "ultra" }), /不支持的 UC preset/);
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", uc_preset: "ultra" }), /off \/ light \/ heavy \/ furry_focus \/ human_focus/);
});

test("normalizes cfg_rescale and auto_smea through request settings", () => {
  const request = normalizeGenerationRequest({
    prompt: "x",
    settings: { cfg_rescale: 0.7, auto_smea: true },
  });
  assert.equal(request.settings.cfg_rescale, 0.7);
  assert.equal(request.settings.auto_smea, true);
  // 默认值：cfg_rescale 0、auto_smea false
  const defaults = normalizeGenerationRequest({ prompt: "x" });
  assert.equal(defaults.settings.cfg_rescale, 0);
  assert.equal(defaults.settings.auto_smea, false);
  // cfg_rescale 越界 clamp 到 [0, 1]
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { cfg_rescale: 5 } }).settings.cfg_rescale, 1);
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { cfg_rescale: -1 } }).settings.cfg_rescale, 0);
  // 字符串布尔被正确解析
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { auto_smea: "true" } }).settings.auto_smea, true);
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { auto_smea: "false" } }).settings.auto_smea, false);
});

test("rejects increment mode when seed + count - 1 exceeds the 32-bit seed ceiling", () => {
  assert.throws(
    () => normalizeGenerationRequest({ prompt: "x", settings: { seed_mode: "increment", seed: 4294967295 }, count: 2 }),
    /4294967295/,
  );
  // 边界：seed + count - 1 == 4294967295 允许
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { seed_mode: "increment", seed: 4294967295 }, count: 1 }).count, 1);
  assert.equal(normalizeGenerationRequest({ prompt: "x", settings: { seed_mode: "increment", seed: 4294967294 }, count: 2 }).count, 2);
});

test("normalizes quality_preset through seed requests and recipes", () => {
  for (const value of ["off", "standard", "light"]) {
    const request = normalizeGenerationRequest({ prompt: "x", quality_preset: value });
    const one = requestForSeed(request, 99);
    const recipe = createGenerationRecipe(one);
    assert.equal(request.quality_preset, value);
    assert.equal(one.quality_preset, value);
    assert.equal(recipe.quality_preset, value);
  }
  assert.equal(normalizeGenerationRequest({ prompt: "x" }).quality_preset, "standard");
  assert.throws(() => normalizeGenerationRequest({ prompt: "x", quality_preset: "ultra" }), /不支持的 Quality preset/);
});
