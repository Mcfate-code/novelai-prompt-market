/**
 * Phase 2 集成回归（前端契约）：PromptBridge 扩展 action 的纯数据语义。
 *
 * 覆盖（integration cases）：exclusive primary replacement、additional activity、
 * position、per-character clothing、snapshot context（assistant_context 保留/不泄漏）、
 * continue generate no display literals、keyboard（double Enter / IME / Tab delimiter）。
 *
 * 这些 action 的真实实现收敛在 static/prompt-document.js 纯模块，app.js 的
 * dispatchPromptAction 只是薄委托，因此这里直接测真实实现（与生产同一份代码）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  addTag, applyExclusiveGroup, createEmpty, documentFromProposal,
  getAssistantContext, getTargetEntries, serializeTarget, setAssistantContext,
} from "../static/prompt-document.js";
import { createNaiInputKeys, handleKeydown } from "../static/nai-input-keys.js";

// ---- exclusive primary replacement（strict group 原子替换） ----

test("SET_EXCLUSIVE_GROUP primary scene replacement removes old members atomically", () => {
  let doc = addTag(createEmpty(), "base", { tag: "bedroom", section: "scene" }, "scene");
  doc = applyExclusiveGroup(doc, {
    group: "primary_scene_type", key: "outdoor", newTag: "outdoor",
    target: "base", characterIndex: null, members: ["bedroom", "outdoor"],
  });
  assert.deepEqual(getTargetEntries(doc, "base").map((e) => e.tag), ["outdoor"]);
  assert.equal(getAssistantContext(doc).primary_scene_type, "outdoor");
});

// ---- additional activity（multi-select 不互删） ----

test("SET_ASSISTANT_CONTEXT additional activities accumulate (no mutual delete)", () => {
  let doc = setAssistantContext(createEmpty(), { mode: "adult", additional_activities: ["kissing"] });
  doc = setAssistantContext(doc, { mode: "adult", additional_activities: ["kissing", "hug"] });
  assert.deepEqual(getAssistantContext(doc).additional_activities, ["kissing", "hug"]);
});

// ---- position scope（base/composition） ----

test("SET_EXCLUSIVE_GROUP position scope is base (composition)", () => {
  let doc = addTag(createEmpty(), "base", { tag: "missionary", section: "composition" }, "composition");
  doc = applyExclusiveGroup(doc, {
    group: "position", key: "standing", newTag: "standing",
    target: "base", characterIndex: null, members: ["missionary", "standing"],
  });
  assert.deepEqual(getTargetEntries(doc, "base").map((e) => e.tag), ["standing"]);
  assert.equal(getAssistantContext(doc).position, "standing");
});

// ---- per-character clothing（clothing_state:char:N） ----

test("SET_EXCLUSIVE_GROUP clothing_state is per-character scope", () => {
  let doc = addTag(createEmpty(), "char:0", { tag: "clothed", section: "clothing" }, "clothing");
  doc = applyExclusiveGroup(doc, {
    group: "clothing_state", key: "nude", newTag: "nude",
    target: "char:0", characterIndex: 0, members: ["clothed", "nude"],
  });
  assert.deepEqual(getTargetEntries(doc, "char:0").map((e) => e.tag), ["nude"]);
  assert.deepEqual(getTargetEntries(doc, "char:1"), [], "其他角色不受影响");
  assert.deepEqual(getAssistantContext(doc).clothing_state, { 0: "nude" });
});

// ---- snapshot context + continue generate no display literals ----

test("assistant_context is preserved in document but never compiled into prompt", () => {
  let doc = setAssistantContext(createEmpty(), { participant_count: 2, stage: "MAIN_ACT" });
  doc = addTag(doc, "base", "1girl", "character");
  // compiled prompt（serializeTarget）不含任何 assistant_context 字面量
  assert.equal(serializeTarget(doc, "base"), "1girl");
  assert.equal(getAssistantContext(doc).participant_count, 2);

  const doc2 = documentFromProposal({
    base: [{ tag: "2girls" }],
    characters: [{ name: "A", prompt: [{ tag: "blue eyes" }], uc: [], position: null }],
    global_uc: [],
    assistant_context: { participant_count: 2 },
  });
  assert.equal(serializeTarget(doc2, "base"), "2girls");
  assert.equal(serializeTarget(doc2, "char:0"), "blue eyes");
  assert.equal(getAssistantContext(doc2).participant_count, 2);
});

test("participant strict group replaces only count tags and preserves ordinary person tags", () => {
  let doc = addTag(addTag(createEmpty(), "base", { tag: "1girl", section: "character" }, "character"), "base", { tag: "Citlali", section: "character" }, "character");
  doc = applyExclusiveGroup(doc, {
    group: "participant_count", key: "3", newTag: "3girls", target: "base",
    characterIndex: null, members: ["1girl", "2girls", "3girls", "4girls"],
  });
  const tags = getTargetEntries(doc, "base").map((entry) => entry.tag);
  assert.deepEqual(tags, ["Citlali", "3girls"]);
  assert.equal(getAssistantContext(doc).participant_count, "3");
});

// ---- keyboard（double Enter 只生成一次 / IME 不生成 / Tab 追加分隔符） ----

test("keyboard double Enter triggers generate exactly once, IME never generates", () => {
  let now = 1000;
  const keys = createNaiInputKeys({ doubleEnterMs: 350, now: () => now });
  const events = [];
  const apply = (e, a) => { if (a.preventDefault) e.preventDefault(); events.push(a.action); };
  const kd = (key, extra = {}) => ({ key, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...extra });

  apply(kd("Enter"), keys.handleKeydown(kd("Enter"), {}));
  assert.equal(events.at(-1), "newline", "单 Enter 永远换行");

  now += 200;
  const e2 = kd("Enter");
  apply(e2, keys.handleKeydown(e2, {}));
  assert.equal(events.at(-1), "generate", "窗口内第二击 Enter 触发 Generate");
  assert.ok(e2.defaultPrevented, "第二击 Enter 应 preventDefault（撤销额外空行）");

  now += 100;
  apply(kd("Enter"), keys.handleKeydown(kd("Enter"), {}));
  assert.equal(events.at(-1), "newline", "第三击快速 Enter 是全新换行");

  keys.resetDoubleEnter();
  apply(kd("Enter", { isComposing: true }), keys.handleKeydown(kd("Enter", { isComposing: true }), {}));
  assert.equal(events.at(-1), "newline", "IME 组合中的 Enter 只换行不生成");

  now += 100;
  apply(kd("Enter"), keys.handleKeydown(kd("Enter"), {}));
  assert.equal(events.at(-1), "newline", "IME 之后的第一次 Enter 仍是换行而非 Generate");
});

test("keyboard Tab accepts selected candidate with delimiter", () => {
  const results = [{ tag: "blue eyes" }, { tag: "solo" }];
  const action = handleKeydown({ key: "Tab", preventDefault() {} }, { popup: { open: true, results, selected: 0 } });
  assert.equal(action.action, "accept");
  assert.equal(action.tag, "blue eyes");
  assert.equal(action.delimiter, ", ");
});
