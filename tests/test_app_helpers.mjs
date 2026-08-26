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
 *
 * 覆盖（P2 修复：翻译一致性）：
 * - translateFreeText 读取当前 DOM 并同步 state；防抖窗口内点击翻译的是最新文本
 * - 请求返回时原文已变化 -> 丢弃译文（不覆盖 Raw、不启用旧译文、use 标志不复活）
 * - applyImported / applyImportedPreview 追加 free_text 实际改变后 use_free_text_en=false；replace 路径保持
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

// ---- P2 翻译一致性纯函数（无自由变量） ----
const shouldAcceptTranslation = loadFunction("shouldAcceptTranslation");
const mergeImportedFreeText = loadFunction("mergeImportedFreeText");
const recognizedTagToken = loadFunction("recognizedTagToken");
const extractRecognizedTagIdentities = loadFunctionBound("extractRecognizedTagIdentities", ["recognizedTagToken"])(recognizedTagToken);
const applyRecognizedTagDiff = loadFunctionBound("applyRecognizedTagDiff", ["recognizedTagToken"])(recognizedTagToken);
const promptTokenRange = loadFunction("promptTokenRange");
const replacePromptToken = loadFunctionBound("replacePromptToken", ["promptTokenRange"])(promptTokenRange);
const replacePromptTokenWithCaret = loadFunctionBound("replacePromptTokenWithCaret", ["promptTokenRange"])(promptTokenRange);
const workspaceTabToTarget = loadFunction("workspaceTabToTarget");
// ---- P3 修复纯函数（无自由变量） ----
const naiStructuredBaseLine = loadFunction("naiStructuredBaseLine");
const naiAutocompleteSkipSearch = loadFunction("naiAutocompleteSkipSearch");

test("recognized cart diff patches only catalog tokens and preserves raw syntax", () => {
  const known = new Map([["blue eyes", "blue eyes"], ["forest", "forest"], ["1girl", "1girl"]]);
  const raw = "free text, 1girl, 1.2::blue eyes::, {unsupported: syntax}, forest";
  const patched = applyRecognizedTagDiff(raw, ["1girl", "blue eyes"], known);
  assert.equal(patched, "free text, 1girl, 1.2::blue eyes::, {unsupported: syntax}");
  assert.deepEqual(extractRecognizedTagIdentities(patched, known), ["1girl", "blue eyes"]);
});

test("recognized identity extraction is target-local and excludes unsupported syntax", () => {
  const known = new Map([["same", "same"], ["character tag", "character tag"]]);
  assert.deepEqual(extractRecognizedTagIdentities("same, free prose, {same}, 0.8::character tag::", known), ["same", "character tag"]);
});

test("autocomplete token replacement preserves surrounding text", () => {
  const raw = "1girl, blue e, masterpiece";
  const range = promptTokenRange(raw, 13);
  assert.equal(range.query, "blue e");
  assert.equal(replacePromptToken(raw, 13, "blue eyes"), "1girl, blue eyes, masterpiece");
  assert.equal(replacePromptToken("prefix, tag", 3, "new"), "new, tag");
});

test("advanced cart contract keeps target mapping and layout hooks explicit", () => {
  assert.match(APP_JS, /\["base", "global_uc", \.\.\.state\.prompt\.characters\.flatMap/);
  assert.match(APP_JS, /cart-advanced-layout/);
  assert.match(APP_JS, /closest\("\.tag-card"\)/);
  assert.match(APP_JS, /setTimeout\(\(\) => showThumbPreview/);
});

// ---- 4. P3 修复：结构化 Base 手动编辑不再整段解析多行 display ----

test("naiStructuredBaseLine extracts only the Base line regardless of sync state", () => {
  assert.equal(naiStructuredBaseLine("Base: solo\nCharacter 1: nahida"), "solo");
  assert.equal(naiStructuredBaseLine("Character 1: nahida\nBase: 1girl, forest"), "1girl, forest");
  assert.equal(naiStructuredBaseLine("Character 1: nahida"), null, "无 Base 行返回 null");
  assert.equal(naiStructuredBaseLine(""), null);
  assert.equal(naiStructuredBaseLine("Base: 1girl, forest\nCharacter 1: nahida\nCharacter 1 UC: lowres\nGlobal UC: bad anatomy"), "1girl, forest");
});

test("structured Base manual edit in multi-character display keeps recognized base tags (P3-B regression)", () => {
  const known = new Map([["1girl", "1girl"], ["forest", "forest"], ["blue eyes", "blue eyes"], ["nahida", "nahida"]]);
  // 用户在 Base 行手动加了 blue eyes -> display 与 displayPrompt 失同步
  const display = "Base: 1girl, forest, blue eyes\nCharacter 1: nahida\nGlobal UC: lowres";
  const baseText = naiStructuredBaseLine(display);
  assert.equal(baseText, "1girl, forest, blue eyes");
  const desired = extractRecognizedTagIdentities(baseText, known);
  // 只取 Base 行：Character 行的 nahida 不得被当作 Base 标签
  assert.deepEqual(desired, ["1girl", "forest", "blue eyes"]);
  assert.ok(!desired.includes("nahida"), "nahida 属于 Character，不得混入 Base 标签");
  // 现有 base 购物车标签不得被误删；新 Base 标签被识别补入
  const current = ["1girl", "forest"];
  assert.deepEqual(current.filter((key) => desired.includes(key)), ["1girl", "forest"], "现有 base 标签不被误删");
  assert.deepEqual(desired.filter((key) => !current.includes(key)), ["blue eyes"], "新 Base 标签被识别");
});

// ---- 5. P3 修复：结构化 char/global UC 购物车变更 -> 重建 display（用活 naiCharacters） ----
// 与 app.js setGenerationTargetText 的 char:N / global_uc 分支逐行一致的纯逻辑模拟（DOM 跳过）
function simulateStructuredTargetSync(draft, naiCharacters, target, text) {
  const synced = true; // display 与 displayPrompt 同步（本测试焦点）
  const promptEl = { value: draft.displayPrompt };
  const negEl = { value: draft.displayNegative };
  const rebuild = () => {
    draft.displayPrompt = naiStructuredDisplayText(draft.basePrompt, naiCharacters, draft.globalUc);
    promptEl.value = draft.displayPrompt;
  };
  if (target === "global_uc") {
    negEl.value = text;
    draft.globalUc = text;
    draft.displayNegative = text;
    if (synced) rebuild();
  } else {
    const m = String(target).match(/^char:(\d+)(:uc)?$/);
    const c = m && naiCharacters[Number(m[1])];
    if (c) {
      c[m[2] ? "negative_prompt" : "prompt"] = text;
      if (synced) rebuild();
    }
  }
  return { promptEl, negEl };
}

test("structured char/global UC cart sync rebuilds display from live naiCharacters (P3-A)", () => {
  const draft = {
    displayPrompt: "Base: 1girl\nCharacter 1: nahida\nGlobal UC: lowres",
    displayNegative: "lowres",
    basePrompt: "1girl",
    globalUc: "lowres",
  };
  const naiCharacters = [{ prompt: "nahida", negative_prompt: "", position: null }];

  // 购物车 char:0 变更 -> 更新活角色 + 用活 naiCharacters 重建 displayPrompt
  const afterChar = simulateStructuredTargetSync(draft, naiCharacters, "char:0", "nahida, blue eyes");
  assert.equal(naiCharacters[0].prompt, "nahida, blue eyes");
  assert.equal(afterChar.promptEl.value, "Base: 1girl\nCharacter 1: nahida, blue eyes\nGlobal UC: lowres");
  assert.equal(draft.displayPrompt, afterChar.promptEl.value, "displayPrompt 与 textarea 保持一致");
  assert.ok(naiStructuredRequest(draft)(afterChar.promptEl.value, draft.displayNegative), "char 同步后 structured request 仍有效");

  // 购物车 global_uc 变更 -> 更新 #nai-neg + displayNegative + globalUc + 重建 display
  const afterUc = simulateStructuredTargetSync(draft, naiCharacters, "global_uc", "lowres, bad anatomy");
  assert.equal(draft.globalUc, "lowres, bad anatomy");
  assert.equal(draft.displayNegative, "lowres, bad anatomy");
  assert.equal(afterUc.negEl.value, "lowres, bad anatomy", "#nai-neg 与 displayNegative 一致");
  assert.equal(afterUc.promptEl.value, "Base: 1girl\nCharacter 1: nahida, blue eyes\nGlobal UC: lowres, bad anatomy");
  assert.ok(naiStructuredRequest(draft)(afterUc.promptEl.value, afterUc.negEl.value), "global UC 同步后 structured request 仍有效");
});

// ---- 6. P3 修复：接受 autocomplete 建议不再立即重开弹窗 ----

test("naiAutocompleteSkipSearch suppresses only the just-accepted tag query (P3-D)", () => {
  assert.equal(naiAutocompleteSkipSearch("blue eyes", "blue eyes"), true, "光标停在刚接受的 tag 内 -> 抑制");
  assert.equal(naiAutocompleteSkipSearch("blue eyes", "blue eyes, solo"), false, "用户继续输入 -> 不抑制");
  assert.equal(naiAutocompleteSkipSearch("blue eyes", "blu"), false, "query 不同 -> 不抑制");
  assert.equal(naiAutocompleteSkipSearch(null, "blue eyes"), false, "无接受标记 -> 不抑制");
  assert.equal(naiAutocompleteSkipSearch(undefined, ""), false);
});

test("accepting a suggestion leaves caret inside the completed tag so re-search is suppressed", () => {
  // acceptNaiAutocomplete 机制：replacePromptToken 替换 token 后光标落在完整 tag 末尾
  const value = replacePromptToken("1girl, blue e", 13, "blue eyes");
  assert.equal(value, "1girl, blue eyes");
  const caret = value.indexOf("blue eyes") + "blue eyes".length;
  const query = promptTokenRange(value, caret).query;
  assert.equal(query, "blue eyes");
  assert.equal(naiAutocompleteSkipSearch("blue eyes", query), true, "接受后立即重开被抑制");
});

// ---- BUG 1 回归：replacePromptTokenWithCaret 可靠返回 value + caret（不落到 tag 内部）----

test("replacePromptTokenWithCaret returns value and caret at end of inserted tag (BUG 1)", () => {
  // 输入 `1girl, blue e|`，候选 `blue eyes`，替换后为 `1girl, blue eyes`，caret 在 tag 末尾而非内部
  const { value, caret } = replacePromptTokenWithCaret("1girl, blue e", 13, "blue eyes");
  assert.equal(value, "1girl, blue eyes");
  assert.equal(caret, value.length, "caret 落在插入 tag 末尾，即整串末尾");
  assert.equal(value.slice(caret - "blue eyes".length, caret), "blue eyes", "caret 正处 tag 末尾");
  // caret 落在完整 tag 内 -> 触发抑制，弹窗不重开
  const query = promptTokenRange(value, caret).query;
  assert.equal(query, "blue eyes");
  assert.equal(naiAutocompleteSkipSearch("blue eyes", query), true);
});

test("replacePromptTokenWithCaret keeps caret at end even when caret was inside the token", () => {
  // caret 在 token 中部：left 空白保留，替换后 caret 仍在 tag 末尾
  const { value, caret } = replacePromptTokenWithCaret("1girl, bl", 9, "blue eyes");
  assert.equal(value, "1girl, blue eyes");
  assert.equal(caret, value.length);
});

test("replacePromptTokenWithCaret preserves leading whitespace and following text", () => {
  // token 前有空白、tag 后有后续 token 时，leading whitespace 与后续文本均保留
  const { value, caret } = replacePromptTokenWithCaret("1girl,  blue e , masterpiece", 13, "blue eyes");
  assert.equal(value, "1girl,  blue eyes , masterpiece");
  assert.equal(value.slice(caret - "blue eyes".length, caret), "blue eyes", "caret 仍在 tag 末尾，非 tag 内部");
});

// ---- BUG 2 回归：高级工作区 Tab 切换同步 state.target（pure helper workspaceTabToTarget）----

test("workspaceTabToTarget maps workspace tab to state.target (BUG 2)", () => {
  assert.equal(workspaceTabToTarget("base"), "base", "Base tab -> base");
  assert.equal(workspaceTabToTarget("0"), "char:0", "Character 1 -> char:0");
  assert.equal(workspaceTabToTarget("1"), "char:1", "Character 2 -> char:1");
  assert.equal(workspaceTabToTarget(2), "char:2", "数字下标也映射为 char:N");
});

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

// ---- 4. 翻译一致性（P2 修复）----

// 与 app.js translateFreeText 逐行一致的纯逻辑模拟（DOM/api 打桩）
// currentDomAfter：请求返回时刻 #free-text 的 DOM 值（模拟防抖窗口/请求期间用户继续输入）
async function simulateTranslateFreeText({ domValue, currentDomAfter, state, translation }) {
  // app.js: const el = $("#free-text"); const raw = (el?.value ?? state.prompt.free_text).trim();
  const el = domValue != null ? { value: domValue } : null;
  const raw = (el?.value ?? state.prompt.free_text).trim();
  if (!raw) return { accepted: false, reason: "empty", state };
  // app.js: if (el && el.value !== state.prompt.free_text) { sync + use=false }（freeTextRawSync.cancel() 无 DOM 副作用）
  if (el && el.value !== state.prompt.free_text) {
    state.prompt.free_text = el.value;
    state.prompt.use_free_text_en = false;
  }
  const r = { translated: translation }; // await api("/api/translate", ...)
  // app.js: 仅当当前文本仍等于请求原文才接受译文
  const current = currentDomAfter != null ? currentDomAfter : (el?.value ?? state.prompt.free_text);
  if (!shouldAcceptTranslation(raw, current)) return { accepted: false, reason: "changed", state };
  state.prompt.free_text_en = r.translated || "";
  state.prompt.use_free_text_en = !!state.prompt.free_text_en;
  return { accepted: true, state };
}

// 与 app.js applyImported / applyImportedPreview free_text 分支逐行一致的纯逻辑模拟
function simulateImportFreeText({ current, incoming, mode, useFreeTextEn }) {
  const state = { prompt: { free_text: current, use_free_text_en: useFreeTextEn } };
  // app.js: if (incoming.free_text) { const merged = mergeImportedFreeText(...); if (merged !== ...) { ... } }
  if (incoming) {
    const merged = mergeImportedFreeText(state.prompt.free_text, incoming, mode);
    if (merged !== state.prompt.free_text) {
      state.prompt.free_text = merged;
      if (mode !== "replace") state.prompt.use_free_text_en = false;
    }
  }
  return state.prompt;
}

test("shouldAcceptTranslation only accepts when current text equals requested raw", () => {
  assert.equal(shouldAcceptTranslation("一只猫", "一只猫"), true);
  assert.equal(shouldAcceptTranslation("一只猫", "一只猫  "), true, "尾部空白不视为变化");
  assert.equal(shouldAcceptTranslation("一只猫", "一只狗"), false, "原文已变化则丢弃");
  assert.equal(shouldAcceptTranslation("", ""), true);
});

test("mergeImportedFreeText appends with newline, replaces in replace mode", () => {
  assert.equal(mergeImportedFreeText("一只猫", "在屋顶", "append"), "一只猫\n在屋顶");
  assert.equal(mergeImportedFreeText("", "在屋顶", "append"), "在屋顶");
  assert.equal(mergeImportedFreeText("一只猫", "在屋顶", "replace"), "在屋顶");
  assert.equal(mergeImportedFreeText("一只猫", "", "append"), "一只猫", "空 incoming 不改动当前值");
});

test("translateFreeText within debounce window translates the latest DOM text, not stale state", async () => {
  // 用户最后输入后 180ms 内点击：state 仍是旧文本，DOM 是新文本
  const state = { prompt: { free_text: "旧文本", free_text_en: "Old text", use_free_text_en: true } };
  const out = await simulateTranslateFreeText({ domValue: "新文本", currentDomAfter: "新文本", state, translation: "New text" });
  assert.equal(out.accepted, true);
  assert.equal(state.prompt.free_text, "新文本", "DOM 新文本已同步进 state");
  assert.equal(state.prompt.free_text_en, "New text", "翻译的是最新文本");
  assert.equal(state.prompt.use_free_text_en, true, "请求原文未变 -> 译文生效");
});

test("translateFreeText discards stale result when raw changed during flight", async () => {
  const state = { prompt: { free_text: "旧文本", free_text_en: "Old text", use_free_text_en: false } };
  // 请求发出后用户又改了原文
  const out = await simulateTranslateFreeText({ domValue: "新文本", currentDomAfter: "新文本2", state, translation: "New text" });
  assert.equal(out.accepted, false);
  assert.equal(out.reason, "changed");
  assert.equal(state.prompt.free_text_en, "Old text", "旧译文/响应译文都不得覆盖");
  assert.equal(state.prompt.use_free_text_en, false, "use 标志不得复活为 true");
});

test("translateFreeText no-edit re-translate keeps behavior unchanged", async () => {
  const state = { prompt: { free_text: "一只猫", free_text_en: "Old en", use_free_text_en: true } };
  const out = await simulateTranslateFreeText({ domValue: "一只猫", state, translation: "A cat" });
  assert.equal(out.accepted, true);
  assert.equal(state.prompt.free_text_en, "A cat");
  assert.equal(state.prompt.use_free_text_en, true);
});

test("import append actually changing free_text invalidates use_free_text_en; replace keeps behavior", () => {
  // append：旧译文不得继续作为 effective
  const appended = simulateImportFreeText({ current: "一只猫", incoming: "在屋顶", mode: "append", useFreeTextEn: true });
  assert.equal(appended.free_text, "一只猫\n在屋顶");
  assert.equal(appended.use_free_text_en, false, "append 改变 free_text -> 旧译文失效");
  // append 时 use 本为 false：保持 false
  const appended2 = simulateImportFreeText({ current: "一只猫", incoming: "在屋顶", mode: "append", useFreeTextEn: false });
  assert.equal(appended2.use_free_text_en, false);
  // replace（非 base 目标替换路径）：free_text 替换，use 标志保持（现有行为）
  const replaced = simulateImportFreeText({ current: "一只猫", incoming: "在屋顶", mode: "replace", useFreeTextEn: true });
  assert.equal(replaced.free_text, "在屋顶");
  assert.equal(replaced.use_free_text_en, true, "replace 路径行为保持");
  // 空 incoming：不改动
  const untouched = simulateImportFreeText({ current: "一只猫", incoming: "", mode: "append", useFreeTextEn: true });
  assert.equal(untouched.free_text, "一只猫");
  assert.equal(untouched.use_free_text_en, true);
});
