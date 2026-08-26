/**
 * NSFW Scene Builder（Phase 2 独立前端组件）测试（static/nsfw-builder.js）。
 *
 * 覆盖（按任务包 TEST 要求）：
 *   - adolescent disabled state
 *   - participants
 *   - primary replacement action（strict exclusive group -> SET_EXCLUSIVE_GROUP）
 *   - stage
 *   - additional multi-select
 *   - position filtering
 *   - per-character clothing isolation
 *   - context payload（SET_ASSISTANT_CONTEXT / assistant_context 不泄漏为 tags）
 *   - recommend dispatch（只 ADD_TAG，不自动改 stage）
 *   - no second prompt state
 *   - no auto stage progression
 *   - ARIA / keyboard helpers
 *
 * 运行方式: node --test tests/test_nsfw_builder.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addTag, createEmpty, setAssistantContext, removeTag, getTargetEntries } from "../static/prompt-document.js";
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
  normalizeRecommendation,
  normalizeRecommendations,
  optionVisibleForCount,
  participantNumber,
  positiveTagsFromDocument,
  radioMoveIndex,
} from "../static/nsfw-builder.js";

const makeBridge = (initial = createEmpty(), target = "base") => {
  let doc = initial; const listeners = new Set();
  const bridge = {
    getDocument: () => doc, getActiveTarget: () => target, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    dispatch: (action) => {
      const p = action.payload || {};
      if (action.type === "SET_ASSISTANT_CONTEXT") doc = setAssistantContext(doc, p.context);
      if (action.type === "ADD_TAG") doc = addTag(doc, p.target || target, { tag: p.tag, section: p.section || "other" }, p.section || "other");
      if (action.type === "REMOVE_TAG") doc = removeTag(doc, p.target || target, p.entryId);
      if (action.type === "SET_EXCLUSIVE_GROUP") {
        const current = getTargetEntries(doc, p.group === "clothing_state" ? `char:${p.characterIndex ?? 0}` : "base");
        current.filter((e) => (p.members || []).map(String).map((x) => x.toLowerCase()).includes(String(e.tag).toLowerCase())).forEach((e) => { doc = removeTag(doc, e.target || (p.group === "clothing_state" ? `char:${p.characterIndex ?? 0}` : "base"), e.id); });
        const contextKey = p.group === "participant_count" ? "participant_count" : p.group === "primary_scene_type" ? "primary_scene_type" : p.group;
        if (p.group === "clothing_state") doc = setAssistantContext(doc, { clothing_state: { ...(doc.assistant_context.clothing_state || {}), [p.characterIndex ?? 0]: p.key } });
        else doc = setAssistantContext(doc, { [contextKey]: p.key === "4+" ? 4 : p.key });
      }
      listeners.forEach((fn) => fn(doc, action));
    },
  }; return bridge;
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

// ---- 常量与选项归一化 ----

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

// ---- adolescent disabled state ----

test("adolescent 模式下组件整体禁用：isDisabled=true，且不 dispatch 任何 action", () => {
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ bridge, adolescentMode: true, ...OPTIONS });
  assert.equal(builder.isDisabled(), true, "adolescentMode=true -> disabled");
  assert.equal(builder.selectExclusive("participants", "2"), false);
  assert.equal(builder.selectExclusive("stage", "MAIN_ACT"), false);
  assert.equal(builder.selectExclusive("position", "missionary"), false);
  assert.equal(builder.selectExclusive("clothing", "nude"), false);
  assert.equal(builder.selectBodyFocus("face"), false);
  assert.equal(builder.toggleActivity("kissing"), false);
  assert.equal(builder.applyRecommendation({ tag: "kissing" }), false);
  assert.deepEqual(dispatched, [], "adolescent 下零 dispatch，不绕过内容策略");
});

test("adolescent 可通过 options.settings.adolescent_mode 注入；非 adolescent 才启用", () => {
  const viaSettings = new NsfwBuilder({ bridge: makeBridge(), settings: { adolescent_mode: true }, ...OPTIONS });
  assert.equal(viaSettings.isDisabled(), true);
  const adult = new NsfwBuilder({ bridge: makeBridge(), adolescentMode: false, ...OPTIONS });
  assert.equal(adult.isDisabled(), false, "成人模式启用");
  const unspecified = new NsfwBuilder({ bridge: makeBridge(), ...OPTIONS });
  assert.equal(unspecified.isDisabled(), false, "缺省按已启用成人处理（集成方必须注入后端 settings）");
});

test("setAdolescentMode 可运行时切换禁用状态", () => {
  const builder = new NsfwBuilder({ bridge: makeBridge(), adolescentMode: false, ...OPTIONS });
  assert.equal(builder.isDisabled(), false);
  builder.setAdolescentMode(true);
  assert.equal(builder.isDisabled(), true);
  builder.setAdolescentMode(false);
  assert.equal(builder.isDisabled(), false);
});

// ---- participants ----

test("participants 计数档为 1/2/3/4+（非 canonical tag），选择只走 SET_EXCLUSIVE_GROUP", () => {
  assert.deepEqual(DEFAULT_PARTICIPANTS.map((p) => p.key), ["1", "2", "3", "4+"]);
  assert.ok(DEFAULT_PARTICIPANTS.every((p) => !p.tag), "计数档不带 canonical tag");
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  const ok = builder.selectExclusive("participants", "2");
  assert.equal(ok, true);
  assert.equal(dispatched.length, 1, "一次选择只 dispatch 一个 action");
  assert.deepEqual(dispatched[0], {
    type: "SET_EXCLUSIVE_GROUP",
    payload: {
      group: "participant_count",
      key: "2",
      newTag: "",
      target: "base",
      characterIndex: null,
      members: [], // 计数档无 canonical tag，无旧 members 可删
    },
  });
  assert.equal(builder.selections.participants, "2");
});

test("注入 canonical subject-count options 时，人数选择携带同组 tag 且不误删普通人标签", () => {
  const dispatched = [];
  const bridge = makeBridge(addTag(addTag(createEmpty(), "base", "1girl", "character"), "base", "Citlali", "character"));
  const original = bridge.dispatch;
  bridge.dispatch = (action) => { dispatched.push(action); original(action); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS, participants: [
    { key: "1", label: "1", tag: "1girl" }, { key: "2", label: "2", tag: "2girls" },
  ] });
  builder.selectExclusive("participants", "2");
  assert.equal(dispatched[0].payload.newTag, "2girls");
  assert.equal(getTargetEntries(bridge.getDocument(), "base").some((entry) => entry.tag === "Citlali"), true);
});

test("participantNumber 映射 1/2/3 -> 数值，4+ -> 4，非法 -> null", () => {
  assert.equal(participantNumber("1"), 1);
  assert.equal(participantNumber("3"), 3);
  assert.equal(participantNumber("4+"), 4);
  assert.equal(participantNumber(null), null);
  assert.equal(participantNumber(""), null);
  assert.equal(participantNumber("abc"), null);
});

// ---- primary replacement action（strict exclusive group 原子语义） ----

test("主场景选择 dispatch 单个 SET_EXCLUSIVE_GROUP，members 含同组全部 canonical tags", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  const ok = builder.selectExclusive("scene", "indoor");
  assert.equal(ok, true);
  assert.equal(dispatched.length, 1);
  const action = dispatched[0];
  assert.equal(action.type, "SET_EXCLUSIVE_GROUP");
  assert.deepEqual(action.payload, {
    group: "primary_scene_type",
    key: "indoor",
    newTag: "bedroom",
    target: "base",
    characterIndex: null,
    members: ["bedroom", "outdoors"], // 同组旧 entries：Integrator 原子删除
  });
  assert.equal(builder.selections.scene, "indoor");
});

test("选择同组另一值（替换）仍只 dispatch 一个 SET_EXCLUSIVE_GROUP（replacement 原子交给 Integrator）", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectExclusive("scene", "indoor");
  builder.selectExclusive("scene", "outdoor");
  assert.equal(dispatched.length, 2, "两次选择 = 两个原子 action，组件不自行拆分 REMOVE/ADD");
  assert.equal(dispatched[1].payload.key, "outdoor");
  assert.equal(dispatched[1].payload.newTag, "outdoors");
  assert.deepEqual(dispatched[1].payload.members, ["bedroom", "outdoors"]);
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

// ---- stage ----

test("stage 选择 dispatch SET_EXCLUSIVE_GROUP，newTag 为空（阶段是语义标识非 canonical tag）", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  const ok = builder.selectExclusive("stage", "MAIN_ACT");
  assert.equal(ok, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    type: "SET_EXCLUSIVE_GROUP",
    payload: { group: "stage", key: "MAIN_ACT", newTag: "", target: "base", characterIndex: null, members: [] },
  });
  assert.equal(builder.selections.stage, "MAIN_ACT");
});

test("DEFAULT_STAGES 覆盖五个语义阶段且不带 canonical tag", () => {
  assert.deepEqual(DEFAULT_STAGES.map((s) => s.key), STAGE_KEYS);
  assert.ok(DEFAULT_STAGES.every((s) => !s.tag));
});

// ---- additional multi-select ----

test("附加活动 multi-select：toggle 只更新上下文（SET_ASSISTANT_CONTEXT），不触发 primary replacement", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.toggleActivity("handholding");
  builder.toggleActivity("handholding");
  assert.equal(dispatched.length, 2);
  assert.ok(dispatched.every((a) => a.type === "SET_ASSISTANT_CONTEXT"), "活动 toggle 只发 context action");
  assert.ok(dispatched.every((a) => a.type !== "SET_EXCLUSIVE_GROUP"), "活动不会触发严格互斥组替换");
  assert.deepEqual(dispatched[0].payload.context.additional_activities, ["handholding"]);
  assert.deepEqual(dispatched[1].payload.context.additional_activities, [], "再 toggle 后活动为空");
});

test("带 canonical tag 的活动新增时 ADD_TAG 到 active target（真实 canonical tag 才 ADD_TAG）", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.getActiveTarget = () => "char:0"; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.toggleActivity("kissing");
  assert.ok(dispatched.some((a) => a.type === "ADD_TAG" && a.payload.tag === "kissing" && a.payload.target === "char:0"), "带 tag 活动新增走 ADD_TAG");
  assert.ok(dispatched.some((a) => a.type === "SET_ASSISTANT_CONTEXT"), "同时更新上下文");
  assert.equal(dispatched.filter((a) => a.type === "ADD_TAG").length, 1, "只 ADD_TAG 一次");
});

test("活动 toggle 不互相删除（multi-select 保持已选集合）", () => {
  const bridge = makeBridge();
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  bridge.dispatch({ type: "SET_ASSISTANT_CONTEXT", payload: { context: { additional_activities: ["kissing", "handholding"] } } });
  builder.toggleActivity("kissing"); // 移除 kissing
  assert.deepEqual(builder.selections.activities, ["handholding"], "移除一个不影响其他活动");
  builder.toggleActivity("handholding");
  assert.deepEqual(builder.selections.activities, []);
});

// ---- position filtering ----

test("位置候选按 participant 过滤（minParticipants）", () => {
  const positions = normalizeOptions(OPTIONS.positions);
  assert.deepEqual(filterPositions(positions, { participantCount: "1" }).map((p) => p.key), ["standing"], "1 人时排除 minParticipants>=2");
  assert.deepEqual(filterPositions(positions, { participantCount: "2" }).map((p) => p.key), ["missionary", "standing"]);
  assert.deepEqual(filterPositions(positions, { participantCount: "4+" }).map((p) => p.key), ["missionary", "standing", "threesome"]);
  assert.deepEqual(filterPositions(positions, {}).map((p) => p.key), ["missionary", "standing", "threesome"], "未选人数不过滤");
});

test("4+ participant 位置过滤与 participantNumber 归一化一致", () => {
  const positions = normalizeOptions([{ key: "four", minParticipants: 4 }, { key: "five", minParticipants: 5 }]);
  assert.deepEqual(filterPositions(positions, { participantCount: "4+" }).map((p) => p.key), ["four"]);
});

test("位置候选按 scene 过滤（requiresScenes），未选 scene 不过滤", () => {
  const positions = normalizeOptions(OPTIONS.positions);
  const withScene = filterPositions(positions, { participantCount: "4+", sceneKey: "indoor" });
  assert.deepEqual(withScene.map((p) => p.key), ["missionary", "standing", "threesome"], "threesome 要求 indoor");
  const outdoor = filterPositions(positions, { participantCount: "4+", sceneKey: "outdoor" });
  assert.deepEqual(outdoor.map((p) => p.key), ["missionary", "standing"], "outdoor 下排除 threesome");
  const noScene = filterPositions(positions, { participantCount: "4+", sceneKey: "" });
  assert.deepEqual(noScene.map((p) => p.key), ["missionary", "standing", "threesome"]);
});

test("optionVisibleForCount：无人数下限的选项始终可见；低于下限不可见", () => {
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, "1"), false);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, "2"), true);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, "4+"), true);
  assert.equal(optionVisibleForCount({ key: "x", minParticipants: 2 }, null), true, "未选人数视为可见");
  assert.equal(optionVisibleForCount({ key: "x" }, "1"), true);
});

// ---- per-character clothing isolation ----

test("clothing 选择按角色作用域：SET_EXCLUSIVE_GROUP 携带 characterIndex，members 只属该组", () => {
  const dispatched = [];
  const doc = addTag(createEmpty(), "char:0", "clothed", "clothing");
  const bridge = makeBridge(doc); const dispatch = bridge.dispatch; bridge.getActiveTarget = () => "char:0"; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  const ok = builder.selectExclusive("clothing", "nude");
  assert.equal(ok, true);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].payload, {
    group: "clothing_state",
    key: "nude",
    newTag: "nude",
    target: "char:0",
    characterIndex: 0,
    members: ["clothed", "nude"], // Integrator 只在 char:0 内删除同组旧 entries
  });
  assert.equal(builder.selections.clothing[0], "nude");
});

test("clothing A->B 只影响该 Character：不触碰其他角色，也不碰服装 identity", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.getActiveTarget = () => "char:1"; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectExclusive("clothing", "nude");
  assert.equal(dispatched[0].payload.characterIndex, 1, "作用域为 active 角色");
  assert.equal(dispatched[0].payload.target, "char:1");
  // 组件不维护 nsfwCharacters[]，不跨角色复制状态
  assert.ok(!("nsfwCharacters" in builder));
  assert.deepEqual(builder.selections.clothing, { 1: "nude" }, "仅该角色有服装状态");
  // 另一个角色的服装状态独立为空
  builder.selectExclusive("clothing", "clothed"); // active 仍 char:1 -> 替换 char:1
  assert.equal(dispatched[1].payload.characterIndex, 1);
  assert.equal(dispatched[1].payload.newTag, "clothed");
});

test("clothing 不影响 primary 场景替换：clothing 组与 scene 组互不串", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.selectExclusive("clothing", "nude");
  builder.selectExclusive("scene", "indoor");
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].payload.group, "clothing_state");
  assert.equal(dispatched[1].payload.group, "primary_scene_type");
});

// ---- context payload ----

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

test("selectBodyFocus dispatch SET_ASSISTANT_CONTEXT 携带全量 context", () => {
  const dispatched = [];
  const bridge = makeBridge(); const dispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); dispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  bridge.dispatch({ type: "SET_ASSISTANT_CONTEXT", payload: { context: { participant_count: 2 } } });
  builder.selectBodyFocus("face");
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].type, "SET_ASSISTANT_CONTEXT");
  assert.equal(dispatched[0].payload.context.participant_count, 2, "context 快照含既有选择");
  assert.equal(dispatched.at(-1).payload.context.body_focus, "face");
  assert.ok(dispatched.every((a) => a.type !== "ADD_TAG"), "body_focus 无 canonical tag，不 ADD_TAG");
});

test("buildRecommendPayload 把 context 字段传给 Recommendation V2 并附带 positive tags", () => {
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const ctx = buildContext({ participants: "2", scene: "indoor", stage: "MAIN_ACT", position: "missionary", bodyFocus: "face", activities: ["kissing"] });
  const payload = buildRecommendPayload(ctx, doc, { target: "char:0" });
  assert.deepEqual(payload.tags, ["1girl"]);
  assert.equal(payload.target, "char:0");
  assert.equal(payload.mode, "nsfw");
  assert.equal(payload.participant_count, 2);
  assert.equal(payload.primary_scene_type, "indoor");
  assert.equal(payload.stage, "MAIN_ACT");
  assert.equal(payload.position, "missionary");
  assert.equal(payload.body_focus, "face");
  assert.deepEqual(payload.additional_activities, ["kissing"]);
});

// ---- no second prompt state ----

test("实例不保存 PromptDocument 副本：每次 refresh 都从桥按需读取，只缓存 UI 选择模型", async () => {
  let reads = 0;
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const bridge = makeBridge(doc); bridge.getDocument = () => { reads += 1; return doc; };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  await builder.refresh();
  await builder.refresh();
  assert.equal(reads, 4, "每次刷新重新读取 PromptBridge");
  assert.equal("doc" in builder, false, "实例不保存 doc 副本");
  assert.ok(builder.selections, "只保存 UI 选择模型（视图状态）");
  assert.equal(builder.view.status, "ok");
});

test("subscribe -> onBridgeChange 触发 refresh（不保存第二份状态）", async () => {
  const listeners = [];
  const doc = addTag(createEmpty(), "base", "1girl", "character");
  const bridge = {
    getDocument: () => doc,
    getActiveTarget: () => "base",
    subscribe: (listener) => { listeners.push(listener); return () => {}; },
    dispatch: () => {},
  };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  builder.mount();
  assert.equal(listeners.length, 1, "mount 时订阅");
  let reads = 0;
  bridge.getDocument = () => { reads += 1; return doc; };
  listeners[0]();
  assert.equal(reads, 2);
  assert.equal(builder.view.status, "ok");
  builder.destroy();
});

test("无 PromptBridge 时 refresh 置可见空态，不崩溃", async () => {
  const builder = new NsfwBuilder({ ...OPTIONS });
  await builder.refresh();
  assert.equal(builder.view.status, "empty");
  assert.match(builder.view.message, /PromptBridge/);
  const noDoc = new NsfwBuilder({ bridge: { getDocument: () => null, getActiveTarget: () => "base", subscribe: () => () => {}, dispatch: () => {} }, ...OPTIONS });
  await noDoc.refresh();
  assert.equal(noDoc.view.status, "empty");
  assert.match(noDoc.view.message, /PromptDocument/);
});

// ---- recommend dispatch ----

test("recommend 用注入函数取真实候选，normalize 兼容 {tag,canonical,zh,reason,section}", async () => {
  const calls = [];
  const builder = new NsfwBuilder({
    bridge: makeBridge(addTag(createEmpty(), "base", "1girl", "character")),
    ...OPTIONS,
    recommend: async (payload) => { calls.push(payload); return { recommendations: [{ tag: "kissing", canonical: "kissing", zh: "接吻", reason: "adult_context", section: "action" }, { tag: "" }] }; },
  });
  const recs = await builder.recommend();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "nsfw");
  assert.deepEqual(recs.map((r) => r.tag), ["kissing"], "空 tag 条目被过滤");
  assert.equal(builder.view.recStatus, "ok");
});

test("点击推荐只 dispatch ADD_TAG 到 active target，不改变 stage / 不触发 strict group", () => {
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.getActiveTarget = () => "char:0"; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  bridge.dispatch({ type: "SET_ASSISTANT_CONTEXT", payload: { context: { stage: "MAIN_ACT" } } });
  const ok = builder.applyRecommendation({ tag: "kissing", section: "action" });
  assert.equal(ok, true);
  assert.equal(dispatched.filter((a) => a.type === "ADD_TAG").length, 1, "推荐点击只添加一次标签");
  assert.ok(dispatched.some((a) => a.type === "ADD_TAG" && a.payload.target === "char:0"));
  assert.equal(builder.selections.stage, "MAIN_ACT", "不自动改变 stage");
  assert.ok(dispatched.every((a) => a.type !== "SET_EXCLUSIVE_GROUP"), "推荐不触发任何严格互斥替换");
});

test("默认 recommend 走 POST /api/recommendations，失败置 error 空态", async () => {
  const urls = [];
  const builder = new NsfwBuilder({
    bridge: makeBridge(addTag(createEmpty(), "base", "1girl", "character")),
    ...OPTIONS,
    fetchImpl: async (url, opts) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ recommendations: [{ tag: "kissing" }] }) }; },
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

// ---- no auto stage progression ----

test("推荐后 stage 不推进：applyRecommendation 不改任何 strict group / context", () => {
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ bridge, ...OPTIONS });
  bridge.dispatch({ type: "SET_ASSISTANT_CONTEXT", payload: { context: { stage: "FOREPLAY" } } });
  builder.applyRecommendation({ tag: "kissing" });
  builder.applyRecommendation({ tag: "missionary" });
  assert.ok(dispatched.filter((a) => a.type === "ADD_TAG").length >= 1, "推荐添加标签");
  assert.equal(builder.selections.stage, "FOREPLAY");
  assert.equal(builder.view.recStatus, "idle", "推荐点击不触碰推荐区状态");
});

// ---- ARIA / keyboard helpers ----

test("radioMoveIndex：wrapping 方向键换位，未选中时按方向落到首/尾", () => {
  assert.equal(radioMoveIndex(0, 1, 3), 1);
  assert.equal(radioMoveIndex(2, 1, 3), 0, "wrapping 到首");
  assert.equal(radioMoveIndex(0, -1, 3), 2, "wrapping 到尾");
  assert.equal(radioMoveIndex(-1, 1, 3), 0, "未选中向右 -> 首");
  assert.equal(radioMoveIndex(-1, -1, 3), 2, "未选中向左 -> 尾");
  assert.equal(radioMoveIndex(1, 0, 3), 1);
  assert.equal(radioMoveIndex(0, 1, 0), -1, "空组 -> -1");
  assert.equal(radioMoveIndex("abc", 1, 3), 0, "非法当前索引按未选中处理");
});

test("isSelected：严格字符串比较，null/undefined 为未选中", () => {
  assert.equal(isSelected("MAIN_ACT", "MAIN_ACT"), true);
  assert.equal(isSelected("MAIN_ACT", "main_act"), false, "大小写敏感");
  assert.equal(isSelected(null, "x"), false);
  assert.equal(isSelected(undefined, "x"), false);
  assert.equal(isSelected("x", "x"), true);
});

test("normalizeRecommendation / normalizeRecommendations 过滤空 tag", () => {
  assert.deepEqual(normalizeRecommendation({ tag: "kissing", zh: "接吻" }), { tag: "kissing", canonical: "kissing", zh: "接吻", reason: "", section: "" });
  assert.equal(normalizeRecommendation(null), null);
  assert.equal(normalizeRecommendation({}), null);
  assert.deepEqual(normalizeRecommendations({ recommendations: [{ tag: "a" }, { tag: "" }] }).map((r) => r.tag), ["a"]);
  assert.deepEqual(normalizeRecommendations([{ tag: "a" }]).map((r) => r.tag), ["a"]);
  assert.deepEqual(normalizeRecommendations(null), []);
});

// ---- dispatch 兜底 ----

test("dispatchAction 无桥 / 无 dispatch / 抛错均返回 false 不抛出", () => {
  assert.equal(dispatchAction(null, buildAddTagAction("x", "base")), false);
  assert.equal(dispatchAction({}, buildAddTagAction("x", "base")), false);
  const broken = { dispatch: () => { throw new Error("boom"); } };
  assert.equal(dispatchAction(broken, buildAddTagAction("x", "base")), false);
  const ok = { dispatch: (a) => { assert.equal(a.type, "ADD_TAG"); } };
  assert.equal(dispatchAction(ok, buildAddTagAction("x", "base")), true);
});

test("无桥时 selectExclusive 返回 false 但视图选择不更新（不伪造状态）", () => {
  const builder = new NsfwBuilder({ ...OPTIONS });
  assert.equal(builder.selectExclusive("stage", "MAIN_ACT"), false);
  assert.equal(builder.selections.stage, null, "dispatch 失败不更新 UI 模型");
});

// ---- 无第二份 prompt 状态的端到端形状 ----

test("createNsfwBuilder 返回 NsfwBuilder 实例", () => {
  const builder = createNsfwBuilder({ bridge: makeBridge(), ...OPTIONS });
  assert.ok(builder instanceof NsfwBuilder);
});

// ---- 事件路由（最小 DOM stub，验证 body-focus 与 exclusive 的 data-action 分派） ----

function minimalRoot() {
  // 仅实现 render 所需的最小 DOM API。
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

test("body-focus 按钮走 data-action=body-focus -> selectBodyFocus（不误入 exclusive 路由）", () => {
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge, ...OPTIONS });
  builder.render();
  const html = builder.root.innerHTML;
  assert.ok(html.includes('data-action="body-focus"'), "body-focus 渲染为独立 action");
  assert.ok(!html.includes('data-action-group="bodyfocus"'), "不再使用 replace hack");
  // 模拟点击 body-focus 按钮
  const fakeBtn = {
    closest: (sel) => (sel === "[data-action]" ? { dataset: { action: "body-focus", group: "bodyfocus", key: "face" } } : null),
  };
  builder.handleClick({ target: fakeBtn });
  assert.equal(builder.selections.bodyFocus, "face");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "SET_ASSISTANT_CONTEXT");
});

test("strict exclusive 按钮走 data-action=exclusive -> selectExclusive（stage 不误入 context 路由）", () => {
  const dispatched = [];
  const bridge = makeBridge(); const originalDispatch = bridge.dispatch; bridge.dispatch = (a) => { dispatched.push(a); originalDispatch(a); };
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge, ...OPTIONS });
  builder.render();
  const html = builder.root.innerHTML;
  assert.ok(html.includes('data-action="exclusive" data-group="stage"'), "stage 渲染为 exclusive 单选");
  const fakeBtn = {
    closest: (sel) => (sel === "[data-action]" ? { dataset: { action: "exclusive", group: "stage", key: "CLIMAX" } } : null),
  };
  builder.handleClick({ target: fakeBtn });
  assert.equal(builder.selections.stage, "CLIMAX");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "SET_EXCLUSIVE_GROUP");
  assert.equal(dispatched[0].payload.group, "stage");
});

test("adolescent 模式下 render 输出禁用空态，不渲染任何选择控件", () => {
  const builder = new NsfwBuilder({ root: minimalRoot(), bridge: makeBridge(), adolescentMode: true, ...OPTIONS });
  builder.render();
  assert.match(builder.root.innerHTML, /青少年模式.*已禁用/);
  assert.ok(!builder.root.innerHTML.includes("data-action="), "禁用态不渲染任何可操作控件");
});
