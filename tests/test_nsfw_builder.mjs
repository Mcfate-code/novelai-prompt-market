/**
 * NSFW Scene Builder（Scene Composer，产品化）测试（static/nsfw-builder.js）。
 *
 * 覆盖（按任务包 TEST 要求）：
 *  1. assistant_context restore（唯一权威 + refresh 重新水合，无 this.selections）
 *  2. participant count（单个 SET_EXCLUSIVE_GROUP + SCENE_PROPOSAL）
 *  3. all-character clothing render（participant_count=3 -> 三个服装子组）
 *  4. C1 clothing replacement 不影响 C2
 *  5. position compatibility（minParticipants / requiresScenes；1 人隐藏）
 *  6. activity add/remove 对称 + 溯源（不删无溯源的用户同名 tag）
 *  7. strict group replacement（原子 SET_EXCLUSIVE_GROUP，NEW SELECTION WINS）
 *  8. adolescent mode（全禁用 + 零 dispatch + 只渲染禁用空态）
 *  9. recommend payload + 分组渲染 + 点击只 ADD_TAG
 *  + 保留纯函数测试（STAGE_KEYS / GROUP_KEYS / normalizeOption(s) /
 *    participantNumber / filterPositions / exclusiveMembers / build* actions /
 *    radioMoveIndex / isSelected / normalizeRecommendation(s) / dispatchAction）。
 *
 * 运行方式: node --test tests/test_nsfw_builder.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addTag, applyExclusiveGroup, createEmpty, setAssistantContext, removeTag, getTargetEntries,
} from "../static/prompt-document.js";
import {
  NsfwBuilder,
  STAGE_KEYS,
  STAGE_LABELS,
  GROUP_KEYS,
  DEFAULT_PARTICIPANTS,
  DEFAULT_STAGES,
  buildAddTagAction,
  buildContext,
  buildRecommendPayload,
  buildSetAssistantContextAction,
  buildSetExclusiveGroupAction,
  createNsfwBuilder,
  dispatchAction,
  exclusiveMembers,
  filterPositions,
  isSelected,
  normalizeOption,
  normalizeOptions,
  normalizePoseTemplates,
  normalizeRecommendation,
  normalizeRecommendations,
  optionVisibleForCount,
  participantNumber,
  positiveTagsFromDocument,
  radioMoveIndex,
} from "../static/nsfw-builder.js";

// 忠实桥：dispatch 直接调用 prompt-document.js 的真实实现（与 app.js dispatchPromptAction 同一份代码），
// SCENE_PROPOSAL 只记录、不修改 doc（由 Integrator 决定角色槽增删）。
const makeBridge = (initial = createEmpty(), target = "base") => {
  let doc = initial;
  const listeners = new Set();
  const dispatched = [];
  const bridge = {
    getDocument: () => doc,
    getActiveTarget: () => target,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    dispatch: (action) => {
      dispatched.push(action);
      const p = action.payload || {};
      if (action.type === "SET_EXCLUSIVE_GROUP") doc = applyExclusiveGroup(doc, p);
      else if (action.type === "SET_ASSISTANT_CONTEXT") doc = setAssistantContext(doc, p.context);
      else if (action.type === "ADD_TAG") doc = addTag(doc, p.target || target, { tag: p.tag, source: p.source, bundle_name: p.bundle_name }, p.section || "other");
      else if (action.type === "REMOVE_TAG") doc = removeTag(doc, p.target || target, p.entryId);
      // SCENE_PROPOSAL 无 doc 变更
      listeners.forEach((fn) => fn(doc, action));
    },
    dispatched,
  };
  return bridge;
};

// 注入真实候选（canonical tag 取自词库真实标签样例，仅测试数据）。
const OPTIONS = {
  participants: DEFAULT_PARTICIPANTS,
  scenes: [
    { key: "indoor", label: "室内", tag: "bedroom" },
    { key: "outdoor", label: "室外", tag: "outdoors" },
  ],
  stages: DEFAULT_STAGES,
  positions: [
    { key: "missionary", label: "传教士", tag: "missionary", minParticipants: 2 },
    { key: "standing", label: "站立", tag: "standing", minParticipants: 1 },
    { key: "threesome", label: "三人", tag: "threesome", minParticipants: 3, requiresScenes: ["indoor"] },
  ],
  clothingStates: [
    { key: "clothed", label: "穿衣", tag: "clothed" },
    { key: "nude", label: "全裸", tag: "nude" },
  ],
  activities: [
    { key: "kissing", label: "接吻", tag: "kissing" },
    { key: "handholding", label: "牵手" },
  ],
  bodyFocus: [{ key: "face", label: "面部" }, { key: "hands", label: "手部" }],
};

function minimalRoot() {
  let inner = "";
  return {
    _html: "",
    get innerHTML() { return inner; },
    set innerHTML(v) { inner = v; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
  };
}

// ---- 1. assistant_context restore（唯一权威 + refresh 重新水合） ----

test("assistant_context 是唯一权威：dispatch 后反映选择，refresh 重新水合（无存储副本）", async () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectExclusive("scene", "indoor");
  assert.equal(bridge.getDocument().assistant_context.primary_scene_type, "indoor");
  assert.ok(!("selections" in builder), "无 this.selections getter");
  // 外部直接改 assistant_context（模拟其他组件改动），refresh 应重新水合而非用组件内缓存
  bridge.getDocument().assistant_context.primary_scene_type = "outdoor";
  await builder.refresh();
  assert.equal(builder.context.primary_scene_type, "outdoor", "refresh 从 assistant_context 重新水合");
});

// ---- 2. participant count ----

test("participant count：单个 SET_EXCLUSIVE_GROUP(group=participant_count, newTag='') + SCENE_PROPOSAL", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  const ok = builder.selectParticipants("2");
  assert.equal(ok, true);
  const segs = bridge.dispatched.filter((a) => a.type === "SET_EXCLUSIVE_GROUP");
  assert.equal(segs.length, 1, "一次选择只 dispatch 一个 SET_EXCLUSIVE_GROUP");
  assert.equal(segs[0].payload.group, "participant_count");
  assert.equal(segs[0].payload.newTag, "");
  assert.equal(segs[0].payload.target, "base");
  assert.equal(bridge.getDocument().assistant_context.participant_count, "2");
  assert.ok(bridge.dispatched.some((a) => a.type === "SCENE_PROPOSAL" && a.payload.kind === "sync_participants" && a.payload.count === 2));
  assert.ok(!("selections" in builder));
});

test("participant 减少：尾部空角色 -> 允许并带 autoRemovableEmptyIndices；尾部非空 -> 阻止 + remove_characters_blocked", () => {
  // 3 人，全部空角色 -> 减到 1 允许
  let doc = setAssistantContext(createEmpty(), { participant_count: "3" });
  doc = applyExclusiveGroup(doc, { group: "participant_count", key: "3", newTag: "", target: "base", characterIndex: null, members: [] });
  doc.characters.push({ name: "Character 2", prompt_sections: {}, uc_sections: {}, position: null });
  doc.characters.push({ name: "Character 3", prompt_sections: {}, uc_sections: {}, position: null });
  const bridge1 = makeBridge(doc);
  const b1 = new NsfwBuilder({ bridge: bridge1, ...OPTIONS });
  assert.equal(b1.selectParticipants("1"), true);
  assert.equal(bridge1.getDocument().assistant_context.participant_count, "1");
  assert.ok(bridge1.dispatched.some((a) => a.type === "SCENE_PROPOSAL" && a.payload.kind === "sync_participants" && a.payload.count === 1 && Array.isArray(a.payload.autoRemovableEmptyIndices)));

  // 尾部角色含内容 -> 阻止
  let doc2 = setAssistantContext(createEmpty(), { participant_count: "3" });
  doc2.characters = [
    { name: "Character 1", prompt_sections: {}, uc_sections: {}, position: null },
    { name: "Character 2", prompt_sections: {}, uc_sections: {}, position: null },
    { name: "Character 3", prompt_sections: { action: [{ tag: "kissing" }] }, uc_sections: {}, position: null },
  ];
  const bridge2 = makeBridge(doc2);
  const b2 = new NsfwBuilder({ bridge: bridge2, ...OPTIONS });
  assert.equal(b2.selectParticipants("2"), false, "非空尾部角色阻止减少");
  assert.equal(bridge2.getDocument().assistant_context.participant_count, "3", "participant_count 不变");
  const blocked = bridge2.dispatched.find((a) => a.type === "SCENE_PROPOSAL" && a.payload.kind === "remove_characters_blocked");
  assert.ok(blocked, "发出 remove_characters_blocked 提议");
  assert.deepEqual(blocked.payload.blockedIndices, [2]);
});

// ---- 3. all-character clothing render ----

test("participant_count=3 时 render 同时渲染三个服装子组（角色 1/2/3 衣着，data-char 0/1/2）", () => {
  const doc = setAssistantContext(createEmpty(), { participant_count: "3" });
  const bridge = makeBridge(doc);
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge, ...OPTIONS });
  builder.render();
  const html = builder.root.innerHTML;
  assert.ok(html.includes("角色 1 衣着"));
  assert.ok(html.includes("角色 2 衣着"));
  assert.ok(html.includes("角色 3 衣着"));
  assert.ok(html.includes('data-char="0"'));
  assert.ok(html.includes('data-char="1"'));
  assert.ok(html.includes('data-char="2"'));
});

// ---- 4. C1 clothing replacement 不影响 C2 ----

test("clothing 按角色作用域：selectClothing(nude,0) 后 selectClothing(clothed,1) 互不影响", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectClothing("nude", 0);
  builder.selectClothing("clothed", 1);
  assert.deepEqual(bridge.getDocument().assistant_context.clothing_state, { 0: "nude", 1: "clothed" });
  const segs = bridge.dispatched.filter((a) => a.type === "SET_EXCLUSIVE_GROUP");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].payload.characterIndex, 0);
  assert.equal(segs[0].payload.target, "char:0");
  assert.equal(segs[0].payload.newTag, "nude");
  assert.equal(segs[1].payload.characterIndex, 1);
  assert.equal(segs[1].payload.target, "char:1");
  assert.equal(segs[1].payload.newTag, "clothed");
});

// ---- 5. position compatibility ----

test("position 过滤：minParticipants / requiresScenes；participant_count=1 时隐藏并提示", () => {
  const positions = normalizeOptions(OPTIONS.positions);
  assert.deepEqual(filterPositions(positions, { participantCount: "1" }).map((p) => p.key), ["standing"], "1 人排除 minParticipants>=2");
  assert.deepEqual(filterPositions(positions, { participantCount: "2" }).map((p) => p.key), ["missionary", "standing"]);
  assert.deepEqual(filterPositions(positions, { participantCount: "4+", sceneKey: "indoor" }).map((p) => p.key), ["missionary", "standing", "threesome"]);
  assert.deepEqual(filterPositions(positions, { participantCount: "4+", sceneKey: "outdoor" }).map((p) => p.key), ["missionary", "standing"], "outdoor 排除 threesome");

  const doc = setAssistantContext(createEmpty(), { participant_count: "1" });
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(doc), ...OPTIONS });
  builder.render();
  const html = builder.root.innerHTML;
  assert.ok(html.includes("选择多人以启用体位"));
  assert.ok(!html.includes('data-action="exclusive" data-group="position"'), "1 人时体位候选隐藏");
});

// ---- 6. activity add/remove 对称 + 溯源 ----

test("附加活动新增：context + ADD_TAG(source=scene_activity, bundle_name=scene-builder)", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.toggleActivity("kissing");
  assert.ok(bridge.getDocument().assistant_context.additional_activities.includes("kissing"));
  const addAction = bridge.dispatched.find((a) => a.type === "ADD_TAG");
  assert.ok(addAction, "带 tag 的活动新增走 ADD_TAG");
  assert.equal(addAction.payload.tag, "kissing");
  assert.equal(addAction.payload.source, "scene_activity");
  assert.equal(addAction.payload.bundle_name, "scene-builder");
});

test("附加活动取消：只移除自身溯源条目，不删无溯源的用户同名 tag", () => {
  let doc = createEmpty();
  doc = addTag(doc, "base", { tag: "kissing", source: "scene_activity", bundle_name: "scene-builder" }, "action"); // 组件自加（有溯源）
  doc = addTag(doc, "base", "kissing", "other"); // 用户自加（无溯源，不同分区 -> 不同 id）
  doc = setAssistantContext(doc, { additional_activities: ["kissing"] });
  const bridge = makeBridge(doc);
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.toggleActivity("kissing"); // 取消
  assert.ok(!bridge.getDocument().assistant_context.additional_activities.includes("kissing"));
  const removes = bridge.dispatched.filter((a) => a.type === "REMOVE_TAG");
  assert.equal(removes.length, 1, "只 dispatch 一个 REMOVE_TAG（自身溯源条目）");
  const remaining = getTargetEntries(bridge.getDocument(), "base").filter((e) => e.tag.toLowerCase() === "kissing");
  assert.equal(remaining.length, 1, "用户同名 tag 未被删除");
  assert.notEqual(remaining[0].source, "scene_activity");
  assert.notEqual(remaining[0].bundle_name, "scene-builder");
});

// ---- 7. strict group replacement ----

test("strict group replacement：两次同组选择 = 两个原子 SET_EXCLUSIVE_GROUP，NEW SELECTION WINS", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectExclusive("scene", "indoor");
  builder.selectExclusive("scene", "outdoor");
  const segs = bridge.dispatched.filter((a) => a.type === "SET_EXCLUSIVE_GROUP");
  assert.equal(segs.length, 2, "两次选择 = 两个原子 action，不自行拆分 REMOVE/ADD");
  assert.equal(segs[0].payload.newTag, "bedroom");
  assert.deepEqual(segs[0].payload.members, ["bedroom", "outdoors"]);
  assert.equal(segs[1].payload.key, "outdoor");
  assert.equal(segs[1].payload.newTag, "outdoors");
  assert.equal(bridge.getDocument().assistant_context.primary_scene_type, "outdoor", "NEW SELECTION WINS");
});

// ---- 8. adolescent mode ----

test("adolescent 模式：全禁用 + 零 dispatch + 只渲染禁用空态（无 data-action 控件）", async () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, adolescentMode: true, ...OPTIONS });
  assert.equal(builder.isDisabled(), true);
  assert.equal(builder.selectParticipants("2"), false);
  assert.equal(builder.selectExclusive("scene", "indoor"), false);
  assert.equal(builder.selectExclusive("stage", "MAIN_ACT"), false);
  assert.equal(builder.selectClothing("nude", 0), false);
  assert.equal(builder.selectBodyFocus("face"), false);
  assert.equal(builder.toggleActivity("kissing"), false);
  assert.equal(builder.applyRecommendation({ tag: "kissing" }), false);
  assert.equal(await builder.recommend(), false);
  assert.deepEqual(bridge.dispatched, [], "adolescent 下零 dispatch，不绕过内容策略");

  const root = minimalRoot();
  const b2 = new NsfwBuilder({ root, bridge: makeBridge(), adolescentMode: true, ...OPTIONS });
  b2.render();
  assert.match(root.innerHTML, /已禁用/);
  assert.ok(!root.innerHTML.includes("data-action="), "禁用态不渲染任何可操作控件");
});

test("adolescent 可通过 options.settings.adolescent_mode 注入；setAdolescentMode 可切换", () => {
  const viaSettings = new NsfwBuilder({ bridge: makeBridge(), settings: { adolescent_mode: true }, ...OPTIONS });
  assert.equal(viaSettings.isDisabled(), true);
  const adult = new NsfwBuilder({ bridge: makeBridge(), adolescentMode: false, ...OPTIONS });
  assert.equal(adult.isDisabled(), false);
  const builder = new NsfwBuilder({ bridge: makeBridge(), ...OPTIONS });
  assert.equal(builder.isDisabled(), false);
  builder.setAdolescentMode(true);
  assert.equal(builder.isDisabled(), true);
  builder.setAdolescentMode(false);
  assert.equal(builder.isDisabled(), false);
});

// ---- 9. recommend payload + 分组渲染 + 点击只 ADD_TAG ----

test("buildRecommendPayload 含 participant_count/primary_scene_type/stage/position/body_focus/additional_activities/clothing_state/tags/mode/target", () => {
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const ctx = buildContext({
    participants: "2", scene: "indoor", stage: "MAIN_ACT", position: "missionary", bodyFocus: "face",
    activities: ["kissing"], clothingState: { 0: "nude" }, mode: "adult",
  });
  const payload = buildRecommendPayload(ctx, doc, { target: "char:0" });
  for (const key of ["participant_count", "primary_scene_type", "stage", "position", "body_focus", "additional_activities", "clothing_state", "tags", "mode", "target"]) {
    assert.ok(key in payload, `payload 应含 ${key}`);
  }
  assert.equal(payload.tags[0], "1girl");
  assert.deepEqual(payload.clothing_state, { 0: "nude" });
});

test("点击推荐只 ADD_TAG 到 active target，不改变任何 strict group / stage", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  bridge.getActiveTarget = () => "char:0";
  builder.applyRecommendation({ tag: "kissing", section: "action" });
  assert.ok(bridge.dispatched.some((a) => a.type === "ADD_TAG" && a.payload.target === "char:0" && a.payload.tag === "kissing"));
  assert.ok(bridge.dispatched.every((a) => a.type !== "SET_EXCLUSIVE_GROUP"), "推荐点击不触发任何严格互斥替换");
});

test("推荐分组渲染：groups 返回时按 group 展示标题", async () => {
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const builder = new NsfwBuilder({
    root: minimalRoot(),
    bridge: makeBridge(doc),
    ...OPTIONS,
    recommend: async () => ({ groups: [{ group: "当前阶段", recommendations: [{ tag: "x" }] }, { group: "体位", recommendations: [{ tag: "y" }] }] }),
  });
  const recs = await builder.recommend();
  assert.equal(builder.view.groups.length, 2, "groups 按返回顺序归一");
  const html = builder.root.innerHTML;
  assert.ok(html.includes("nb-rec-group-title"));
  assert.ok(html.includes("当前阶段"));
  assert.ok(html.includes("体位"));
});

test("默认 recommend 走 POST /api/recommendations，失败置 error 空态", async () => {
  const urls = [];
  const builder = new NsfwBuilder({
    bridge: makeBridge(addTag(createEmpty(), "base", "1girl", "character")),
    ...OPTIONS,
    fetchImpl: async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ recommendations: [{ tag: "kissing" }] }) }; },
  });
  const recs = await builder.recommend();
  assert.deepEqual(urls, ["/api/recommendations"]);
  assert.equal(recs.length, 1);

  const failing = new NsfwBuilder({
    bridge: makeBridge(addTag(createEmpty(), "base", "1girl", "character")),
    ...OPTIONS,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  const recs2 = await failing.recommend();
  assert.deepEqual(recs2, []);
  assert.equal(failing.view.recStatus, "error");
  assert.match(failing.view.error, /500/);
});

// ---- 常量与选项归一化（纯函数，保留） ----

test("阶段枚举固定为 PREPARATION/FOREPLAY/MAIN_ACT/CLIMAX/AFTERMATH", () => {
  assert.deepEqual(STAGE_KEYS, ["PREPARATION", "FOREPLAY", "MAIN_ACT", "CLIMAX", "AFTERMATH"]);
  assert.equal(STAGE_LABELS.MAIN_ACT, "主戏");
  assert.equal(STAGE_KEYS.length, 5);
});

test("严格互斥组 key 对齐 Recommendation V2 / SET_EXCLUSIVE_GROUP 契约", () => {
  assert.deepEqual(GROUP_KEYS, {
    participants: "participant_count",
    scene: "primary_scene_type",
    stage: "stage",
    position: "position",
    clothing: "clothing_state",
  });
});

test("normalizeOption / normalizeOptions：key 唯一、tag 可选、位置过滤元数据保留", () => {
  const opt = normalizeOption({ key: "x", label: "X", tag: "canonical", minParticipants: 2, requiresScenes: ["indoor"], meta: { a: 1 } });
  assert.deepEqual(opt, {
    key: "x", label: "X", zh: "", tag: "canonical", minParticipants: 2,
    requiresScenes: ["indoor"], meta: { a: 1 },
  });
  assert.equal(normalizeOption(null), null);
  assert.equal(normalizeOption({}), null);
  assert.equal(normalizeOption({ label: "no-key" }), null, "无 key 拒绝");
  assert.deepEqual(normalizeOptions([{ key: "a" }, null, { key: "b", zh: "B" }]).map((o) => o.key), ["a", "b"]);
  assert.deepEqual(normalizeOptions(undefined), []);
});

test("已审核导入模板映射为可应用的多人姿势计划", () => {
  const list = normalizePoseTemplates([{ id: 7, label: "导入后方", structure: {
    participant_count: 2, base_tags: ["doggystyle"], camera_tags: ["from behind"],
    role_tags: [["on all fours"], ["standing"]],
    relations: [{ source: 0, target: 1, action: "sex", relation: "directional" }],
  }, source: { source_type: "civitai" } }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].minParticipants, 2);
  const bridge = makeBridge(setAssistantContext(createEmpty(), { participant_count: 2 }));
  const builder = new NsfwBuilder({ bridge, poseTemplates: list });
  builder.refresh();
  assert.equal(builder.applyPoseTemplate("imported-7"), true);
  const action = bridge.dispatched.find((item) => item.type === "APPLY_POSE_VARIATION");
  assert.equal(action.payload.plan.relations[0].source, 0);
  assert.deepEqual(action.payload.plan.roleTags, [["on all fours"], ["standing"]]);
});

test("模板库刷新会恢复待审核候选，并把后端旧版本转成可操作提示", async () => {
  const pending = { id: 8, status: "pending", label: "候选后方", structure: {
    participant_count: 2, base_tags: ["doggystyle"], camera_tags: ["from behind"],
    role_tags: [["on all fours"], ["standing"]], relations: [{ source: 0, target: 1, action: "sex" }],
    metrics: { tag_validity: 1, completeness: 0.8 },
  }, source: { source_type: "civitai", source_url: "https://civitai.com/images/8" } };
  const responses = async (url) => {
    if (url.endsWith("/api/runtime-info")) return { ok: true, status: 200, json: async () => ({ template_api_version: 1 }) };
    if (url.includes("status=approved")) return { ok: true, status: 200, json: async () => ({ templates: [] }) };
    return { ok: true, status: 200, json: async () => ({ templates: [pending] }) };
  };
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(), fetchImpl: responses });
  assert.equal(await builder.refreshTemplateLibrary(), true);
  assert.equal(builder.templateCandidates.length, 1);
  assert.match(builder.root.innerHTML, /候选后方/);
  assert.match(builder.root.innerHTML, /姿势\/动作/);

  const stale = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(), fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(await stale.refreshTemplateLibrary(), false);
  assert.equal(stale.templateApiStatus, "error");
  assert.match(stale.templateNotice, /后端服务版本过旧/);
});

test("participantNumber 映射 1–6，4+ 仍兼容为 4，非法 -> null", () => {
  assert.equal(participantNumber("1"), 1);
  assert.equal(participantNumber("3"), 3);
  assert.equal(participantNumber("4+"), 4);
  assert.equal(participantNumber("5"), 5);
  assert.equal(participantNumber("6"), 6);
  assert.equal(participantNumber(null), null);
  assert.equal(participantNumber(""), null);
  assert.equal(participantNumber("abc"), null);
});

test("exclusiveMembers 返回各组真实 canonical tag 成员", () => {
  assert.deepEqual(exclusiveMembers(GROUP_KEYS.participants, OPTIONS), []);
  assert.deepEqual(exclusiveMembers(GROUP_KEYS.scene, OPTIONS), ["bedroom", "outdoors"]);
  assert.deepEqual(exclusiveMembers(GROUP_KEYS.stage, OPTIONS), [], "stage 语义标识非 canonical tag");
  assert.deepEqual(exclusiveMembers(GROUP_KEYS.position, OPTIONS), ["missionary", "standing", "threesome"]);
  assert.deepEqual(exclusiveMembers(GROUP_KEYS.clothing, OPTIONS), ["clothed", "nude"]);
  assert.deepEqual(exclusiveMembers("bogus", OPTIONS), []);
});

test("buildSetExclusiveGroupAction 产出与契约一致的 payload", () => {
  assert.deepEqual(
    buildSetExclusiveGroupAction({ group: "clothing_state", key: "nude", newTag: "nude", target: "char:0", characterIndex: 0, members: ["clothed", "nude"] }),
    { type: "SET_EXCLUSIVE_GROUP", payload: { group: "clothing_state", key: "nude", newTag: "nude", target: "char:0", characterIndex: 0, members: ["clothed", "nude"] } },
  );
  const bare = buildSetExclusiveGroupAction({ group: "stage", key: "MAIN_ACT" });
  assert.deepEqual(bare.payload, { group: "stage", key: "MAIN_ACT", newTag: "", target: "", characterIndex: null, members: [] });
});

test("buildContext 输出 Recommendation V2 形状，且 metadata 与 tags 分离", () => {
  const ctx = buildContext({
    participants: "4+", scene: "indoor", stage: "MAIN_ACT", position: "missionary",
    bodyFocus: "face", activities: ["kissing"], clothingState: { 0: "nude", 1: "clothed" },
  });
  assert.deepEqual(ctx, {
    mode: "nsfw",
    participant_count: 4,
    primary_scene_type: "indoor",
    stage: "MAIN_ACT",
    position: "missionary",
    body_focus: "face",
    additional_activities: ["kissing"],
    clothing_state: { 0: "nude", 1: "clothed" },
  });
  assert.ok(!("tags" in ctx), "context 不含 tags —— 上下文不直接编译成 Prompt tags");
});

test("buildSetAssistantContextAction 产出 { type, payload:{ context } }", () => {
  const ctx = { mode: "nsfw", stage: "MAIN_ACT" };
  assert.deepEqual(buildSetAssistantContextAction(ctx), { type: "SET_ASSISTANT_CONTEXT", payload: { context: ctx } });
  assert.deepEqual(buildSetAssistantContextAction(null), { type: "SET_ASSISTANT_CONTEXT", payload: { context: {} } });
});

test("radioMoveIndex / isSelected / optionVisibleForCount / normalizeRecommendation(s) / dispatchAction", () => {
  assert.equal(radioMoveIndex(0, 1, 3), 1);
  assert.equal(radioMoveIndex(2, 1, 3), 0);
  assert.equal(radioMoveIndex(-1, -1, 3), 2);
  assert.equal(radioMoveIndex(0, 1, 0), -1);
  assert.equal(isSelected("MAIN_ACT", "MAIN_ACT"), true);
  assert.equal(isSelected(null, "x"), false);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, "1"), false);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, "2"), true);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, null), true);
  assert.deepEqual(normalizeRecommendation({ tag: "kissing", zh: "接吻" }), { tag: "kissing", canonical: "kissing", zh: "接吻", reason: "", section: "" });
  assert.equal(normalizeRecommendation(null), null);
  assert.deepEqual(normalizeRecommendations({ recommendations: [{ tag: "a" }, { tag: "" }] }).map((r) => r.tag), ["a"]);
  assert.deepEqual(normalizeRecommendations(null), []);
  assert.equal(dispatchAction(null, buildAddTagAction("x", "base")), false);
  assert.equal(dispatchAction({}, buildAddTagAction("x", "base")), false);
  const broken = { dispatch: () => { throw new Error("boom"); } };
  assert.equal(dispatchAction(broken, buildAddTagAction("x", "base")), false);
  const ok = { dispatch: (a) => { assert.equal(a.type, "ADD_TAG"); } };
  assert.equal(dispatchAction(ok, buildAddTagAction("x", "base")), true);
});

test("positiveTagsFromDocument 提取 base + 各角色 positive 标签（UC 不参与）", () => {
  let doc = addTag(createEmpty(), "base", "1girl", "character");
  doc = addTag(doc, "char:0", "blue eyes", "appearance");
  doc = addTag(doc, "char:0:uc", "bad hands", "other");
  assert.deepEqual(positiveTagsFromDocument(doc), ["1girl", "blue eyes"]);
});

test("createNsfwBuilder 返回 NsfwBuilder 实例", () => {
  const builder = createNsfwBuilder({ bridge: makeBridge(), ...OPTIONS });
  assert.ok(builder instanceof NsfwBuilder);
});

// ---- 10. Phase 7：简化 Scene Composer 信息架构 ----

test("Phase7：移除「主场景」块，dashboard 锚点映射到真实 section id", () => {
  const doc = setAssistantContext(createEmpty(), { participant_count: "2" });
  const fullOptions = {
    ...OPTIONS,
    primaryActs: [{ key: "kiss", label: "接吻", tag: "kissing" }],
    environments: [{ key: "night", label: "夜晚", tag: "night" }],
    compositions: [{ key: "close_up", label: "特写", tag: "close-up" }],
  };
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(doc), ...fullOptions });
  builder.render();
  const html = builder.root.innerHTML;
  assert.ok(!html.includes("主场景"), "主场景块不再渲染");
  assert.ok(html.includes("环境 / 情境"), "环境/情境保留");
  for (const id of ["nb-人物", "nb-主要行为", "nb-互动关系", "nb-阶段体位", "nb-角色状态", "nb-镜头环境"]) {
    assert.ok(html.includes(`id="${id}"`), `存在 section id=${id}`);
    assert.ok(html.includes(`href="#${id}"`), `dashboard 锚点 href=#${id}`);
  }
});

test("Phase7：互动按钮标签随当前 actor/target 选择变化", () => {
  const doc = setAssistantContext(createEmpty(), { participant_count: "2" });
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(doc), ...OPTIONS, interactionActions: [{ key: "kissing", label: "接吻", tag: "kissing" }] });
  builder.render();
  assert.ok(builder.root.innerHTML.includes("互动：角色 1 → 角色 2"), "默认 actor=0,target=1 → 角色 1 → 角色 2");
  builder.interactionDraft = { actor: 1, target: 0, relation: "mutual" };
  builder.render();
  assert.ok(builder.root.innerHTML.includes("互动：角色 2 → 角色 1"), "draft 改变后标签反映当前选择");
  assert.ok(!builder.root.innerHTML.includes("互动：角色 1 → 角色 2"), "不再显示旧的固定标签");
});

test("Phase7：环境/情境选择写入 Base（route → primary_scene_type / section=scene）", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS, environments: [{ key: "night", label: "夜晚", tag: "night" }] });
  builder.selectExclusive("scene", "night");
  const seg = bridge.dispatched.find((a) => a.type === "SET_EXCLUSIVE_GROUP");
  assert.equal(seg.payload.group, "primary_scene_type");
  assert.equal(seg.payload.newTag, "night", "环境 tag 解析（不再是空 newTag）");
  assert.equal(seg.payload.target, "base");
  assert.ok(seg.payload.members.includes("night"), "members 含环境 tag（原子删除旧条目用）");
  assert.equal(bridge.getDocument().assistant_context.primary_scene_type, "night");
});
