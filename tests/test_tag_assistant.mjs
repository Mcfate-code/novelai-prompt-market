/**
 * Tag Assistant 独立组件测试（static/tag-assistant.js）。
 * 覆盖四条入口路径（推荐 / 目录 / 搜索 / 收藏）与 PromptBridge dispatch 路径；
 * 组件为纯模块（无 DOM 依赖），可直接在 Node 中 import 真实实现。
 *
 * 运行方式: node --test tests/test_tag_assistant.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addCharacter, addTag, createEmpty } from "../static/prompt-document.js";
import {
  TagAssistant,
  buildAddTagAction,
  buildRecommendPayload,
  debounce,
  dispatchAddTag,
  filterSelected,
  flattenSemanticTree,
  groupRecommendations,
  mapBackendTarget,
  positiveTagsFromDocument,
  recommendFallback,
  selectedTagKeys,
  toCard,
  toCards,
} from "../static/tag-assistant.js";

const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
const REC = (over = {}) => ({
  tag: "bedroom", canonical: "bedroom", zh: "卧室", section: "scene", count: 7,
  reason: "cooccurrence", source: ["cooccurrence"], post_count: 120000, ...over,
});
const makeBridge = (doc = createEmpty(), target = "base") => ({
  getDocument: () => doc,
  getActiveTarget: () => target,
  subscribe: () => () => {},
  dispatch: () => {},
});

// ---- 推荐路径：positive 标签提取 ----

test("positiveTagsFromDocument collects base + character prompt, excludes UC and global UC", () => {
  let doc = addTag(createEmpty(), "base", "blue eyes", "appearance");
  doc = addTag(doc, "char:0", "1girl", "character");
  doc = addTag(doc, "char:0:uc", "lowres", "other");
  doc = addTag(doc, "global_uc", "bad anatomy", "other");
  doc = addCharacter(doc, { name: "Second", prompt_sections: { character: [{ tag: "citlali" }] }, uc_sections: {} });
  assert.deepEqual(positiveTagsFromDocument(doc), ["blue eyes", "1girl", "citlali"]);
});

test("positiveTagsFromDocument dedupes case-insensitively and tolerates missing document", () => {
  let doc = addTag(createEmpty(), "base", "Blue Eyes", "appearance");
  doc = addTag(doc, "base", "blue eyes", "appearance");
  assert.deepEqual(positiveTagsFromDocument(doc), ["Blue Eyes"]);
  assert.deepEqual(positiveTagsFromDocument(null), []);
  assert.deepEqual(positiveTagsFromDocument({}), []);
});

// ---- 推荐路径：请求载荷与后端 target 映射 ----

test("mapBackendTarget maps active targets to backend base|character", () => {
  assert.equal(mapBackendTarget("base"), "base");
  assert.equal(mapBackendTarget("global_uc"), "base");
  assert.equal(mapBackendTarget("char:0"), "character");
  assert.equal(mapBackendTarget("char:1:uc"), "character");
  assert.equal(mapBackendTarget(""), "base");
  assert.equal(mapBackendTarget(undefined), "base");
});

test("buildRecommendPayload sends positive tags, mapped target, node_id and limit", () => {
  let doc = addTag(createEmpty(), "base", "blue eyes", "appearance");
  doc = addTag(doc, "char:0", "1girl", "character");
  doc = addTag(doc, "global_uc", "bad anatomy", "other"); // UC 不入 positive 样本
  const payload = buildRecommendPayload(doc, "char:0:uc", "env_indoor", 15);
  assert.deepEqual(payload.tags, ["blue eyes", "1girl"]);
  assert.equal(payload.target, "character");
  assert.equal(payload.node_id, "env_indoor");
  assert.equal(payload.limit, 15);
  assert.equal(buildRecommendPayload(doc, "base", "", 0).limit, 20, "非法 limit 回退默认");
});

// ---- 推荐路径：已选去重 ----

test("selectedTagKeys covers every target of the document", () => {
  let doc = addTag(createEmpty(), "base", "blue eyes", "appearance");
  doc = addTag(doc, "global_uc", "lowres", "other");
  doc = addTag(doc, "char:0", "1girl", "character");
  doc = addTag(doc, "char:0:uc", "bad anatomy", "other");
  const keys = selectedTagKeys(doc);
  for (const expected of ["blue eyes", "lowres", "1girl", "bad anatomy"]) assert.ok(keys.has(expected));
  assert.ok(!keys.has("bedroom"));
});

test("filterSelected removes already-selected tags by tag or canonical, case-insensitively", () => {
  const recs = [REC(), REC({ tag: "Blue Eyes", canonical: "blue_eyes", count: 99 }), REC({ tag: "bed", canonical: "bed" })];
  const selected = new Set(["blue eyes"]);
  const kept = filterSelected(recs, selected);
  assert.deepEqual(kept.map((item) => item.tag), ["bedroom", "bed"]);
  assert.equal(kept.length, 2, "Blue Eyes（canonical blue_eyes）按大小写不敏感命中已选集合");
});

// ---- 推荐路径：语义分组与统一 card DTO ----

test("groupRecommendations groups by section in fixed section order with Chinese labels", () => {
  const recs = [
    REC({ tag: "bed", section: "scene", count: 3 }),
    REC({ tag: "sunlight", section: "scene", count: 9 }),
    REC({ tag: "white shirt", section: "clothing", count: 5 }),
    REC({ section: "", count: 1 }),
  ];
  const groups = groupRecommendations(recs);
  assert.deepEqual(groups.map((g) => g.section), ["clothing", "scene", "other"], "分区顺序固定，未知分区归 other");
  assert.deepEqual(groups.map((g) => g.label), ["服装", "场景", "其他"]);
  const scene = groups[1].items.map((c) => c.tag);
  assert.deepEqual(scene, ["bed", "sunlight"], "组内保持后端输入顺序（组件不重排、不覆盖后端排序）");
  assert.equal(groups[1].items[0].postCount, 120000);
});

test("toCard normalizes recommendation / search / favorites item shapes", () => {
  const rec = toCard(REC());
  assert.equal(rec.tag, "bedroom");
  assert.equal(rec.zh, "卧室");
  assert.equal(rec.postCount, 120000);
  assert.equal(rec.section, "scene");
  assert.deepEqual(rec.source, ["cooccurrence"]);
  const search = toCard({ tag: "blue eyes", zh: "蓝眼", post_count: 42, match_reason: "exact" });
  assert.equal(search.postCount, 42);
  assert.equal(search.matchReason, "exact");
  const fav = toCard({ tag: "1girl", canonical: "1girl", post_count: 0, zh: "" });
  assert.equal(fav.postCount, 0);
  assert.equal(toCard(null), null);
  assert.equal(toCard({ canonical: "solo" }).tag, "solo");
  assert.equal(toCards([null, { tag: "x" }]).length, 1);
});

// ---- 目录路径：语义骨架扁平化 + 节点种子兜底 ----

const TREE = {
  base: {
    id: "base", label: "Base",
    children: [{
      id: "base_environment", label: "Environment", seed_tags: ["indoors", "outdoors"],
      children: [{ id: "env_indoor", label: "Indoor", seed_tags: ["bedroom", "cafe", "window"] }],
    }],
  },
  character: { id: "character", label: "Character", children: [{ id: "char_hair", label: "Hair", seed_tags: ["long hair"] }] },
};

test("flattenSemanticTree flattens base/character skeleton with depth and seed tags", () => {
  const groups = flattenSemanticTree(TREE);
  assert.deepEqual(groups.map((g) => g.key), ["base", "character"]);
  assert.equal(groups[0].nodes.length, 2, "base_environment(depth1) + env_indoor(depth2)");
  assert.equal(groups[0].nodes[0].depth, 1);
  assert.equal(groups[0].nodes[1].depth, 2);
  assert.deepEqual(groups[0].nodes[1].seedTags, ["bedroom", "cafe", "window"]);
  assert.deepEqual(groups[1].nodes.map((n) => n.id), ["char_hair"]);
  assert.deepEqual(flattenSemanticTree(null), []);
  assert.deepEqual(flattenSemanticTree({}), []);
});

test("recommendFallback renders node seed tags as cards when recommendations are empty", () => {
  const node = flattenSemanticTree(TREE)[0].nodes[1];
  const cards = recommendFallback(node);
  assert.deepEqual(cards.map((c) => c.tag), ["bedroom", "cafe", "window"]);
  assert.equal(cards[0].reason, "node_seed");
  assert.deepEqual(recommendFallback(null), []);
  assert.deepEqual(recommendFallback({ id: "x", seedTags: [] }), []);
});

// ---- 推荐路径：组件级调用链（payload -> 去重 -> 分组），并验证无第二份权威状态 ----

test("recommend path calls POST /api/recommendations, filters selected and groups by section", async () => {
  const captured = [];
  const doc = addTag(createEmpty(), "base", "blue eyes", "appearance");
  const ta = new TagAssistant({
    bridge: makeBridge(doc, "base"),
    fetchImpl: async (url, opts) => { captured.push({ url, opts }); return json({ recommendations: [REC(), REC({ tag: "blue eyes", canonical: "blue_eyes", count: 99 })] }); },
  });
  await ta.reload("recommend");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "/api/recommendations");
  assert.equal(captured[0].opts.method, "POST");
  const body = JSON.parse(captured[0].opts.body);
  assert.deepEqual(body.tags, ["blue eyes"]);
  assert.equal(body.target, "base");
  assert.equal(body.node_id, "");
  const cards = ta.view.groups.flatMap((g) => g.items);
  assert.deepEqual(cards.map((c) => c.tag), ["bedroom"], "已选 blue eyes 被去重");
  assert.equal(ta.view.groups[0].section, "scene");
  assert.equal(ta.view.status, "ok");
});

test("component keeps no second authoritative prompt state (reads document per reload)", async () => {
  let calls = 0;
  const doc = addTag(createEmpty(), "base", "solo", "character");
  const bridge = { ...makeBridge(doc), getDocument: () => { calls += 1; return doc; } };
  const ta = new TagAssistant({ bridge, fetchImpl: async () => json({ recommendations: [REC()] }) });
  await ta.reload("recommend");
  await ta.reload("recommend");
  assert.equal(calls, 2, "每次刷新都重新读取 PromptBridge，而非复用副本");
  assert.equal(ta.doc, undefined, "实例不保存 PromptDocument 副本");
  assert.equal("doc" in ta, false);
  assert.equal(ta.view.groups[0].items[0].tag, "bedroom");
});

// ---- 目录路径：组件级调用链（骨架 -> 节点 -> 推荐） ----

test("catalog path loads semantic skeleton and node selection calls recommendations with node_id", async () => {
  const bodies = [];
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const ta = new TagAssistant({
    bridge: makeBridge(doc, "base"),
    fetchImpl: async (url, opts) => {
      if (String(url).includes("/api/catalog/semantic")) return json({ tree: TREE });
      bodies.push(JSON.parse(opts.body));
      return json({ recommendations: [REC({ tag: "bedroom", reason: "node_seed", source: ["node_seed"] })] });
    },
  });
  await ta.reload("catalog");
  assert.equal(ta.view.status, "ok");
  assert.equal(ta.view.nodes.length, 2, "Base / Character 两组骨架");
  assert.ok(ta.view.nodes[0].nodes.some((n) => n.id === "env_indoor"));

  await ta.selectNode("env_indoor");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].node_id, "env_indoor");
  assert.equal(bodies[0].tags[0], "1girl");
  assert.equal(ta.view.groups[0].items[0].tag, "bedroom");
  assert.equal(ta.nodeId, "env_indoor");
});

test("catalog node selection falls back to node seed tags when recommendations are empty", async () => {
  const ta = new TagAssistant({
    bridge: makeBridge(addTag(createEmpty(), "base", "1girl", "character"), "base"),
    fetchImpl: async (url) => (String(url).includes("/api/catalog/semantic") ? json({ tree: TREE }) : json({ recommendations: [] })),
  });
  await ta.reload("catalog");
  await ta.selectNode("env_indoor");
  assert.equal(ta.view.status, "ok");
  assert.equal(ta.view.seedFallback, true);
  assert.deepEqual(ta.view.groups[0].items.map((c) => c.tag), ["bedroom", "cafe", "window"]);
});

// ---- 搜索路径：复用 /api/search ----

test("search path calls /api/search with the query and normalizes match results", async () => {
  const urls = [];
  const ta = new TagAssistant({
    fetchImpl: async (url) => { urls.push(String(url)); return json({ results: [{ tag: "blue eyes", zh: "蓝眼", post_count: 42, match_reason: "pinyin_exact（通过中文名拼音）" }] }); },
  });
  ta.searchQuery = "lan yan";
  await ta.reload("search");
  assert.ok(urls[0].startsWith("/api/search?q=lan%20yan&limit=20"));
  assert.equal(ta.view.status, "ok");
  assert.equal(ta.view.cards[0].tag, "blue eyes");
  assert.equal(ta.view.cards[0].matchReason, "pinyin_exact（通过中文名拼音）");
  assert.equal(ta.view.cards[0].postCount, 42);
});

test("search path empty query shows idle hint and stale responses are dropped", async () => {
  const ta = new TagAssistant({ fetchImpl: async () => json({ results: [] }) });
  await ta.reload("search");
  assert.equal(ta.view.status, "idle");
  assert.match(ta.view.message, /拼音/);

  ta.searchQuery = "solo";
  const first = ta.reload("search");
  ta.searchQuery = "1girl";
  const second = ta.reload("search");
  await Promise.all([first, second]);
  assert.equal(ta.view.query, "1girl", "较旧请求被 seq 丢弃");
});

// ---- 收藏路径：复用 /api/favorites ----

test("favorites path calls /api/favorites and normalizes items", async () => {
  const urls = [];
  const ta = new TagAssistant({
    fetchImpl: async (url) => { urls.push(String(url)); return json({ favorites: [{ tag: "blue eyes", zh: "蓝眼", post_count: 99999 }, { tag: "1girl" }] }); },
  });
  await ta.reload("favorites");
  assert.deepEqual(urls, ["/api/favorites"]);
  assert.equal(ta.view.status, "ok");
  assert.deepEqual(ta.view.cards.map((c) => c.tag), ["blue eyes", "1girl"]);
  assert.equal(ta.view.cards[0].postCount, 99999);
});

// ---- dispatch 路径：点击 + -> ADD_TAG 到 active target ----

test("buildAddTagAction produces the PromptBridge ADD_TAG contract", () => {
  assert.deepEqual(buildAddTagAction("bedroom", { target: "base", section: "scene" }), {
    type: "ADD_TAG",
    payload: { tag: "bedroom", target: "base", section: "scene" },
  });
  assert.deepEqual(buildAddTagAction("solo", { target: "char:0" }), {
    type: "ADD_TAG",
    payload: { tag: "solo", target: "char:0" },
  });
  const weighted = buildAddTagAction("blue eyes", { target: "base", weight: 1.2 });
  assert.equal(weighted.payload.weight, 1.2);
});

test("addTag dispatches ADD_TAG to the active target via the bridge", () => {
  const dispatched = [];
  const bridge = { ...makeBridge(), getActiveTarget: () => "char:0", dispatch: (action) => dispatched.push(action) };
  const ta = new TagAssistant({ bridge });
  assert.equal(ta.addTag("bedroom", "scene"), true);
  assert.deepEqual(dispatched, [{ type: "ADD_TAG", payload: { tag: "bedroom", target: "char:0", section: "scene" } }]);
});

test("addTag falls back to current target and never crashes without a bridge", () => {
  const ta = new TagAssistant({});
  assert.equal(ta.addTag("bedroom", "scene"), false, "无桥返回 false");
  assert.equal(dispatchAddTag(null, buildAddTagAction("x", {})), false);
  assert.equal(dispatchAddTag({}, buildAddTagAction("x", {})), false);
  const broken = { dispatch: () => { throw new Error("boom"); } };
  assert.equal(dispatchAddTag(broken, buildAddTagAction("x", {})), false, "桥异常不抛出");
});

// ---- 防抖：PromptBridge 变化合并刷新，不每次请求 ----

test("debounce coalesces rapid calls into one trailing call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const d = debounce(() => { n += 1; }, 400);
  d(); d(); d();
  await t.mock.timers.tick(399);
  assert.equal(n, 0);
  await t.mock.timers.tick(1);
  assert.equal(n, 1, "防抖窗口结束后只执行一次");
  d();
  await t.mock.timers.tick(400);
  assert.equal(n, 2);
});

test("bridge changes trigger one debounced recommendation refresh, not per change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  const ta = new TagAssistant({
    bridge: makeBridge(addTag(createEmpty(), "base", "solo", "character"), "base"),
    fetchImpl: async (url, opts) => { requests.push({ url, opts }); return json({ recommendations: [] }); },
  });
  await ta.reload("recommend"); // 初始加载 1 次
  assert.equal(requests.length, 1);
  for (let i = 0; i < 3; i++) ta.onBridgeChange(); // 模拟连续 Prompt 变化（如逐键输入）
  await t.mock.timers.tick(399);
  assert.equal(requests.length, 1, "防抖窗口内不发起请求");
  await t.mock.timers.tick(1);
  assert.equal(requests.length, 2, "窗口结束后合并为一次刷新");
  await t.mock.timers.tick(500);
  assert.equal(requests.length, 2, "无更多变化则不重复请求");
});