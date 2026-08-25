/**
 * app.js 纯函数回归测试（P1 修复：结构化 Base 标签、购物车角色删除目标重映射、模态导入 seq）
 * 运行方式: env -u NODE_OPTIONS node --test tests/test_app_helpers.mjs
 *
 * app.js 依赖浏览器全局（顶层 DOM 事件绑定、init() 调用），无法在 Node 中直接 import。
 * 因此沿用 tests/test_prompt_compiler.mjs 的既有约定：
 *   1) 用「balanced-brace 源码提取」把 app.js 中无 DOM 依赖的纯函数
 *      remapNaiTagTarget / insertTagIntoString / naiStructuredDisplayText / naiStructuredRequest
 *      原样取出并求值，直接测试真实实现；
 *   2) 依赖 DOM/async 的 addTagToTarget / doImportFromModal / pollInbox 分支，
 *      用与 app.js 逐行一致的纯逻辑模拟，断言修复后的行为。
 *
 * 覆盖（本次 P1 修复）：
 * - 结构化 Base 点击 -> naiStructuredRequest 保持有效，编译出的 effective Base 无 Base:/Character: 标记
 * - 非结构化 Base / 角色目标行为保持不变
 * - 购物车角色删除前 state.target 重映射：char:1 删 0 / char:2 删 0 / char:0 删 0 / char:1 删 2
 * - 模态导入立即应用后 inboxSeq 推进到响应 seq，同一 seq 不再被 pollInbox 重复应用
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compileGenerationPrompts } from "../static/prompt-compiler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

const V5_FULL = "nai-diffusion-5-full";

// ---- 源码提取：把 app.js 中指定顶层函数原样取出（balanced-brace，容忍 ${...} 模板字面量） ----
function extractFunction(name) {
  const start = APP_JS.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const open = APP_JS.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < APP_JS.length; i++) {
    const ch = APP_JS[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `unbalanced braces in ${name}`);
  return APP_JS.slice(start, i + 1);
}

// 无自由变量的纯函数：求值 wrapper 得到真实函数
function loadFunction(name) {
  const wrapper = new Function(`${extractFunction(name)}; return ${name};`);
  return wrapper();
}
// 有自由变量的函数（如 naiStructuredDraft）：返回 (draft) => 绑定该自由变量后的真实函数
function loadFunctionBound(name, freeVars) {
  const wrapper = new Function(...freeVars, `${extractFunction(name)}; return ${name};`);
  return (draft) => wrapper(draft);
}

const insertTagIntoString = loadFunction("insertTagIntoString");
const remapNaiTagTarget = loadFunction("remapNaiTagTarget");
const naiStructuredDisplayText = loadFunction("naiStructuredDisplayText");
// naiStructuredRequest 的自由变量 naiStructuredDraft 通过函数参数注入
const naiStructuredRequest = loadFunctionBound("naiStructuredRequest", ["naiStructuredDraft"]);

// ---- 与 app.js addTagToTarget 的 base 分支逐行一致的纯逻辑模拟（DOM 部分跳过） ----
function simulateStructuredBaseClick(draft, naiCharacters, tag) {
  // app.js: if (state.target === "base") { ... promptEl.value = ... }
  const promptEl = { value: draft ? draft.displayPrompt : "" };
  if (draft) {
    draft.basePrompt = insertTagIntoString(draft.basePrompt, tag);
    draft.displayPrompt = naiStructuredDisplayText(draft.basePrompt, naiCharacters, draft.globalUc);
    promptEl.value = draft.displayPrompt;
  } else {
    promptEl.value = insertTagIntoString(promptEl.value, tag);
  }
  return promptEl;
}

// ---- 与 app.js 角色目标分支一致的纯逻辑模拟 ----
function simulateCharacterClick(naiCharacters, index, tag) {
  const character = naiCharacters[index];
  character.prompt = insertTagIntoString(character.prompt, tag);
  return character;
}

// ---- 与 app.js doImportFromModal / pollInbox 一致的纯逻辑模拟 ----
function simulateImportFlow({ initialSeq = 0, importResponse }) {
  let inboxSeq = initialSeq;
  const applied = [];
  const applyImported = (parsed, mode, target) => { applied.push({ mode, target }); };
  // app.js doImportFromModal：POST /api/import -> 立即应用（保留用户目标）-> 推进 inboxSeq
  const doImportFromModal = async () => {
    const r = importResponse; // await api("/api/import", ...)
    applyImported(r.parsed, r.mode, "char:2"); // 用户选择的导入目标
    if (r.seq != null) inboxSeq = r.seq; // 修复点
  };
  // app.js pollInbox：r.state 存在才应用（默认 base 目标）并推进游标
  const pollInbox = (r) => {
    if (r.state) {
      inboxSeq = r.seq;
      applyImported(r.state.parsed, r.state.mode || "replace", "base");
    }
  };
  return { doImportFromModal, pollInbox, getSeq: () => inboxSeq, applied };
}

// ---- 1. 结构化 Base 点击（P1-A）----

test("structured Base click updates basePrompt and keeps naiStructuredRequest valid", () => {
  const draft = {
    displayPrompt: "Base: 1girl, forest\nCharacter 1: nahida",
    displayNegative: "lowres",
    basePrompt: "1girl, forest",
    globalUc: "lowres",
    characters: [{ prompt: "nahida" }],
  };
  const naiCharacters = [{ prompt: "nahida", negative_prompt: "", position: null }];

  const promptEl = simulateStructuredBaseClick(draft, naiCharacters, "blue eyes");

  // 权威 Base 状态用既有插入语义更新
  assert.equal(draft.basePrompt, "1girl, forest, blue eyes");
  // displayPrompt 从更新的 Base + 现有 naiCharacters[] 重建，并回写 textarea（globalUc 非空时保留 Global UC 行）
  assert.equal(draft.displayPrompt, "Base: 1girl, forest, blue eyes\nCharacter 1: nahida\nGlobal UC: lowres");
  assert.equal(promptEl.value, draft.displayPrompt);
  // naiStructuredRequest 仍与 textarea 匹配（非 null），解析回干净的 basePrompt
  const structured = naiStructuredRequest(draft)(promptEl.value, draft.displayNegative);
  assert.ok(structured, "structured request must stay valid after Base tag click");
  assert.equal(structured.prompt, "1girl, forest, blue eyes");
  assert.equal(structured.negative_prompt, "lowres");

  // 编译出的 effective Base 不得混入 Base:/Character: 结构化标记
  const compiled = compileGenerationPrompts(structured.prompt, structured.negative_prompt, V5_FULL, { positiveTier: "standard", negativeTier: "heavy" });
  assert.equal(compiled.effectivePositive, "1girl, forest, blue eyes, very aesthetic, masterpiece, no text");
  assert.ok(!compiled.effectivePositive.includes("Base:"), "no Base: marker leaks into effective positive");
  assert.ok(!compiled.effectivePositive.includes("Character:"), "no Character: marker leaks into effective positive");
});

test("structured Base click with empty basePrompt inserts Base line and stays valid", () => {
  const draft = {
    displayPrompt: "Character 1: nahida",
    displayNegative: "",
    basePrompt: "",
    globalUc: "",
    characters: [{ prompt: "nahida" }],
  };
  const naiCharacters = [{ prompt: "nahida", negative_prompt: "", position: null }];

  const promptEl = simulateStructuredBaseClick(draft, naiCharacters, "solo");

  assert.equal(draft.basePrompt, "solo");
  assert.equal(draft.displayPrompt, "Base: solo\nCharacter 1: nahida");
  assert.equal(promptEl.value, draft.displayPrompt);
  const structured = naiStructuredRequest(draft)(promptEl.value, draft.displayNegative);
  assert.ok(structured, "structured request must stay valid (empty base before click)");
  assert.equal(structured.prompt, "solo");
  const compiled = compileGenerationPrompts(structured.prompt, structured.negative_prompt, V5_FULL, { positiveTier: "standard", negativeTier: "heavy" });
  assert.ok(!compiled.effectivePositive.includes("Base:"));
  assert.ok(!compiled.effectivePositive.includes("Character:"));
});

test("non-structured Base behavior unchanged: tag appended straight to textarea", () => {
  const promptEl = simulateStructuredBaseClick(null, [], "blue eyes");
  assert.equal(promptEl.value, "blue eyes");
  const again = simulateStructuredBaseClick(null, [], "blue eyes");
  assert.equal(again.value, "blue eyes", "duplicate tag must not be re-added (insertTagIntoString dedup)");
});

test("character target behavior unchanged: character prompt updated, structured draft untouched", () => {
  const draft = {
    displayPrompt: "Base: 1girl\nCharacter 1: nahida",
    displayNegative: "lowres",
    basePrompt: "1girl",
    globalUc: "lowres",
    characters: [{ prompt: "nahida" }],
  };
  const naiCharacters = [{ prompt: "nahida", negative_prompt: "", position: null }];
  const before = { ...draft };

  const character = simulateCharacterClick(naiCharacters, 0, "blue eyes");

  assert.equal(character.prompt, "nahida, blue eyes");
  // 角色目标分支不得改动结构化草稿的 Base / displayPrompt
  assert.equal(draft.basePrompt, before.basePrompt);
  assert.equal(draft.displayPrompt, before.displayPrompt);
  // naiStructuredRequest 仍匹配原 textarea
  assert.ok(naiStructuredRequest(draft)(before.displayPrompt, draft.displayNegative), "character path must not invalidate structured request");
});

// ---- 2. 购物车角色删除目标重映射（P1-B）----

test("cart removeCharacter remaps state.target before splice (real remapNaiTagTarget)", () => {
  // 删除第 0 个角色：目标后移
  assert.equal(remapNaiTagTarget("char:1", "remove", 0), "char:0");
  assert.equal(remapNaiTagTarget("char:2", "remove", 0), "char:1");
  // 删除目标角色自身：回退 base
  assert.equal(remapNaiTagTarget("char:0", "remove", 0), "base");
  // 删除目标之后（index 大于目标）的角色：目标不变
  assert.equal(remapNaiTagTarget("char:1", "remove", 2), "char:1");
});

test("cart removeCharacter remap preserves non-char targets and char:N:uc", () => {
  assert.equal(remapNaiTagTarget("base", "remove", 0), "base");
  assert.equal(remapNaiTagTarget("global_uc", "remove", 0), "global_uc");
  assert.equal(remapNaiTagTarget("char:0:uc", "remove", 0), "char:0:uc", "char:N:uc 非正向目标不改");
});

test("cart removeCharacter remap keeps move-op semantics unchanged", () => {
  assert.equal(remapNaiTagTarget("char:1", "move", 1, 0), "char:0", "被移动的角色跟随");
  assert.equal(remapNaiTagTarget("char:0", "move", 1, 0), "char:1", "被挤占（交换）的角色也跟随");
  assert.equal(remapNaiTagTarget("char:2", "move", 1, 0), "char:2", "无关角色目标不变");
});

// ---- 3. 模态导入 seq 推进（P1-C）----

test("modal import advances inboxSeq to response seq; same seq is not reapplied", async () => {
  const importResponse = { seq: 5, mode: "replace", parsed: { base: [{ tag: "1girl" }] } };
  const flow = simulateImportFlow({ initialSeq: 0, importResponse });

  await flow.doImportFromModal();
  assert.equal(flow.getSeq(), 5, "inboxSeq advanced to response seq after immediate apply");
  // 立即应用保留了用户的导入目标
  assert.deepEqual(flow.applied, [{ mode: "replace", target: "char:2" }]);

  // 下一轮 pollInbox：server 对 since>=seq 返回 state:null，同一份导入不会再次应用
  const nApplies = flow.applied.length;
  flow.pollInbox({ seq: 5, state: null });
  assert.equal(flow.getSeq(), 5);
  assert.equal(flow.applied.length, nApplies, "same seq must not be reapplied");
});

test("modal import without seq advance would reapply same import with default base target (bug contrast)", async () => {
  // 修复前行为：doImportFromModal 不推进 inboxSeq，下一轮 pollInbox 拿到同一 state 以 base 目标重放
  const importResponse = { seq: 3, mode: "replace", parsed: { base: [{ tag: "1girl" }] } };
  const flow = simulateImportFlow({ initialSeq: 0, importResponse });
  // 移除修复点后的旧逻辑
  const doImportFromModalOld = async () => {
    const r = importResponse;
    flow.applied.length = 0;
    flow.applied.push({ mode: r.mode, target: "char:2" });
    // 旧代码没有 if (r.seq != null) inboxSeq = r.seq;
  };
  await doImportFromModalOld();
  assert.equal(flow.getSeq(), 0, "old code: inboxSeq not advanced");
  flow.pollInbox({ seq: 3, state: { mode: "replace", parsed: importResponse.parsed } });
  assert.deepEqual(flow.applied[1], { mode: "replace", target: "base" }, "old code: poll reapplies with default base target");
});