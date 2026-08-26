import assert from "node:assert/strict";
import test from "node:test";
import { ApiBatchController } from "./api-batch.mjs";

function request(count = 3) {
  return {
    mode: "txt2img",
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full", sampler: "k_euler_ancestral", steps: 28, guidance: 5, seed: 10, seed_mode: "increment", width: 832, height: 1216 },
    characters: [],
    references: [],
    count,
  };
}

test("runs requests strictly in sequence and stores a recipe per image", async () => {
  const calls = [];
  const saved = [];
  let active = 0;
  let maxActive = 0;
  const runner = new ApiBatchController({
    provider: { generateOne: async (one) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(one.settings.seed);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { images: [{ base64: "AAAA" }], correlationId: `c${calls.length}` };
    } },
    saveImage: async (_image, meta) => { saved.push(meta); return { id: saved.length }; },
  });
  const result = await runner.run({ generation: request(3) });
  assert.equal(result.status, "completed");
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [10, 11, 12]);
  assert.deepEqual(saved.map((item) => item.recipe.settings.seed), [10, 11, 12]);
});

test("enforces the configured local batch ceiling (hard-capped at 6)", () => {
  const runner = new ApiBatchController({
    provider: { generateOne: async () => ({ images: [], correlationId: "unused" }) },
    saveImage: async () => ({}),
    getMaxCount: () => 12, // 配置即使超过 6，也被硬钳制到 6
  });
  assert.equal(runner.validateCount(6), 6);
  assert.throws(() => runner.validateCount(7), /1-6/);
  assert.throws(() => runner.validateCount(12), /1-6/, "配置上限 12 也会被钳制到 6");
});

test("cancel stops requests after the current image", async () => {
  let calls = 0;
  let runner;
  runner = new ApiBatchController({
    provider: { generateOne: async () => {
      calls += 1;
      if (calls === 1) runner.cancel(runner.current.batchId);
      return { images: [{ base64: "AAAA" }], correlationId: "c" };
    } },
    saveImage: async () => ({ id: "x" }),
  });
  const result = await runner.run({ generation: request(3) });
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(result.completed, 1);
});

test("passes snapshot_id to image metadata", async () => {
  let savedMeta;
  const generation = { ...request(1), snapshot_id: "snapshot-123" };
  const runner = new ApiBatchController({
    provider: { generateOne: async () => ({ images: [{ base64: "AAAA" }], correlationId: "c" }) },
    saveImage: async (_image, meta) => { savedMeta = meta; return { id: "asset-1" }; },
  });
  const result = await runner.run({ generation });
  assert.equal(result.status, "completed");
  assert.equal(result.generation.snapshot_id, "snapshot-123");
  assert.equal(savedMeta.snapshot_id, "snapshot-123");
  assert.equal(savedMeta.recipe.snapshot_id, "snapshot-123");
});

test("persists API error details for failed batches", async () => {
  const updates = [];
  const runner = new ApiBatchController({
    provider: { generateOne: async () => {
      const error = new Error("NovelAI upstream rejected request");
      error.code = "API_ERROR";
      error.correlationId = "ABC123";
      throw error;
    } },
    saveImage: async () => ({ id: "unused" }),
    updateBatch: (_id, patch) => updates.push(patch),
  });
  const result = await runner.run({ generation: request(1) });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "API_ERROR");
  assert.equal(result.correlationId, "ABC123");
  assert.equal(updates.at(-1).error_code, "API_ERROR");
  assert.equal(updates.at(-1).error_message, "NovelAI upstream rejected request");
  assert.equal(updates.at(-1).correlation_id, "ABC123");
});

test("marks the batch failed and stops after gallery sync failure", async () => {
  let providerCalls = 0;
  const updates = [];
  const events = [];
  const runner = new ApiBatchController({
    provider: { generateOne: async () => {
      providerCalls += 1;
      return { images: [{ base64: "AAAA" }], correlationId: "c" };
    } },
    saveImage: async () => {
      const error = new Error("图片已保存，但同步失败");
      error.code = "GALLERY_SYNC_FAILED";
      error.assetId = "asset-kept";
      throw error;
    },
    updateBatch: (_id, patch) => updates.push(patch),
    onEvent: (event) => events.push(event),
  });
  const result = await runner.run({ generation: request(3) });
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 0);
  assert.equal(result.assetId, "asset-kept");
  assert.equal(providerCalls, 1);
  assert.equal(updates.at(-1).status, "failed");
  const failedEvent = events.find((event) => event.status === "failed");
  assert.equal(failedEvent.assetId, "asset-kept");
  assert.equal(failedEvent.gallerySync, "failed");
});
