/**
 * Workbench Convergence 回归测试（纯函数，无 DOM / 无 NovelAI API）。
 * 运行方式: env -u NODE_OPTIONS node --test static/tests/workbench-convergence.test.mjs
 *
 * 覆盖：
 *  - Base / C1 / C2 严格隔离（reconcileTargetText 只改目标槽位）
 *  - Base+global_uc 与 C1+uc 隔离
 *  - Text → Document（RECONCILE_TEXT → getTargetEntries）
 *  - Document → Text（serializeTarget 反映 mutation）
 *  - buildGenerationPromptState 隔离 + Preview == payload
 *  - TagBundle 当前目标 only（保存/应用 char:1 不影响 base/char:2）
 *  - Undo = 一次编辑会话（focus → 多次 RECONCILE_TEXT → blur 只压 1 个快照）
 *  - 非法目标 char:99 绝不触碰 Base
 *  - custom/raw 删除只删该 entry id
 *  - restore → document 归一化（base/characters 隔离）
 *  - tokenRangeAtCaret 尊重 weight::tag:: 包裹（autocomplete caret 契约）
 *
 * DOM 依赖项（autocomplete 弹窗渲染、编辑器焦点 GUARD）见文件末尾 MANUAL CHECKLIST。
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as promptDocument from "../prompt-document.js";
import { splitPromptTokens, tokenRangeAtCaret } from "../prompt-tokenizer.js";
import { compileGenerationPrompts } from "../prompt-compiler.js";

const {
  createEmpty, getTargetEntries, serializeTarget, reconcileTargetText, addTag, removeTag,
  addCharacter, removeCharacter, renameCharacter, setCharacterPosition, moveCharacter,
  buildGenerationPromptState, effectiveFreeText, documentFromProposal,
} = promptDocument;

const KNOWN = new Map([
  ["1girl", "1girl"], ["solo", "solo"], ["blue eyes", "blue eyes"], ["citlali", "citlali"],
  ["nahida", "nahida"], ["green hair", "green hair"], ["bedroom", "bedroom"], ["night", "night"],
  ["bad anatomy", "bad anatomy"], ["lowres", "lowres"],
]);

// 纯模型：模拟 app.js 的编辑事务（[13]）。RECONCILE_TEXT 不逐键 pushHistory，
// focus 保存一次 pre-edit 快照，blur 若内容变化只压入一个快照，undo 弹栈恢复。
function createEditSession(knownTags = KNOWN) {
  let doc = createEmpty();
  const history = [];
  let txnSnapshot = null;
  const snapshot = () => JSON.stringify({ prompt: doc });
  const push = (s) => { history.push(s); if (history.length > 50) history.shift(); };
  const begin = () => { if (txnSnapshot == null) txnSnapshot = snapshot(); };
  const end = () => {
    if (txnSnapshot == null) return;
    const pre = txnSnapshot; txnSnapshot = null;
    if (snapshot() !== pre) push(pre);
  };
  const dispatch = (type, payload = {}) => {
    if (type === "RECONCILE_TEXT") {
      doc = reconcileTargetText(doc, payload.target, payload.text || "", new Map(knownTags));
      return; // 不 pushHistory
    }
    if (type === "ADD_TAG") { push(snapshot()); doc = addTag(doc, payload.target, { tag: payload.tag }, payload.section || "other"); }
    else if (type === "REMOVE_TAG") { push(snapshot()); doc = removeTag(doc, payload.target, payload.entryId); }
    else if (type === "ADD_CHARACTER") { push(snapshot()); doc = addCharacter(doc, {}); }
  };
  const undo = () => { const last = history.pop(); if (last == null) return doc; doc = JSON.parse(last).prompt; return doc; };
  return { get doc() { return doc; }, set doc(v) { doc = v; }, dispatch, begin, end, undo, historyCount: () => history.length, snapshot };
}

test("Base / C1 / C2 strict isolation via reconcileTargetText", () => {
  let doc = createEmpty();
  doc = addCharacter(doc, {}); // C2
  doc = reconcileTargetText(doc, "base", "1girl, solo", KNOWN);
  doc = reconcileTargetText(doc, "char:0", "citlali", KNOWN);
  doc = reconcileTargetText(doc, "char:1", "nahida", KNOWN);
  const mutated = reconcileTargetText(doc, "char:1", "nahida, green hair", KNOWN);
  assert.equal(serializeTarget(mutated, "char:1"), "nahida, green hair");
  assert.equal(serializeTarget(mutated, "base"), "1girl, solo", "char:1 编辑不得改 Base");
  assert.equal(serializeTarget(mutated, "char:0"), "citlali", "char:1 编辑不得改 C1");
});

test("Base + global_uc and C1 + uc isolation", () => {
  let doc = createEmpty();
  doc = reconcileTargetText(doc, "base", "1girl", KNOWN);
  doc = reconcileTargetText(doc, "global_uc", "bad anatomy", KNOWN);
  doc = reconcileTargetText(doc, "char:0", "citlali", KNOWN);
  doc = reconcileTargetText(doc, "char:0:uc", "lowres", KNOWN);
  assert.equal(serializeTarget(doc, "base"), "1girl");
  assert.equal(serializeTarget(doc, "global_uc"), "bad anatomy", "global_uc 独立于 base");
  assert.equal(serializeTarget(doc, "char:0"), "citlali");
  assert.equal(serializeTarget(doc, "char:0:uc"), "lowres", "角色 UC 独立于角色 Prompt");
  assert.equal(serializeTarget(doc, "char:0"), "citlali", "改 UC 不改角色 Prompt");
});

test("Text -> Document via RECONCILE_TEXT updates getTargetEntries", () => {
  const s = createEditSession();
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl, blue eyes" });
  const entries = getTargetEntries(s.doc, "base").map((e) => e.tag);
  assert.deepEqual(entries, ["1girl", "blue eyes"]);
});

test("Document -> Text via serializeTarget reflects mutation", () => {
  const s = createEditSession();
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl" });
  s.dispatch("ADD_TAG", { target: "base", tag: "solo" });
  assert.equal(serializeTarget(s.doc, "base"), "1girl, solo");
});

test("buildGenerationPromptState isolates characters[i].prompt and basePrompt", () => {
  let doc = createEmpty();
  doc = addCharacter(doc, {});
  doc = reconcileTargetText(doc, "base", "1girl, solo", KNOWN);
  doc = reconcileTargetText(doc, "char:0", "citlali", KNOWN);
  doc = reconcileTargetText(doc, "char:1", "nahida, green hair", KNOWN);
  doc = reconcileTargetText(doc, "global_uc", "bad anatomy", KNOWN);
  const state = buildGenerationPromptState(doc);
  assert.equal(state.basePrompt, "1girl, solo", "basePrompt 只含 base，不含角色");
  assert.ok(!state.basePrompt.includes("citlali"), "basePrompt 不得混入角色 tag");
  assert.ok(!state.basePrompt.includes("nahida"), "basePrompt 不得混入角色 tag");
  assert.equal(state.globalUc, "bad anatomy");
  assert.equal(state.characters.length, 2);
  assert.equal(state.characters[0].prompt, "citlali");
  assert.equal(state.characters[1].prompt, "nahida, green hair");
});

test("Preview == Generate：compile(buildGenerationPromptState) 与 payload 同源", () => {
  let doc = createEmpty();
  doc = addCharacter(doc, {});
  doc = reconcileTargetText(doc, "base", "1girl, solo", KNOWN);
  doc = reconcileTargetText(doc, "char:0", "citlali", KNOWN);
  doc.free_text = "sitting on bed";
  const state = buildGenerationPromptState(doc);
  assert.equal(state.basePrompt, "1girl, solo, sitting on bed", "effectiveFreeText 并入 basePrompt");
  // 预览与实际发送共用同一编译函数 + 同一 basePrompt
  const preview = compileGenerationPrompts(state.basePrompt, state.globalUc, "nai-diffusion-5-full", { positiveTier: "standard", negativeTier: "heavy" });
  const payload = compileGenerationPrompts(state.basePrompt, state.globalUc, "nai-diffusion-5-full", { positiveTier: "standard", negativeTier: "heavy" });
  assert.equal(preview.effectivePositive, payload.effectivePositive);
  assert.ok(preview.effectivePositive.includes("citlali") === false, "角色 tag 不进入 basePrompt 编译结果");
});

test("effectiveFreeText honors use_free_text_en", () => {
  let doc = createEmpty();
  doc.free_text = "中文原文";
  doc.free_text_en = "English translation";
  doc.use_free_text_en = false;
  assert.equal(effectiveFreeText(doc), "中文原文");
  doc.use_free_text_en = true;
  assert.equal(effectiveFreeText(doc), "English translation");
});

test("TagBundle current-target only：char:1 保存/应用不影响 base/char:2", () => {
  let doc = createEmpty();
  doc = addCharacter(doc, {}); // C2
  doc = addCharacter(doc, {}); // C3
  doc = reconcileTargetText(doc, "base", "1girl, solo", KNOWN);
  doc = reconcileTargetText(doc, "char:1", "citlali", KNOWN);
  doc = reconcileTargetText(doc, "char:2", "nahida", KNOWN);
  // save bundle from char:1
  const bundle = getTargetEntries(doc, "char:1").map((e, i) => ({ tag: e.tag, weight: e.weight, section: e.section, sort_order: i }));
  assert.deepEqual(bundle.map((e) => e.tag), ["citlali"]);
  // apply to char:1 only（模拟 addBundle 的 merge + reconcileTargetText）
  const currentText = serializeTarget(doc, "char:1");
  const existing = new Set(splitPromptTokens(currentText).map((t) => t.toLowerCase()));
  const additions = bundle.map((e) => e.tag).filter((t) => !existing.has(t.toLowerCase()));
  const merged = [currentText, ...additions].filter(Boolean).join(", ");
  doc = reconcileTargetText(doc, "char:1", merged, KNOWN);
  assert.equal(serializeTarget(doc, "char:1"), "citlali");
  assert.equal(serializeTarget(doc, "base"), "1girl, solo", "bundle 应用不得改 Base");
  assert.equal(serializeTarget(doc, "char:2"), "nahida", "bundle 应用不得改 char:2");
});

test("Undo = 一次编辑会话：focus → 多次 RECONCILE_TEXT → blur 只压一个快照", () => {
  const s = createEditSession();
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl" });
  assert.equal(serializeTarget(s.doc, "base"), "1girl");
  s.begin(); // focus：保存 pre-edit 快照一次
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl, blue" });
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl, blue eyes" });
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl, blue eyes, solo" });
  assert.equal(s.historyCount(), 0, "RECONCILE_TEXT 逐键不 pushHistory");
  s.end(); // blur
  assert.equal(s.historyCount(), 1, "blur 恰好压入一个 pre-edit 快照");
  s.undo();
  assert.equal(serializeTarget(s.doc, "base"), "1girl", "undo 恢复 pre-edit 状态");
});

test("Undo 不生成多余快照：focus 后无改动 blur 不压快照", () => {
  const s = createEditSession();
  s.dispatch("RECONCILE_TEXT", { target: "base", text: "1girl" });
  s.begin();
  s.end(); // 无改动
  assert.equal(s.historyCount(), 0, "无变化的编辑会话不产生 undo 快照");
});

test("invalid char target 'char:99' never touches Base", () => {
  let doc = createEmpty();
  doc = reconcileTargetText(doc, "base", "1girl, solo", KNOWN);
  const baseBefore = serializeTarget(doc, "base");
  const entriesBefore = getTargetEntries(doc, "base").map((e) => e.tag);
  const mutated = reconcileTargetText(doc, "char:99", "intruder, evil tag", KNOWN);
  assert.equal(serializeTarget(mutated, "base"), baseBefore);
  assert.deepEqual(getTargetEntries(mutated, "base").map((e) => e.tag), entriesBefore);
});

test("custom/raw delete：removeTag 只删该 entry id，不殃及其它 tag", () => {
  let doc = createEmpty();
  doc = reconcileTargetText(doc, "base", "1girl, custom raw tag, blue eyes", KNOWN);
  const entries = getTargetEntries(doc, "base");
  const custom = entries.find((e) => e.tag === "custom raw tag");
  assert.ok(custom, "custom raw tag 应存在");
  const otherIds = entries.filter((e) => e.tag !== "custom raw tag").map((e) => e.id);
  doc = removeTag(doc, "base", custom.id);
  const remaining = getTargetEntries(doc, "base");
  assert.ok(!remaining.some((e) => e.tag === "custom raw tag"), "目标 entry 已删除");
  assert.deepEqual(remaining.map((e) => e.id).sort(), otherIds.sort(), "其它 entry 不受影响");
});

test("restore -> document 归一化：base/characters 隔离且保留 position/name", () => {
  let doc = createEmpty();
  doc = reconcileTargetText(doc, "base", "bedroom, night", KNOWN);
  doc = reconcileTargetText(doc, "global_uc", "bad anatomy", KNOWN);
  while (doc.characters.length < 2) doc = addCharacter(doc, {});
  doc = reconcileTargetText(doc, "char:0", "citlali", KNOWN);
  doc = reconcileTargetText(doc, "char:0:uc", "lowres", KNOWN);
  doc = reconcileTargetText(doc, "char:1", "nahida, green hair", KNOWN);
  doc = renameCharacter(doc, 1, "Nahida");
  doc = setCharacterPosition(doc, 0, { x: 0.3, y: 0.4 });
  assert.equal(serializeTarget(doc, "base"), "bedroom, night");
  assert.equal(serializeTarget(doc, "global_uc"), "bad anatomy");
  assert.equal(serializeTarget(doc, "char:0"), "citlali");
  assert.equal(serializeTarget(doc, "char:0:uc"), "lowres");
  assert.equal(serializeTarget(doc, "char:1"), "nahida, green hair");
  assert.equal(doc.characters[1].name, "Nahida");
  assert.deepEqual(doc.characters[0].position, { x: 0.3, y: 0.4 });
});

test("tokenRangeAtCaret respects weight::tag:: wrapper (autocomplete caret contract)", () => {
  assert.deepEqual((({ start, end }) => ({ start, end }))(tokenRangeAtCaret("1girl, blue e, masterpiece", 13)), { start: 6, end: 13 });
  // caret 落在加权 token 内部：span 覆盖整个 1.2::blue eyes::，绝不拆进 token 内部
  assert.deepEqual((({ start, end }) => ({ start, end }))(tokenRangeAtCaret("1girl, 1.2::blue eyes::, masterpiece", 15)), { start: 6, end: 23 });
  assert.deepEqual((({ start, end }) => ({ start, end }))(tokenRangeAtCaret("1girl, 1.2::blue eyes::, masterpiece", 25)), { start: 24, end: 36 });
  // caret 在行首 / 行尾（span 为原始 span，含 token 前导空白，供 left/right 空白逻辑使用）
  assert.deepEqual((({ start, end }) => ({ start, end }))(tokenRangeAtCaret("1girl, solo", 0)), { start: 0, end: 5 });
  assert.deepEqual((({ start, end }) => ({ start, end }))(tokenRangeAtCaret("1girl, solo", 11)), { start: 6, end: 11 });
});

test("documentFromProposal still available for Auto-Split Apply", () => {
  const doc = documentFromProposal({
    base: [{ tag: "1girl", section: "character" }],
    global_uc: [{ tag: "bad anatomy", section: "quality" }],
    characters: [{ name: "Alice", prompt: [{ tag: "blonde hair", section: "appearance" }], uc: [] }],
  });
  assert.equal(serializeTarget(doc, "base"), "1girl");
  assert.equal(serializeTarget(doc, "global_uc"), "bad anatomy");
  assert.equal(serializeTarget(doc, "char:0"), "blonde hair");
  assert.equal(doc.characters[0].name, "Alice");
});

// ===== MANUAL CHECKLIST（DOM 依赖，无法在 node --test 覆盖）=====
// 1. autocomplete 弹窗渲染：#nai-editor 内键入 2+ 字符出现候选；Tab 接受后光标停在插入 tag 末尾，
//    立即触发 input 且被 naiAutocompleteSuppress 抑制不重开弹窗。
// 2. 键盘契约：↑↓ 导航、Tab 接受、单 Enter 换行、Enter×2 生成、Esc 关闭；IME composing 的 Enter 只换行不生成。
// 3. 单一编辑器：Base / Character N / Prompt / UC 切换时 #nai-editor 内容与光标（GUARD）正确回流；
//    聚焦打字时不被 subscriber 重写。
// 4. Text / Visual / Scene 模式：Text 显示编辑器 + Prompt/UC + 角色 tab + Tag Assistant；
//    Visual 只显示 #visual-prompt-root；Scene 只显示 #nsfw-builder-root；青少年模式隐藏 Scene 按钮。
// 5. 角色设置：折叠面板仅 角色名 / Position / X·Y / 上移·下移 / 移除，无 textarea；编辑角色 Prompt 走顶部单一编辑器。
