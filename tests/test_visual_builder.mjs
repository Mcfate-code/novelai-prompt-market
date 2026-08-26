/**
 * Visual Prompt Builder 独立组件测试（static/visual-builder.js）。
 * 覆盖纯函数（chip 文案 / 权重步进 / 工作区划分 / 语义卡片）、全部 dispatch 路径、
 * 「无第二份 Prompt 权威状态」与 Base/Character 隔离。
 * 组件为纯模块（无 DOM 依赖），可直接在 Node 中 import 真实实现。
 *
 * 运行方式: node --test tests/test_visual_builder.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addCharacter, addTag, createEmpty } from "../static/prompt-document.js";
import {
  VisualBuilder,
  WEIGHT_STEP,
  MIN_WEIGHT,
  adjustWeight,
  buildAddCharacterAction,
  buildAddTagAction,
  buildMoveSectionAction,
  buildRemoveCharacterAction,
  buildRemoveTagAction,
  buildRenameCharacterAction,
  buildSetWeightAction,
  buildWorkspaceChips,
  chipLabel,
  dispatchAction,
  groupEntriesBySection,
  normalizeSemanticNode,
  semanticCards,
  trimWeight,
  workspaceForTarget,
  workspaceTabs,
} from "../static/visual-builder.js";

const makeBridge = (doc = createEmpty(), target = "base") => ({
  getDocument: () => doc,
  getActiveTarget: () => target,
  subscribe: () => () => {},
  dispatch: () => {},
});

// 语义树样例：base 缺 quality 节点（与 config/prompt_navigation.json 现状一致），character 齐全。
const TREE = {
  base: {
    id: "base", label: "Base",
    children: [
      { id: "base_style", label: "Style", zh: "风格", target: "base", section: "style", seed_tags: ["masterpiece"], children: [] },
      { id: "base_environment", label: "Environment", zh: "环境", target: "base", section: "scene", seed_tags: ["indoors"], children: [
        { id: "env_indoor", label: "Indoor", zh: "室内", target: "base", section: "scene", seed_tags: ["bedroom", "cafe"], children: [] },
      ] },
    ],
  },
  character: {
    id: "character", label: "Character",
    children: [
      { id: "char_appearance", label: "Appearance", zh: "外观", target: "character", section: "appearance", seed_tags: ["long hair"], children: [
        { id: "char_hair", label: "Hair", zh: "头发", target: "character", section: "appearance", seed_tags: ["long hair", "ponytail"], children: [] },
      ] },
    ],
  },
};

// ---- chip 文案与权重步进 ----

test("chipLabel: weight=1 简洁显示 tag，非 1 显示 `tag · weight`", () => {
  assert.equal(chipLabel({ tag: "blue eyes", weight: 1 }), "blue eyes");
  assert.equal(chipLabel({ tag: "blue eyes", weight: 1.3 }), "blue eyes · 1.3");
  assert.equal(chipLabel({ tag: "blue eyes", weight: 0.8 }), "blue eyes · 0.8");
  assert.equal(chipLabel({ tag: "blue eyes" }), "blue eyes", "缺省 weight 视为 1");
  assert.equal(chipLabel({ weight: 1.3 }), "", "空 tag 返回空");
  assert.equal(chipLabel(null), "");
});

test("trimWeight 保留两位精度并去尾零，非法值回退 1", () => {
  assert.equal(trimWeight(1.3), "1.3");
  assert.equal(trimWeight(1.3000000001), "1.3");
  assert.equal(trimWeight(1.05), "1.05");
  assert.equal(trimWeight(0.8), "0.8");
  assert.equal(trimWeight("2.5"), "2.5");
  assert.equal(trimWeight(undefined), "1");
  assert.equal(trimWeight("abc"), "1");
});

test("adjustWeight 按 ±0.05 步进，夹在最小权重之上且不 NaN", () => {
  assert.equal(adjustWeight(1, WEIGHT_STEP), 1.05);
  assert.equal(adjustWeight(1.05, -WEIGHT_STEP), 1);
  assert.equal(adjustWeight(0.12, -WEIGHT_STEP), MIN_WEIGHT, "低于 MIN_WEIGHT 被夹住");
  assert.equal(adjustWeight(0.05, 0), MIN_WEIGHT);
  assert.equal(adjustWeight("abc", 0), MIN_WEIGHT, "非法输入回退 MIN_WEIGHT");
  assert.equal(adjustWeight(1, 0), 1);
});

// ---- 工作区划分与 tabs ----

test("workspaceForTarget: base/global_uc 归 Base，char:N(:uc) 归 char:N，未知为空", () => {
  assert.equal(workspaceForTarget("base"), "base");
  assert.equal(workspaceForTarget("global_uc"), "base");
  assert.equal(workspaceForTarget("char:0"), "char:0");
  assert.equal(workspaceForTarget("char:2:uc"), "char:2");
  assert.equal(workspaceForTarget(""), "");
  assert.equal(workspaceForTarget(undefined), "");
  assert.equal(workspaceForTarget("bogus"), "");
});

test("workspaceTabs: Base + 每角色（缺省名 Character N）", () => {
  let doc = createEmpty();
  doc = addCharacter(doc, { name: "Citlali" });
  const tabs = workspaceTabs(doc);
  assert.deepEqual(tabs.map((t) => t.key), ["base", "char:0", "char:1"]);
  assert.equal(tabs[0].label, "Base");
  assert.equal(tabs[1].label, "Character 1");
  assert.equal(tabs[2].label, "Citlali");
  assert.equal(workspaceTabs(null).length, 1, "缺省仍含 Base");
});

// ---- 工作区 chip 分组（Base/Character 不串） ----

test("buildWorkspaceChips: Base 工作区只含 base + global_uc，不含角色条目", () => {
  let doc = addTag(createEmpty(), "base", "blue eyes", "appearance");
  doc = addTag(doc, "global_uc", "lowres", "other");
  doc = addTag(doc, "char:0", "1girl", "character");
  const chips = buildWorkspaceChips(doc, "base");
  assert.equal(chips.prompt.length, 1);
  assert.equal(chips.prompt[0].section, "appearance");
  assert.equal(chips.prompt[0].entries[0].display, "blue eyes");
  assert.equal(chips.prompt[0].entries[0].target, "base");
  assert.equal(chips.uc[0].section, "other");
  assert.equal(chips.uc[0].entries[0].tag, "lowres");
  assert.equal(chips.uc[0].entries[0].target, "global_uc");
  const flat = chips.prompt.flatMap((g) => g.entries).map((e) => e.tag);
  assert.ok(!flat.includes("1girl"), "Base 工作区不显示角色标签");
});

test("buildWorkspaceChips: Character 工作区只含 char:N + char:N:uc，并按分区分组", () => {
  let doc = addTag(createEmpty(), "char:0", "1girl", "character");
  doc = addTag(doc, "char:0", { tag: "white shirt", weight: 1.3 }, "clothing");
  doc = addTag(doc, "char:0:uc", "bad anatomy", "other");
  doc = addTag(doc, "base", "bedroom", "scene");
  const chips = buildWorkspaceChips(doc, "char:0");
  assert.deepEqual(chips.prompt.map((g) => g.section), ["character", "clothing"], "按固定分区顺序");
  assert.equal(chips.prompt[1].entries[0].display, "white shirt · 1.3");
  assert.equal(chips.prompt[1].entries[0].target, "char:0");
  assert.equal(chips.uc[0].entries[0].tag, "bad anatomy");
  assert.equal(chips.uc[0].entries[0].target, "char:0:uc");
  const flat = chips.prompt.flatMap((g) => g.entries).map((e) => e.tag);
  assert.ok(!flat.includes("bedroom"), "Character 工作区不显示 Base 标签");
  assert.equal(buildWorkspaceChips(doc, "char:9"), null, "不存在角色返回 null");
  assert.equal(buildWorkspaceChips(doc, ""), null);
});

test("groupEntriesBySection 过滤空 tag，保持分区顺序", () => {
  const groups = groupEntriesBySection(
    [{ tag: "", section: "other" }, { tag: "smile", section: "expression" }, { tag: "solo", section: "character", weight: 1.2 }],
    "char:0",
  );
  assert.deepEqual(groups.map((g) => g.section), ["character", "expression"]);
  assert.equal(groups[0].entries[0].display, "solo · 1.2");
  assert.equal(groups[0].target, "char:0");
});

// ---- 语义卡片（来自导航树 + Quality 兜底） ----

test("semanticCards: Base 工作区卡片来自 tree.base.children，并注入 Quality 兜底", () => {
  const cards = semanticCards(TREE, "base");
  assert.deepEqual(cards.map((c) => c.id), ["base_style", "base_environment", "base_quality"]);
  assert.equal(cards[2].label, "Quality");
  assert.equal(cards[2].section, "quality");
  assert.deepEqual(cards[2].seedTags, ["masterpiece", "best quality", "highres", "absurdres"]);
  assert.equal(cards[1].children[0].id, "env_indoor", "子节点递归保留");
  assert.equal(cards[1].children[0].seedTags[0], "bedroom");
});

test("semanticCards: Character 工作区用 tree.character.children，不注入 Quality", () => {
  const cards = semanticCards(TREE, "char:0");
  assert.deepEqual(cards.map((c) => c.id), ["char_appearance"]);
  assert.equal(cards[0].children[0].id, "char_hair");
  assert.equal(cards.some((c) => c.section === "quality"), false);
});

test("semanticCards: 树缺 base/character 时分别回退空数组；已有 quality 节点不重复注入", () => {
  assert.deepEqual(semanticCards(null, "base"), []);
  assert.deepEqual(semanticCards({}, "char:0"), []);
  const treeWithQuality = {
    base: { id: "base", children: [{ id: "q", label: "Q", section: "quality", seed_tags: ["highres"], children: [] }] },
  };
  const cards = semanticCards(treeWithQuality, "base");
  assert.equal(cards.length, 1, "后端自带 quality 节点时不注入兜底");
  assert.equal(cards[0].id, "q");
});

test("normalizeSemanticNode 归一化节点字段，非法输入返回 null", () => {
  const node = normalizeSemanticNode({ id: "x", label: "X", zh: "中文", section: "scene", seed_tags: ["a", "b"] });
  assert.deepEqual(node, { id: "x", label: "X", zh: "中文", section: "scene", target: "", seedTags: ["a", "b"], children: [] });
  assert.equal(normalizeSemanticNode(null), null);
  assert.equal(normalizeSemanticNode({}), null);
  assert.equal(normalizeSemanticNode({ id: "x", seed_tags: "not-array" }).seedTags.length, 0);
});

// ---- Action 构建契约 ----

test("action builders 产出与 PromptBridge 契约一致的 payload", () => {
  assert.deepEqual(buildAddTagAction("bedroom", "base", "scene"), { type: "ADD_TAG", payload: { tag: "bedroom", target: "base", section: "scene" } });
  assert.deepEqual(buildAddTagAction("solo", "char:0"), { type: "ADD_TAG", payload: { tag: "solo", target: "char:0" } });
  assert.deepEqual(buildAddTagAction("x", "base", "", 1.3), { type: "ADD_TAG", payload: { tag: "x", target: "base", weight: 1.3 } });
  assert.deepEqual(buildRemoveTagAction("base", "id-1"), { type: "REMOVE_TAG", payload: { target: "base", entryId: "id-1" } });
  assert.deepEqual(buildSetWeightAction("char:0", "id-2", 1.25), { type: "SET_WEIGHT", payload: { target: "char:0", entryId: "id-2", weight: 1.25 } });
  assert.deepEqual(buildMoveSectionAction("base", "id-3", "scene"), { type: "MOVE_SECTION", payload: { target: "base", entryId: "id-3", section: "scene" } });
  assert.deepEqual(buildAddCharacterAction(), { type: "ADD_CHARACTER", payload: {} });
  assert.deepEqual(buildAddCharacterAction("Citlali"), { type: "ADD_CHARACTER", payload: { name: "Citlali" } });
  assert.deepEqual(buildRemoveCharacterAction(1), { type: "REMOVE_CHARACTER", payload: { index: 1 } });
  assert.deepEqual(buildRenameCharacterAction(0, "Mavuika"), { type: "RENAME_CHARACTER", payload: { index: 0, name: "Mavuika" } });
});

test("dispatchAction 无桥 / 无 dispatch / 抛错均返回 false 不抛出", () => {
  assert.equal(dispatchAction(null, buildAddTagAction("x", "base")), false);
  assert.equal(dispatchAction({}, buildAddTagAction("x", "base")), false);
  const broken = { dispatch: () => { throw new Error("boom"); } };
  assert.equal(dispatchAction(broken, buildAddTagAction("x", "base")), false);
  const ok = { dispatch: (a) => { assert.equal(a.type, "ADD_TAG"); } };
  assert.equal(dispatchAction(ok, buildAddTagAction("x", "base")), true);
});

// ---- 组件 dispatch 路径 ----

test("addTag 只 dispatch ADD_TAG 到当前 active target（不读 window.state）", () => {
  const dispatched = [];
  const bridge = { ...makeBridge(), getActiveTarget: () => "char:0", dispatch: (a) => dispatched.push(a) };
  const builder = new VisualBuilder({ bridge });
  assert.equal(builder.addTag("bedroom", "scene"), true);
  assert.deepEqual(dispatched, [{ type: "ADD_TAG", payload: { tag: "bedroom", target: "char:0", section: "scene" } }]);
  assert.equal(builder.addTag("solo", ""), true);
  assert.deepEqual(dispatched[1], { type: "ADD_TAG", payload: { tag: "solo", target: "char:0" } });
});

test("chip 编辑路径 dispatch REMOVE_TAG / SET_WEIGHT / MOVE_SECTION，target 为 chip 所属目标", () => {
  const dispatched = [];
  const bridge = { ...makeBridge(), dispatch: (a) => dispatched.push(a) };
  const builder = new VisualBuilder({ bridge });
  assert.equal(builder.removeChip("base", "id-1"), true);
  assert.equal(builder.setChipWeight("char:0:uc", "id-2", 1.15), true);
  assert.equal(builder.moveChipSection("base", "id-3", "scene"), true);
  assert.deepEqual(dispatched[0], { type: "REMOVE_TAG", payload: { target: "base", entryId: "id-1" } });
  assert.deepEqual(dispatched[1], { type: "SET_WEIGHT", payload: { target: "char:0:uc", entryId: "id-2", weight: 1.15 } });
  assert.deepEqual(dispatched[2], { type: "MOVE_SECTION", payload: { target: "base", entryId: "id-3", section: "scene" } });
});

test("角色增删改名按 action：ADD_CHARACTER / REMOVE_CHARACTER / RENAME_CHARACTER", () => {
  const dispatched = [];
  const bridge = { ...makeBridge(), dispatch: (a) => dispatched.push(a) };
  const builder = new VisualBuilder({ bridge });
  assert.equal(builder.addCharacter(), true);
  assert.equal(builder.removeCharacter(1), true);
  assert.equal(builder.renameCharacter(0, "Citlali"), true);
  assert.deepEqual(dispatched, [
    { type: "ADD_CHARACTER", payload: {} },
    { type: "REMOVE_CHARACTER", payload: { index: 1 } },
    { type: "RENAME_CHARACTER", payload: { index: 0, name: "Citlali" } },
  ]);
});

test("无桥时所有编辑方法返回 false，不崩溃", () => {
  const builder = new VisualBuilder({});
  assert.equal(builder.addTag("x", "scene"), false);
  assert.equal(builder.removeChip("base", "id"), false);
  assert.equal(builder.setChipWeight("base", "id", 1.1), false);
  assert.equal(builder.moveChipSection("base", "id", "scene"), false);
  assert.equal(builder.addCharacter(), false);
  assert.equal(builder.removeCharacter(0), false);
  assert.equal(builder.renameCharacter(0, "x"), false);
});

// ---- 无第二份 Prompt 权威状态 + subscribe 回流 ----

test("实例不保存 PromptDocument 副本，每次 refresh 都从桥按需读取", async () => {
  let calls = 0;
  const doc = addTag(createEmpty(), "base", "solo", "character");
  const bridge = { ...makeBridge(doc), getDocument: () => { calls += 1; return doc; } };
  const builder = new VisualBuilder({ bridge });
  await builder.refresh();
  await builder.refresh();
  assert.equal(calls, 2, "每次刷新重新读取 PromptBridge");
  assert.equal("doc" in builder, false, "实例不保存 doc 副本");
  assert.equal(builder.view.status, "ok");
  assert.equal(builder.view.workspace, "base");
});

test("subscribe -> onBridgeChange 触发 refresh 并重读文档（Text/Visual 一致）", async () => {
  const listeners = [];
  const doc = addTag(createEmpty(), "base", "solo", "character");
  const bridge = {
    getDocument: () => doc,
    getActiveTarget: () => "base",
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    dispatch: () => {},
  };
  const builder = new VisualBuilder({ bridge });
  builder.mount();
  assert.equal(listeners.length, 1, "mount 时订阅");
  let reads = 0;
  bridge.getDocument = () => { reads += 1; return doc; };
  listeners[0](); // 模拟外部 dispatch 后的桥回调
  assert.equal(reads, 1, "桥变化后按需重读文档");
  assert.equal(builder.view.status, "ok");
  builder.destroy();
});

// ---- 工作区跟随与手动选择 ----

test("view 工作区跟随 active target；手动选择后保持，active target 换工作区时重新跟随", async () => {
  let target = "char:0";
  const doc = addTag(addCharacter(createEmpty(), { name: "Citlali" }), "base", "bedroom", "scene");
  const bridge = { ...makeBridge(doc, target), getActiveTarget: () => target, dispatch: () => {} };
  const builder = new VisualBuilder({ bridge });
  await builder.refresh();
  assert.equal(builder.view.workspace, "char:0", "跟随 active target");

  assert.equal(builder.activeTarget(), "char:0");

  target = "char:1"; // 外部切换目标到另一个角色工作区
  await builder.refresh();
  assert.equal(builder.view.workspace, "char:1", "active target 换工作区时重新跟随");
});

test("Base/Character 不串：查看 Base 工作区时新增标签仍写入 active target（char:0）", async () => {
  const dispatched = [];
  const doc = addTag(createEmpty(), "base", "bedroom", "scene");
  const bridge = { ...makeBridge(doc), getActiveTarget: () => "char:0", dispatch: (a) => dispatched.push(a) };
  const builder = new VisualBuilder({ bridge });
  await builder.refresh();
  assert.equal(builder.addTag("sunlight", "scene"), true);
  assert.deepEqual(dispatched[0], { type: "ADD_TAG", payload: { tag: "sunlight", target: "char:0", section: "scene" } });
});

// ---- 无桥 / 无文档空态 ----

test("无 PromptBridge 时 refresh 置可见空态，不崩溃", async () => {
  const builder = new VisualBuilder({});
  await builder.refresh();
  assert.equal(builder.view.status, "empty");
  assert.match(builder.view.message, /PromptBridge/);
  const noDoc = new VisualBuilder({ bridge: { getDocument: () => null, getActiveTarget: () => "base", subscribe: () => () => {}, dispatch: () => {} } });
  await noDoc.refresh();
  assert.equal(noDoc.view.status, "empty");
  assert.match(noDoc.view.message, /PromptDocument/);
});

// ---- 语义树加载与节点下钻 ----

test("reloadTree 加载语义树并保留 view 数据；接口失败置 error 空态", async () => {
  const calls = [];
  const builder = new VisualBuilder({
    bridge: makeBridge(addTag(createEmpty(), "base", "solo", "character"), "base"),
    fetchImpl: async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ tree: TREE }) }; },
  });
  await builder.reloadTree();
  assert.deepEqual(calls, ["/api/catalog/semantic"]);
  assert.equal(builder.view.status, "ok");
  assert.equal(builder.view.cards.length, 3, "Base 卡片含 Quality 兜底");
  assert.equal(builder.view.cards[1].children[0].id, "env_indoor");

  const failing = new VisualBuilder({
    bridge: makeBridge(),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  await failing.reloadTree();
  assert.equal(failing.view.status, "error");
  assert.match(failing.view.error, /500/);
});

test("selectNode 下钻单节点刷新 seed tags（node_id 请求），失败不覆盖旧数据", async () => {
  const urls = [];
  const builder = new VisualBuilder({
    bridge: makeBridge(),
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("node_id=env_indoor")) {
        return { ok: true, status: 200, json: async () => ({ node: { id: "env_indoor", label: "Indoor", zh: "室内", section: "scene", seed_tags: ["bedroom", "cafe", "window"], children: [] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ tree: TREE }) };
    },
  });
  await builder.reloadTree();
  await builder.selectNode("env_indoor");
  assert.ok(urls.some((u) => u.includes("/api/catalog/semantic?node_id=env_indoor")));
  assert.equal(builder.view.activeNodeId, "env_indoor");
  assert.deepEqual(builder.view.nodeById.env_indoor.seedTags, ["bedroom", "cafe", "window"]);

  const failing = new VisualBuilder({
    bridge: makeBridge(),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  failing.view.tree = TREE;
  await failing.selectNode("env_indoor");
  assert.equal(failing.view.nodeStatus, "error", "下钻失败置 nodeStatus=error，卡片旧数据保留");
  assert.deepEqual(failing.view.nodeById.env_indoor, undefined);
});

test("V2 hard regressions: active Character 2 Visual add only dispatches to char:1", () => {
  const dispatched = []; const bridge = makeBridge(addCharacter(createEmpty(), { name: "C2" }), "char:1");
  bridge.dispatch = (action) => dispatched.push(action);
  const builder = new VisualBuilder({ bridge });
  assert.equal(builder.addTag("blue eyes", "appearance"), true);
  assert.equal(dispatched[0].payload.target, "char:1");
  assert.equal(builder.view.workspace, "char:1");
});
