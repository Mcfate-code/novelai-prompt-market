// Limited serial NovelAI API runner. count is local-only and every provider call
// always generates exactly one image.
import { randomUUID } from "node:crypto";
import { createGenerationRecipe, normalizeGenerationRequest, requestForSeed } from "./generation-request.mjs";

function makeSeed(mode, seed, index) {
  if (mode === "fixed") return Number(seed);
  if (mode === "increment") return Number(seed) + index;
  return Math.floor(Math.random() * 1_000_000_000);
}

export class ApiBatchController {
  constructor({ provider, saveImage, onEvent = () => {}, createBatch = () => null, updateBatch = () => {}, getBatch = () => null, getMaxCount = () => 6 }) {
    this.provider = provider;
    this.saveImage = saveImage;
    this.onEvent = onEvent;
    this.createBatch = createBatch;
    this.updateBatch = updateBatch;
    this.getBatch = getBatch;
    this.getMaxCount = getMaxCount;
    this.running = false;
    this.current = null;
  }

  validateCount(count) {
    const n = Number(count);
    const configuredMax = Number(this.getMaxCount());
    const maxCount = Number.isInteger(configuredMax) ? Math.max(1, Math.min(6, configuredMax)) : 6;
    if (!Number.isInteger(n) || n < 1 || n > maxCount) throw new Error(`生成数量必须是 1-${maxCount}`);
    return n;
  }

  validateGeneration(generation) {
    return normalizeGenerationRequest({ ...generation, count: generation.count || 1 });
  }

  async run({ generation, count = null, name = "" }) {
    if (this.running) throw new Error("已有 API 生图批次在运行（单并发）");
    const request = normalizeGenerationRequest({ ...generation, count: count ?? generation.count ?? 1 });
    request.meta = generation?.meta ?? null;
    const total = this.validateCount(request.count);
    const seedMode = request.settings.seed_mode;
    const batchId = randomUUID();
    this.running = true;
    this.current = { batchId, total, completed: 0, failed: 0, cancelled: false, results: [], name, generation: request, status: "running" };
    this.createBatch({
      id: batchId,
      name,
      config_json: JSON.stringify(request),
      total,
    });
    this.updateBatch(batchId, { status: "running" });
    this.emit({ type: "api-batch.update", batchId, status: "running", total, completed: 0, current: 0 });
    try {
      for (let index = 0; index < total; index++) {
        if (this.current.cancelled) break;
        const seed = makeSeed(seedMode, request.settings.seed, index);
        const one = requestForSeed(request, seed);
        this.emit({ type: "api-batch.update", batchId, status: "running", total, completed: index, current: index + 1, seed });
        try {
          const result = await this.provider.generateOne(one);
          const recipe = createGenerationRecipe(one, seed);
          const saved = [];
          for (const image of result.images) {
            const item = await this.saveImage(image, {
              prompt: one.prompt,
              negative_prompt: one.negative_prompt,
              snapshot_id: one.snapshot_id ?? null,
              recipe,
              batch_id: batchId,
              batch_index: index + 1,
              batch_total: total,
              correlation_id: result.correlationId,
              parameters_json: request.meta ? JSON.stringify(request.meta) : null,
            });
            saved.push(item);
          }
          this.current.completed += 1;
          this.current.results.push(...saved);
          this.updateBatch(batchId, { status: "running", done: this.current.completed, succeeded: this.current.completed, failed: 0 });
          this.emit({ type: "api-batch.image", batchId, status: "saved", total, completed: this.current.completed, current: index + 1, items: saved, correlation_id: result.correlationId });
          this.emit({ type: "api-batch.update", batchId, status: "running", total, completed: this.current.completed, current: index + 1 });
        } catch (error) {
          this.current.failed = 1;
          this.current.status = "failed";
          this.current.error = error.message;
          this.current.code = error.code;
          this.current.correlationId = error.correlationId;
          this.updateBatch(batchId, {
            status: "failed", done: this.current.completed, succeeded: this.current.completed, failed: 1,
            error_code: error.code, error_message: error.message, correlation_id: error.correlationId,
            finished_at: Date.now(),
          });
          this.emit({ type: "api-batch.update", batchId, status: "failed", total, completed: this.current.completed, current: index + 1, error: error.message, code: error.code, assetId: error.assetId, gallerySync: error.code === "GALLERY_SYNC_FAILED" ? "failed" : undefined, correlation_id: error.correlationId });
          return { ...this.current, status: "failed", error: error.message, code: error.code, correlationId: error.correlationId, assetId: error.assetId };
        }
      }
      const status = this.current.cancelled ? "cancelled" : "completed";
      this.current.status = status;
      this.updateBatch(batchId, { status, done: this.current.completed, succeeded: this.current.completed, failed: this.current.failed, finished_at: Date.now() });
      this.emit({ type: "api-batch.update", batchId, status, total, completed: this.current.completed, results: this.current.results });
      return { ...this.current, status };
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  emit(event) {
    try { this.onEvent(event); } catch (error) { console.error("API 批次事件推送失败:", error.message); }
  }

  cancel(batchId) {
    if (!this.current || (batchId && this.current.batchId !== batchId)) return false;
    this.current.cancelled = true;
    this.current.status = "cancelling";
    this.emit({ type: "api-batch.update", batchId: this.current.batchId, status: "cancelling", total: this.current.total, completed: this.current.completed });
    return true;
  }

  status(batchId) {
    if (this.current?.batchId === batchId) return { ...this.current };
    const stored = this.getBatch(batchId);
    if (!stored) return null;
    let config = null;
    try { config = stored.config_json ? JSON.parse(stored.config_json) : null; } catch {}
    return { ...stored, config };
  }
}
