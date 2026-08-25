// batch.mjs — BatchManager：预设/批量生成执行引擎
// 复用 JobManager 单并发；逐项执行 + 间隔控制 + 失败统计 + 可取消
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BatchManager {
  constructor({ jobManager, store, onEvent }) {
    this.jobs = jobManager;
    this.store = store;
    this.onEvent = onEvent;
    this.running = false;
    this.cancelled = false;
    this.currentBatchId = null;
  }

  get busy() {
    return this.running;
  }

  emit(e) {
    if (this.onEvent) this.onEvent(e);
  }

  // 展开条目：presetId 引用或直接 {prompt, negative_prompt, parameters}
  resolveItems(items) {
    const resolved = [];
    const parseParams = (raw, label) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch {
        throw new Error(`预设参数 JSON 无法解析: ${label}`);
      }
    };
    for (const it of items) {
      if (it.presetId) {
        const p = this.store.getPreset(it.presetId);
        if (!p) throw new Error(`预设不存在: ${it.presetId.slice(0, 8)}`);
        resolved.push({
          prompt: p.prompt,
          negative_prompt: p.negative_prompt || "",
          parameters: parseParams(p.parameters_json, p.name || it.presetId),
        });
      } else if (it.prompt && String(it.prompt).trim()) {
        resolved.push({
          prompt: String(it.prompt).trim(),
          negative_prompt: it.negative_prompt || "",
          parameters: it.parameters || null,
        });
      } else {
        throw new Error("批次条目需含 prompt 或 presetId");
      }
    }
    return resolved;
  }

  async run({ name = "", items, intervalMs = 3000 }) {
    if (this.running) throw new Error("已有批次在运行（单并发）");
    const resolved = this.resolveItems(items);
    if (!resolved.length) throw new Error("批次为空");

    const batchId = this.store.createBatch({
      name, config_json: JSON.stringify({ items: resolved, intervalMs }), total: resolved.length,
    });
    this.running = true;
    this.cancelled = false;
    this.currentBatchId = batchId;
    this.store.updateBatch(batchId, { status: "running" });
    let succeeded = 0, failed = 0;
    this.emit({ type: "batch.update", batchId, status: "running", done: 0, total: resolved.length, succeeded, failed, current: "" });
    try {
      for (let i = 0; i < resolved.length; i++) {
        if (this.cancelled) break;
        const item = resolved[i];
        this.emit({
          type: "batch.update", batchId, status: "running", done: i,
          total: resolved.length, succeeded, failed, current: item.prompt.slice(0, 80),
        });
        try {
          await this.jobs.run({ ...item, kind: "batch" });
          succeeded++;
        } catch (e) {
          failed++;
          this.emit({
            type: "batch.update", batchId, status: "running", done: i + 1,
            total: resolved.length, succeeded, failed, current: item.prompt.slice(0, 80), error: e.message,
          });
        }
        if (i < resolved.length - 1 && !this.cancelled) await sleep(intervalMs);
      }
      let status = "partial";
      if (this.cancelled) status = "cancelled";
      else if (succeeded === resolved.length) status = "succeeded";
      else if (failed === resolved.length) status = "failed";
      this.store.updateBatch(batchId, { status, done: succeeded + failed, succeeded, failed, finished_at: Date.now() });
      this.emit({ type: "batch.update", batchId, status, done: succeeded + failed, total: resolved.length, succeeded, failed });
      return { batchId, status, succeeded, failed, total: resolved.length };
    } finally {
      this.running = false;
      this.currentBatchId = null;
    }
  }

  cancel() {
    this.cancelled = true;
    this.jobs.cancel();
  }
}
