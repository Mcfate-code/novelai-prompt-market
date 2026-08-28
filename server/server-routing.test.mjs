import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const NODE = process.execPath;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`面板服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待面板服务超时：${url}`);
}

async function requestAbsoluteForm(port, requestTarget) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method: "GET", path: requestTarget }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("serves /static assets and proxies V2 API routes to Python", async (t) => {
  const seen = [];
  const python = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ source: "python", method: req.method, path: req.url, body }));
    });
  });
  const pythonPort = await listen(python);
  const libraryDir = await mkdtemp(path.join(tmpdir(), "tags-market-library-"));
  const probe = createServer();
  const panelPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(NODE, ["--experimental-sqlite", "server.mjs", "--port", String(panelPort), "--no-boot"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, NODE_OPTIONS: "", PYTHON_APP_URL: `http://127.0.0.1:${pythonPort}`, LIBRARY_DIR: libraryDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await new Promise((resolve) => python.close(resolve));
    await rm(libraryDir, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${panelPort}/`, child);
  const script = await fetch(`http://127.0.0.1:${panelPort}/static/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);

  const requests = [
    { path: "/api/thumbs?tags=1girl", method: "GET", body: "" },
    { path: "/api/novelai-examples?tags=1girl", method: "GET", body: "" },
    { path: "/api/novelai-examples/clear", method: "POST", body: "" },
    { path: "/api/gallery", method: "GET", body: "" },
    { path: "/api/gallery/item", method: "POST", body: JSON.stringify({ image_base64: "Zm9v", dir_name: "nai_generated", mime: "image/png" }) },
    { path: "/api/presets", method: "GET", body: "" },
    { path: "/api/sync", method: "POST", body: JSON.stringify({ cursor: 42 }) },
    { path: "/api/runtime-info", method: "GET", body: "" },
    { path: "/api/templates?status=approved", method: "GET", body: "" },
    { path: "/api/templates/7", method: "GET", body: "" },
  ];
  for (const request of requests) {
    const response = await fetch(`http://127.0.0.1:${panelPort}${request.path}`, {
      method: request.method,
      headers: request.body ? { "Content-Type": "application/json" } : undefined,
      body: request.body || undefined,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { source: "python", ...request });
  }
  assert.deepEqual(seen, requests);

  const forbidden = await fetch(`http://127.0.0.1:${panelPort}/api/thumbs?tags=1girl`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(seen.length, requests.length);

  const absolute = await requestAbsoluteForm(panelPort, "http://attacker.example/api/thumbs?tags=escape");
  assert.equal(absolute.status, 200);
  assert.deepEqual(JSON.parse(absolute.body), {
    source: "python", method: "GET", path: "/api/thumbs?tags=escape", body: "",
  });
  assert.deepEqual(seen.at(-1), { method: "GET", path: "/api/thumbs?tags=escape", body: "" });

  const novelaiStatus = await fetch(`http://127.0.0.1:${panelPort}/api/novelai/status?probe=0`);
  assert.equal(novelaiStatus.status, 200);
  assert.equal((await novelaiStatus.json()).source, undefined);
  assert.equal(seen.length, requests.length + 1);

  const removedCompatibility = await fetch(`http://127.0.0.1:${panelPort}/api/nai-state`);
  assert.equal(removedCompatibility.status, 404);
  const removedLegacy = await fetch(`http://127.0.0.1:${panelPort}/api/legacy/presets`);
  assert.equal(removedLegacy.status, 404);

  const source = await fetch(`http://127.0.0.1:${panelPort}/api/novelai/img2img-source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_image: "data:image/png;base64,iVBORw0KGgo=", source_image_name: "base.png" }),
  });
  assert.equal(source.status, 201);
  const sourceData = await source.json();
  assert.equal(sourceData.ok, true);
  assert.equal(sourceData.source_image_name, "base.png");
  assert.match(sourceData.source_image_path, /^\/library\/assets\//);
  const persisted = await fetch(`http://127.0.0.1:${panelPort}${sourceData.source_image_path}`);
  assert.equal(persisted.status, 200);
  assert.match(persisted.headers.get("content-type") || "", /image\/png/);

  const invalidSource = await fetch(`http://127.0.0.1:${panelPort}/api/novelai/img2img-source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_image: "data:text/plain;base64,AAAA" }),
  });
  assert.equal(invalidSource.status, 400);
  assert.equal((await invalidSource.json()).code, "INVALID_IMG2IMG_SOURCE");
});

test("preserves gallery contract and error payloads from Python", async (t) => {
  const galleryList = { dirs: [{ dir_name: "naigallery", n: 2, favs: 1 }] };
  const galleryItem = {
    ok: true,
    dir_name: "nai_generated",
    file_name: "abc123.jpg",
    file_path: "data/gallery/nai_generated/abc123.jpg",
    prompt: "",
    negative_prompt: "",
    parameters: {},
    snapshot_id: null,
    source_asset_id: null,
    id: 77,
  };

  const seen = [];
  const python = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, body });
      if (req.url === "/api/gallery" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(galleryList));
        return;
      }
      if (req.url === "/api/gallery/item" && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(galleryItem));
        return;
      }
      if (req.url === "/api/gallery/missing-dir" && req.method === "GET") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "NOT_FOUND", error: "dir not found" }));
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "UNHANDLED_PYTHON_ROUTE", error: "unexpected python proxy test path" }));
    });
  });
  const pythonPort = await listen(python);
  const libraryDir = await mkdtemp(path.join(tmpdir(), "tags-market-library-"));
  const probe = createServer();
  const panelPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(NODE, ["--experimental-sqlite", "server.mjs", "--port", String(panelPort), "--no-boot"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, NODE_OPTIONS: "", PYTHON_APP_URL: `http://127.0.0.1:${pythonPort}`, LIBRARY_DIR: libraryDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await new Promise((resolve) => python.close(resolve));
    await rm(libraryDir, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${panelPort}/`, child);

  const list = await fetch(`http://127.0.0.1:${panelPort}/api/gallery`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), galleryList);

  const item = await fetch(`http://127.0.0.1:${panelPort}/api/gallery/item`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_base64: "Zm9v", dir_name: "nai_generated", mime: "image/png" }),
  });
  assert.equal(item.status, 201);
  assert.deepEqual(await item.json(), galleryItem);

  const miss = await fetch(`http://127.0.0.1:${panelPort}/api/gallery/missing-dir`);
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { ok: false, code: "NOT_FOUND", error: "dir not found" });

  assert.deepEqual(seen, [
    { method: "GET", path: "/api/gallery", body: "" },
    {
      method: "POST",
      path: "/api/gallery/item",
      body: JSON.stringify({ image_base64: "Zm9v", dir_name: "nai_generated", mime: "image/png" }),
    },
    { method: "GET", path: "/api/gallery/missing-dir", body: "" },
  ]);
});
