import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssetStore } from "./store.mjs";
import { createGenerationRecipe, normalizeGenerationRequest } from "./generation-request.mjs";

test("identical PNG bytes still produce independent assets and files", () => {
  const libDir = mkdtempSync(path.join(tmpdir(), "tags-market-store-"));
  const store = new AssetStore(libDir);
  try {
    // 合法 PNG 魔数 + 任意尾字节，保证两次完全一致。
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const first = store.saveImage(buffer, { mime: "image/png", job_id: "job-1", prompt: "1girl", correlation_id: "corr-1" });
    const second = store.saveImage(buffer, { mime: "image/png", job_id: "job-2", prompt: "1girl", correlation_id: "corr-2" });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false);
    assert.notEqual(first.id, second.id, "每次生成都应有独立 asset id");
    assert.notEqual(first.file_path, second.file_path, "每次生成都应有独立文件");
    assert.equal(first.sha256, second.sha256, "字节相同 → sha256 相同，但仍是两个独立 asset");
    assert.ok(existsSync(path.join(libDir, first.file_path)), "第一个文件落盘");
    assert.ok(existsSync(path.join(libDir, second.file_path)), "第二个文件落盘");

    // 两个资产都在列表里，且各自携带自己的 job_id。
    const assets = store.listAssets({ limit: 10 });
    assert.equal(assets.length, 2);
    const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
    assert.equal(byId[first.id].job_id, "job-1");
    assert.equal(byId[second.id].job_id, "job-2");
    assert.equal(byId[first.id].correlation_id, "corr-1");
    assert.equal(byId[second.id].correlation_id, "corr-2");
  } finally {
    store.close();
    rmSync(libDir, { recursive: true, force: true });
  }
});

test("saveImage returns a fresh asset id on every call", () => {
  const libDir = mkdtempSync(path.join(tmpdir(), "tags-market-store-"));
  const store = new AssetStore(libDir);
  try {
    const buffer = Buffer.from("not-a-real-image");
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const saved = store.saveImage(buffer, { mime: "image/png" });
      assert.equal(saved.duplicate, false);
      ids.add(saved.id);
    }
    assert.equal(ids.size, 5, "5 次调用必须得到 5 个不同 id");
    assert.equal(store.listAssets({ limit: 20 }).length, 5);
  } finally {
    store.close();
    rmSync(libDir, { recursive: true, force: true });
  }
});

test("persists cfg_rescale and auto_smea verbatim in saved image metadata", () => {
  const libDir = mkdtempSync(path.join(tmpdir(), "tags-market-store-"));
  const store = new AssetStore(libDir);
  try {
    // 走真实落库链路：normalize → recipe → saveImage(parameters_json) → getAsset 读回。
    const request = normalizeGenerationRequest({
      prompt: "1girl",
      settings: { cfg_rescale: 0.7, auto_smea: true },
    });
    const recipe = createGenerationRecipe(request, 123);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const saved = store.saveImage(buffer, {
      mime: "image/png",
      prompt: request.prompt,
      parameters_json: JSON.stringify(recipe),
    });
    const asset = store.getAsset(saved.id);
    assert.ok(asset.parameters_json, "metadata 应已落库");
    const meta = JSON.parse(asset.parameters_json);
    assert.equal(meta.settings.cfg_rescale, 0.7, "cfg_rescale 应在保存后的 metadata 中保持输入值");
    assert.equal(meta.settings.auto_smea, true, "auto_smea 应在保存后的 metadata 中保持输入值");
  } finally {
    store.close();
    rmSync(libDir, { recursive: true, force: true });
  }
});
