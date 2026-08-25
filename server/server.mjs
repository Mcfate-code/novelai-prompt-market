// server.mjs — 标签超市服务入口：静态面板 + 官方 NovelAI API + SSE 事件推送
// 用法: node --experimental-sqlite server.mjs [--port 8787]
import { createServer, request as httpRequest } from "node:http";
import { statSync, existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssetStore } from "./store.mjs";
import { NovelAIProvider, readNovelAIBatchLimit } from "./novelai-provider.mjs";
import { ApiBatchController } from "./api-batch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "..", "static");
const LIB_DIR = process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : path.join(__dirname, "..", "library");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      a[k.slice(2)] = argv[i + 1];
      i++;
    } else if (k.startsWith("--")) {
      a[k.slice(2)] = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv);
const PORT = Number(args.port || 8787);
// 标签超市 Python 应用（V2 数据 API、缩略图与图库文件）
const PYTHON_APP_URL = (process.env.PYTHON_APP_URL || "http://127.0.0.1:8123").replace(/\/+$/, "");
const PYTHON_GALLERY_URL = process.env.PYTHON_GALLERY_URL || `${PYTHON_APP_URL}/api/gallery/item`;
const PYTHON_API_PREFIXES = [
  "/api/settings", "/api/cache/", "/api/models", "/api/overlay/", "/api/taxonomy",
  "/api/novelai-examples", "/api/novelai-example", "/api/tag-novelai", 
  "/api/search", "/api/resolve", "/api/zh", "/api/zh-notes", "/api/thumbs", "/api/catalog",
  "/api/tag/", "/api/status/", "/api/category/", "/api/prompt/", "/api/bundles",
  "/api/cooccurrence/", "/api/recommendations", "/api/conflicts", "/api/snapshots",
  "/api/import", "/api/user-tags", "/api/inbox", "/api/export", "/api/favorites",
  "/api/recent", "/api/presets", "/api/gallery", "/api/sync", "/api/sync-hot",
];
const LOOPBACK_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

const store = new AssetStore(LIB_DIR);
const apiProvider = new NovelAIProvider();
const apiBatches = new ApiBatchController({
  provider: apiProvider,
  getMaxCount: readNovelAIBatchLimit,
  createBatch: (batch) => store.createBatch(batch),
  updateBatch: (id, patch) => store.updateBatch(id, patch),
  getBatch: (id) => store.getBatch(id),
  onEvent: (event) => broadcast(event),
  saveImage: async (image, meta) => {
    const buffer = Buffer.from(image.base64.replace(/^data:[^;]+;base64,/, ""), "base64");
    const saved = store.saveImage(buffer, {
      mime: "image/png", source: "novelai-api", prompt: meta.prompt, negative_prompt: meta.negative_prompt,
      parameters_json: JSON.stringify(meta.recipe), batch_id: meta.batch_id, batch_index: meta.batch_index,
      batch_total: meta.batch_total, correlation_id: meta.correlation_id,
    });
    if (!saved.duplicate) {
      broadcast({ type: "asset.created", assetId: saved.id, filePath: saved.file_path, duplicate: false, batchId: meta.batch_id, snapshotId: meta.snapshot_id ?? null, gallerySync: "pending" });
    }
    try {
      await pushToPythonGallery({ assetId: saved.id });
      broadcast({ type: "asset.sync", assetId: saved.id, batchId: meta.batch_id, snapshotId: meta.snapshot_id ?? null, gallerySync: "succeeded" });
      return { ...saved, gallery_sync: "succeeded" };
    } catch (cause) {
      console.error(`图片已保存，但推送到 Python 图库失败（asset id=${saved.id}）:`, cause.message);
      broadcast({ type: "asset.sync", assetId: saved.id, batchId: meta.batch_id, snapshotId: meta.snapshot_id ?? null, gallerySync: "failed", error: cause.message });
      return { ...saved, gallery_sync: "failed", gallery_sync_error: cause.message };
    }
  },
});

let novelaiOperationInFlight = false;
async function withNovelAIOperation(task, message = "已有 API 生图任务在运行，请稍后重试") {
  if (novelaiOperationInFlight || apiBatches.running) {
    const error = new Error(message);
    error.code = "GENERATION_IN_PROGRESS";
    throw error;
  }
  novelaiOperationInFlight = true;
  try {
    return await task();
  } finally {
    novelaiOperationInFlight = false;
  }
}

// ---- SSE 事件中心 ----
const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

const galleryPushes = new Map();
async function pushToPythonGallery(event) {
  if (galleryPushes.has(event.assetId)) return galleryPushes.get(event.assetId);
  const push = (async () => {
    const asset = store.getAsset(event.assetId);
    if (!asset) throw new Error(`Node 资产不存在: ${event.assetId}`);
    const abs = store.absPath(asset.file_path);
    const { readFileSync } = await import("node:fs");
    const b64 = readFileSync(abs).toString("base64");
    let parameters = null;
    try { parameters = asset.parameters_json ? JSON.parse(asset.parameters_json) : null; } catch {}
    const body = {
      image_base64: b64,
      mime: asset.mime || "image/png",
      prompt: asset.prompt || "",
      negative_prompt: asset.negative_prompt || "",
      parameters,
      snapshot_id: parameters?.snapshot_id ?? null,
      source_asset_id: asset.id,
      dir_name: "nai_generated",
    };
    const res = await fetch(PYTHON_GALLERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const result = await res.json();
    console.log("📥 已推送 Python 图库:", result.dir_name + "/" + result.file_name);
    return result;
  })();
  galleryPushes.set(event.assetId, push);
  try {
    return await push;
  } finally {
    galleryPushes.delete(event.assetId);
  }
}

// ---- 静态/库文件服务 ----
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".svg": "image/svg+xml" };
function serveFile(res, absPath) {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const ext = path.extname(absPath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  createReadStream(absPath).pipe(res);
}
function safeJoin(base, rel) {
  const p = path.resolve(base, "." + path.sep + rel);
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

function decodeImg2ImgSource(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("基础图必须是 PNG、JPEG 或 WebP");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length) throw new Error("基础图内容为空");
  if (buffer.length > 20 * 1024 * 1024) throw new Error("基础图不能超过 20MB");
  return { mime: match[1], buffer };
}

function isPythonRoute(pathname) {
  return pathname.startsWith("/gallery/") || PYTHON_API_PREFIXES.some((prefix) => (
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
}

function proxyToPython(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${PYTHON_APP_URL}/`);
  const headers = { ...req.headers, host: target.host };
  delete headers.origin;
  const upstream = httpRequest(target, { method: req.method, headers }, (response) => {
    const responseHeaders = { ...response.headers };
    delete responseHeaders["access-control-allow-origin"];
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Python 服务响应超时")));
  upstream.on("error", (cause) => {
    if (res.headersSent) { res.destroy(cause); return; }
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, code: "PYTHON_SERVICE_UNAVAILABLE", error: `标签数据服务未启动或不可用：${cause.message}` }));
  });
  req.pipe(upstream);
}

const status = { mode: "api-only", cdp: "disabled", webCompatibility: false };

// ---- HTTP 服务 ----
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // Only local pages may control generation. A wildcard here would let any
  // website opened by the user call localhost and spend Anlas.
  const origin = req.headers.origin || "";
  if (origin && LOOPBACK_ORIGIN.test(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    if (origin && !LOOPBACK_ORIGIN.test(origin)) { res.writeHead(403); res.end("forbidden origin"); return; }
    res.writeHead(204); res.end(); return;
  }
  if (origin && !LOOPBACK_ORIGIN.test(origin) && p.startsWith("/api/")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "forbidden origin" }));
    return;
  }

  // SSE 事件流
  if (p === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // 状态
  if (p === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  // Official NovelAI API status. A probe validates network/auth without generating an image.
  if (p === "/api/novelai/status") {
    (async () => {
      try {
        const result = url.searchParams.get("probe") === "0"
          ? { ok: true, configured: apiProvider.configured, state: apiProvider.configured ? "configured" : "unconfigured" }
          : await apiProvider.probe();
        res.writeHead(result.ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...result, endpoint: apiProvider.endpoint, network: apiProvider.network }));
      } catch (cause) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, configured: apiProvider.configured, state: "unreachable", code: cause.code || "PROBE_ERROR", error: cause.message, endpoint: apiProvider.endpoint, network: apiProvider.network }));
      }
    })();
    return;
  }

  // 标签例图专用单图接口。固定 V4.5 Full 与小尺寸，不写入普通图库。
  if (p === "/api/novelai/tag-example" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy(new Error("标签例图请求过大"));
    });
    req.on("end", async () => {
      try {
        await withNovelAIOperation(async () => {
          const input = JSON.parse(body || "{}");
          const prompt = String(input.prompt || "").trim();
          if (!input.confirm_anlas) {
            const error = new Error("生成 NovelAI 标签例图会消耗 Anlas，请明确确认后再请求");
            error.code = "ANLAS_CONFIRMATION_REQUIRED";
            error.status = 428;
            throw error;
          }
          if (!prompt || prompt.length > 2400) throw new Error("提示词不能为空且不能超过 2400 个字符");
          const result = await apiProvider.generateOne({
            prompt,
            negative_prompt: "lowres, blurry, bad anatomy, text, watermark",
            settings: {
              model: "nai-diffusion-4-5-full",
              width: 832,
              height: 832,
              steps: 28,
              guidance: 5,
              sampler: "k_euler_ancestral",
            },
            quality_toggle: true,
            // 图库例图专用链路使用 Light UC preset；普通生成走 /api/novelai/generate，不传此字段保持 heavy。
            uc_preset: "light",
          });
          const image = result.images[0];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            image_base64: image.base64,
            seed: image.seed,
            model: "nai-diffusion-4-5-full",
            width: 832,
            height: 832,
            steps: 28,
          }));
          return true;
        }, "已有 NovelAI 生图任务在运行，请稍后重试");
      } catch (cause) {
        const statusCode = cause.status && Number.isInteger(cause.status) ? cause.status : 400;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: cause.code || "TAG_EXAMPLE_ERROR", error: cause.message }));
      }
    });
    return;
  }

  if (p === "/api/novelai/img2img-source" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 28 * 1024 * 1024) req.destroy(new Error("基础图请求过大"));
    });
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const { mime, buffer } = decodeImg2ImgSource(input.source_image);
        const saved = store.saveImage(buffer, { mime, source: "img2img-source" });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, source_image_path: `/library/${saved.file_path}`, source_image_name: String(input.source_image_name || "基础图"), duplicate: saved.duplicate }));
      } catch (cause) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "INVALID_IMG2IMG_SOURCE", error: cause.message }));
      }
    });
    return;
  }

  // Limited serial API batch: count 1-6, each provider call uses n_samples=1.
  if (p === "/api/novelai/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const b = JSON.parse(body || "{}");
        if (!apiProvider.configured) {
          const error = new Error("未配置 NovelAI Persistent API Token");
          error.code = "TOKEN_MISSING";
          throw error;
        }
        const generation = { ...b, prompt: b.prompt, negative_prompt: b.negative_prompt || "", snapshot_id: b.snapshot_id ?? null };
        await withNovelAIOperation(() => {
          apiBatches.validateCount(b.count);
          apiBatches.validateGeneration(generation);
          const run = apiBatches.run({ generation, count: b.count, name: b.name || "" });
          const batchId = apiBatches.current?.batchId;
          if (!batchId) throw new Error("API 批次未能启动");
          run.catch((error) => console.error(`API 批次 ${batchId} 异常结束:`, error.message));
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, batchId, status: "running", total: apiBatches.current.total }));
          return true;
        }, "已有 API 生图批次在运行（单并发）");
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message, code: e.code }));
      }
    });
    return;
  }
  if (p.startsWith("/api/novelai/generate/") && p.endsWith("/cancel") && req.method === "POST") {
    const batchId = p.slice("/api/novelai/generate/".length, -"/cancel".length);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: apiBatches.cancel(batchId), batchId }));
    return;
  }
  if (p.startsWith("/api/novelai/generate/") && req.method === "GET") {
    const batchId = p.slice("/api/novelai/generate/".length);
    const batch = apiBatches.status(batchId);
    if (!batch) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "BATCH_NOT_FOUND", error: "批次不存在" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, batch }));
    return;
  }

  if (p === "/api/batches") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ batches: store.listBatches({ limit: Number(url.searchParams.get("limit") || 10) }) }));
    return;
  }

  // 图库列表
  if (p === "/api/assets") {
    const list = store.listAssets();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  // 最近任务（诊断用）
  if (p === "/api/jobs") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 10), 50);
    const rows = store.db.prepare(`SELECT id, kind, status, prompt, negative_prompt, started_at, finished_at, error_code, error_message FROM jobs ORDER BY started_at DESC LIMIT ?`).all(limit);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobs: rows }));
    return;
  }

  // V2 标签、例图、设置与 Python 图库统一从当前面板入口访问。
  if (isPythonRoute(p)) {
    proxyToPython(req, res);
    return;
  }

  // Node 原始资产文件
  if (p.startsWith("/library/")) {
    const rel = p.slice("/library/".length);
    const abs = safeJoin(LIB_DIR, rel);
    if (abs) { serveFile(res, abs); return; }
    res.writeHead(403); res.end("forbidden"); return;
  }

  // 面板静态文件。HTML 使用 /static/*，APP_DIR 本身已经是 static。
  const rel = p === "/" ? "index.html" : p.startsWith("/static/") ? p.slice("/static/".length) : p.slice(1);
  const abs = safeJoin(APP_DIR, rel);
  if (abs) { serveFile(res, abs); return; }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🖼 标签超市面板: http://127.0.0.1:${PORT}`);
  console.log("   生图通道：NovelAI 官方 API（网页兼容模块已停用）");
});
