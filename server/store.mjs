// store.mjs — AssetStore：文件系统存原图 + SQLite 存元数据（阶段一）
// 落盘流程：tmp 写入 → SHA-256 去重 → 原子 rename 到 assets/YYYY/MM/ → 插库
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

export class AssetStore {
  constructor(libDir) {
    this.libDir = libDir;
    this.assetsDir = path.join(libDir, "assets");
    this.tmpDir = path.join(libDir, "tmp");
    for (const d of [this.assetsDir, this.tmpDir]) mkdirSync(d, { recursive: true });
    this.db = new DatabaseSync(path.join(libDir, "library.db"));
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        mime TEXT,
        byte_size INTEGER,
        sha256 TEXT,
        width INTEGER, height INTEGER,
        created_at INTEGER,
        source TEXT,
        job_id TEXT,
        prompt TEXT,
        negative_prompt TEXT,
        parameters_json TEXT,
        batch_id TEXT,
        batch_index INTEGER,
        batch_total INTEGER,
        correlation_id TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT,
        status TEXT,
        prompt TEXT,
        negative_prompt TEXT,
        parameters_json TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
      CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);
      CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);
      CREATE TABLE IF NOT EXISTS presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        negative_prompt TEXT,
        parameters_json TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        config_json TEXT,
        total INTEGER, done INTEGER, succeeded INTEGER, failed INTEGER,
        error_code TEXT, error_message TEXT, correlation_id TEXT,
        created_at INTEGER, finished_at INTEGER
      );
    `);
    const assetCols = new Set(this.db.prepare(`PRAGMA table_info(assets)`).all().map((row) => row.name));
    for (const [name, sql] of [["batch_id", "TEXT"], ["batch_index", "INTEGER"], ["batch_total", "INTEGER"], ["correlation_id", "TEXT"]]) {
      if (!assetCols.has(name)) this.db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${sql}`);
    }
    const batchCols = new Set(this.db.prepare(`PRAGMA table_info(batches)`).all().map((row) => row.name));
    for (const [name, sql] of [["error_code", "TEXT"], ["error_message", "TEXT"], ["correlation_id", "TEXT"]]) {
      if (!batchCols.has(name)) this.db.exec(`ALTER TABLE batches ADD COLUMN ${name} ${sql}`);
    }
  }

  createJob({ kind, prompt, negative_prompt, parameters_json }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, prompt, negative_prompt, parameters_json, started_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(id, kind, prompt, negative_prompt, parameters_json ?? null, Date.now());
    return id;
  }

  finishJob(id, { status, error_code, error_message }) {
    this.db
      .prepare(`UPDATE jobs SET status=?, error_code=?, error_message=?, finished_at=? WHERE id=?`)
      .run(status, error_code ?? null, error_message ?? null, Date.now(), id);
  }

  getJob(id) {
    return this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  }

  // 保存图片：buffer 落盘 + 元数据入库。返回 { id, duplicate, file_path, sha256 }
  saveImage(buffer, { mime = "image/png", width = null, height = null, source = "novelai", job_id = null, prompt = null, negative_prompt = null, parameters_json = null, batch_id = null, batch_index = null, batch_total = null, correlation_id = null }) {
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const dup = this.db.prepare(`SELECT id, file_path FROM assets WHERE sha256=?`).get(sha256);
    if (dup) {
      // 去重：不重复写文件，仅关联 job，并更新可追溯元数据（prompt/参数可能随提示词变化）。
      if (job_id) {
        this.db
          .prepare(`UPDATE assets SET job_id = CASE WHEN job_id IS NULL OR job_id='' THEN ? ELSE job_id END WHERE id=?`)
          .run(job_id, dup.id);
      }
      this.db
        .prepare(`
          UPDATE assets
          SET prompt = COALESCE(?, prompt),
              negative_prompt = COALESCE(?, negative_prompt),
              parameters_json = COALESCE(?, parameters_json),
              batch_id = COALESCE(?, batch_id), batch_index = COALESCE(?, batch_index), batch_total = COALESCE(?, batch_total), correlation_id = COALESCE(?, correlation_id),
              byte_size = ?, mime = ?, width = COALESCE(?, width), height = COALESCE(?, height),
              created_at = CASE WHEN ? > COALESCE(created_at, 0) THEN ? ELSE created_at END
          WHERE id = ?
        `)
        .run(prompt, negative_prompt, parameters_json, batch_id, batch_index, batch_total, correlation_id, buffer.length, mime, width, height, Date.now(), Date.now(), dup.id);
      return { id: dup.id, duplicate: true, file_path: dup.file_path, sha256 };
    }
    const id = randomUUID();
    const d = new Date();
    const relDir = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    const absDir = path.join(this.assetsDir, relDir);
    mkdirSync(absDir, { recursive: true });
    const ext = MIME_EXT[mime] || "png";
    const relPath = `assets/${relDir}/${id}.${ext}`;
    const absPath = path.join(this.libDir, relPath);
    const tmp = path.join(this.tmpDir, `${id}.tmp`);
    writeFileSync(tmp, buffer);
    renameSync(tmp, absPath); // 原子落盘
    this.db
      .prepare(
        `INSERT INTO assets (id, file_path, mime, byte_size, sha256, width, height, created_at, source, job_id, prompt, negative_prompt, parameters_json, batch_id, batch_index, batch_total, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, relPath, mime, buffer.length, sha256, width, height, Date.now(), source, job_id, prompt, negative_prompt, parameters_json ?? null, batch_id, batch_index, batch_total, correlation_id);
    return { id, duplicate: false, file_path: relPath, sha256 };
  }

  listAssets({ limit = 60, offset = 0 } = {}) {
    return this.db
      .prepare(`SELECT * FROM assets ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset);
  }

  // ---- 预设 ----
  createPreset({ name, prompt, negative_prompt = "", parameters_json = null }) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO presets (id, name, prompt, negative_prompt, parameters_json, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, name, prompt, negative_prompt, parameters_json ?? null, Date.now());
    return id;
  }

  listPresets() {
    return this.db.prepare(`SELECT * FROM presets ORDER BY updated_at DESC`).all();
  }

  getPreset(id) {
    return this.db.prepare(`SELECT * FROM presets WHERE id=?`).get(id);
  }

  deletePreset(id) {
    this.db.prepare(`DELETE FROM presets WHERE id=?`).run(id);
  }

  // ---- 批次 ----
  createBatch({ id = randomUUID(), name = "", config_json = null, total }) {
    this.db
      .prepare(`INSERT INTO batches (id, name, status, config_json, total, done, succeeded, failed, created_at) VALUES (?,?,?,?,?,0,0,0,?)`)
      .run(id, name, "queued", config_json ?? null, total, Date.now());
    return id;
  }

  updateBatch(id, patch) {
    const cols = Object.keys(patch).filter((k) => ["status", "done", "succeeded", "failed", "error_code", "error_message", "correlation_id", "finished_at"].includes(k));
    if (!cols.length) return;
    this.db.prepare(`UPDATE batches SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE id=?`).run(...cols.map((c) => patch[c]), id);
  }

  getBatch(id) {
    return this.db.prepare(`SELECT * FROM batches WHERE id=?`).get(id);
  }

  listBatches({ limit = 10 } = {}) {
    return this.db.prepare(`SELECT * FROM batches ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  getAsset(id) {
    return this.db.prepare(`SELECT * FROM assets WHERE id=?`).get(id);
  }

  absPath(relPath) {
    return path.join(this.libDir, relPath);
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
