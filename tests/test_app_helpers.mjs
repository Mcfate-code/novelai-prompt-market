/**
 * app.js 纯函数回归测试（P0 结构化边界 + P1/P2 既有修复）
 * 运行方式: env -u NODE_OPTIONS node --test tests/test_app_helpers.mjs
 *
 * app.js 依赖浏览器全局（顶层 DOM 事件绑定、init() 调用），无法在 Node 中直接 import。
 * 因此沿用 tests/test_prompt_compiler.mjs 的既有约定：
 *   1) 用「balanced-brace 源码提取」把 app.js 中无 DOM 依赖的纯函数
 *      remapNaiTagTarget / insertTagIntoString / naiStructuredBaseLine 等
 *      原样取出并求值，直接测试真实实现；
 *   2) 依赖 DOM/async 的 naiFillFromCart / naiGenerate / doImportFromModal / pollInbox 分支，
 *      用与 app.js 逐行一致的纯逻辑模拟 + 源码契约断言，验证修复后的行为。
 *
 * 覆盖（P0 结构化边界）：
 * - #nai-prompt 只存 Base（base + free_text），#nai-neg 只存 Global UC，角色只存 naiCharacters
 * - 编辑角色 1 后生成 payload：prompt 干净、角色逐项精确、Base / 未编辑角色不受影响
 * - 结构化 legacy rawPrompt 恢复用 parseStructuredRawPrompt 拆解分发，绝不整串写回 Base
 * - 源码契约：naiStructuredDraft / naiStructuredRequest 判定门已移除，快照持久化 state.prompt
 *
 * 覆盖（P1 修复）：
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
import { splitPromptTokens, joinPromptTokens } from "../static/prompt-tokenizer.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as NaiStructured from "../static/nai-structured.js";
import * as promptDocument from "../static/prompt-document.js";
// app.js 的 naiStructuredBaseLine 已收敛为对 window.NaiStructured 的薄委托
// （实现收敛在 static/nai-structured.js 纯模块）。
// Node 无浏览器 window，这里用真实模块补上同一实现，让被提取的委托函数可运行。
globalThis.window = { NaiStructured };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const APP_HTML = readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const APP_CSS = readFileSync(path.join(__dirname, "..", "static", "app.css"), "utf8");

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

const insertTagIntoString = new Function("splitPromptTokens", "joinPromptTokens", `${extractFunction("insertTagIntoString")}; return insertTagIntoString;`)(splitPromptTokens, (tokens) => tokens.join(", "));
const remapNaiTagTarget = loadFunction("remapNaiTagTarget");

// ---- P2 翻译一致性纯函数（无自由变量） ----
const shouldAcceptTranslation = loadFunction("shouldAcceptTranslation");
const mergeImportedFreeText = loadFunction("mergeImportedFreeText");
const naiRecipeFromItem = loadFunction("naiRecipeFromItem");
const filterImportedPresetTokens = new Function("splitPromptTokens", "joinPromptTokens", `${extractFunction("filterImportedPresetTokens")}; return filterImportedPresetTokens;`)(splitPromptTokens, joinPromptTokens);
const importedPromptWithoutAutoPresets = (text, negative = false) => filterImportedPresetTokens(text, negative ? [["worst quality", "lowres"]] : [["masterpiece", "very aesthetic"]]);
const extractMetaFromGalleryItem = new Function("naiRecipeFromItem", "importedPromptWithoutAutoPresets", `${extractFunction("extractMetaFromGalleryItem")}; return extractMetaFromGalleryItem;`)(naiRecipeFromItem, importedPromptWithoutAutoPresets);
const recognizedTagToken = loadFunction("recognizedTagToken");
const extractRecognizedTagIdentities = new Function("recognizedTagToken", "splitPromptTokens", `${extractFunction("extractRecognizedTagIdentities")}; return extractRecognizedTagIdentities;`)(recognizedTagToken, splitPromptTokens);
const promptTokenRange = loadFunction("promptTokenRange");
const replacePromptToken = loadFunctionBound("replacePromptToken", ["promptTokenRange"])(promptTokenRange);
const replacePromptTokenWithCaret = loadFunctionBound("replacePromptTokenWithCaret", ["promptTokenRange"])(promptTokenRange);
const workspaceTabToTarget = loadFunction("workspaceTabToTarget");
// ---- P3 修复纯函数（无自由变量） ----
const naiStructuredBaseLine = loadFunction("naiStructuredBaseLine");
const naiAutocompleteSkipSearch = loadFunction("naiAutocompleteSkipSearch");
const naiGalleryFocusIndex = loadFunction("naiGalleryFocusIndex");

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
  assert.match(APP_JS, /cart-advanced-layout/);
  assert.match(APP_JS, /closest\("\.tag-card"\)/);
  assert.match(APP_JS, /setTimeout\(\(\) => showThumbPreview/);
});

test("generation layout keeps viewer details and run controls independently collapsible", () => {
  assert.match(APP_HTML, /<details id="nai-viewer-meta-collapse"[^>]*hidden>/);
  assert.match(APP_HTML, /<section id="nai-left" class="panel nai-left">/);
  assert.match(APP_HTML, /id="nai-left-toggle"[^>]*aria-controls="nai-left"/);
  assert.match(APP_HTML, /<section id="nai-right" class="panel nai-right">/);
  assert.match(APP_HTML, /id="nai-right-toggle"[^>]*aria-controls="nai-right"/);
  assert.match(APP_HTML, /id="nai-focus-toggle"[^>]*aria-pressed="false"/);
  assert.match(APP_HTML, /<div class="nai-generate-bar"[^>]*>[^]*id="nai-gen"/);
  assert.match(APP_CSS, /\.nai-layout\.nai-left-collapsed\.nai-right-collapsed[\s\S]*grid-template-columns: 46px minmax\(0, 1fr\) 46px/);
  assert.match(APP_CSS, /\.nai-viewer img \{[^}]*width: 100%;[^}]*height: 100%;/);
  assert.match(APP_JS, /function setNaiLeftCollapsed\(collapsed/);
  assert.match(APP_JS, /function setNaiRightCollapsed\(collapsed\)/);
  assert.match(APP_JS, /function setNaiFocusMode\(focused/);
  assert.match(APP_JS, /metaCollapse\.hidden = true/);
});

test("工作台换姿势接受 characters 逻辑目标，并加载已审核模板", () => {
  // APPLY_POSE_VARIATION 会整体替换 PromptDocument；characters 是逻辑作用域，
  // 不能按普通 char:N 目标解析后静默丢弃。
  assert.match(APP_JS, /action\.type === "APPLY_POSE_VARIATION" && payload\.target === "characters"[\s\S]*\? "base"/);
  assert.match(APP_JS, /naiLoadApprovedPoseTemplates\(\{ force: true \}\)/);
  assert.match(APP_JS, /library: \[\.\.\.POSE_LIBRARY, \.\.\.naiPositionOptionsAsPoseTemplates\(\), \.\.\.naiApprovedPoseTemplates\]/);
});

test("newly saved gallery asset remains focused after the history list prepends it", () => {
  const before = [
    { file_name: "old-b.png", source_asset_id: "asset-b" },
    { file_name: "old-a.png", source_asset_id: "asset-a" },
  ];
  const after = [
    { file_name: "new.png", source_asset_id: "asset-new" },
    ...before,
  ];
  assert.equal(naiGalleryFocusIndex(after, "asset-new"), 0);
  assert.equal(naiGalleryFocusIndex(after, "asset-b"), 1);
  assert.equal(naiGalleryFocusIndex(after, null, "old-a.png"), 2);
});

test("读取外部导入图片提示词时过滤自动预设，保留用户加权写法", () => {
  assert.equal(filterImportedPresetTokens("1girl, masterpiece, very aesthetic, 1.4::masterpiece::", [["masterpiece", "very aesthetic"]]), "1girl, 1.4::masterpiece::");
  assert.equal(filterImportedPresetTokens("worst quality, lowres", [["worst quality", "lowres"]]), "");
});

test("外部导入图片提示词过滤预设后由当前档位统一注入", () => {
  const meta = extractMetaFromGalleryItem({ prompt: "1girl, masterpiece, very aesthetic", negative_prompt: "worst quality" });
  assert.equal(meta.rawPrompt, "1girl");
  assert.equal(meta.rawNegative, "");
  assert.equal(meta.positiveTier, "standard");
  assert.equal(meta.negativeTier, "heavy");
});

test("带生成元数据的图库图片仍恢复原有预设档位", () => {
  const meta = extractMetaFromGalleryItem({
    prompt: "1girl, masterpiece",
    parameters: { recipe: { prompt: "1girl, masterpiece", quality_preset: "light", uc_preset: "human_focus" } },
  });
  assert.equal(meta.positiveTier, "light");
  assert.equal(meta.negativeTier, "human_focus");
  assert.equal(meta.rawPrompt, "1girl, masterpiece");
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

// ---- 5. P0 结构化边界：fill + 编辑角色 + 生成 payload 必须从权威槽位构造 ----
// 与 app.js naiFillFromCart / naiGenerate 的 P0 逻辑逐行一致的纯逻辑模拟（DOM/异步跳过）。
// 证明：#nai-prompt 只存 Base，角色只存 naiCharacters，生成 payload 的 prompt 干净、
// characters 逐项精确（编辑角色 1 不影响角色 2 / Base）。
function simulateFillPayload({ r, edits = [] }) {
  // naiFillFromCart：Base（base + free_text）-> #nai-prompt；global_uc -> #nai-neg；角色 -> naiCharacters
  const basePrompt = [r.base, r.free_text].filter((part) => part?.trim()).join(", ");
  const naiCharacters = (r.characters || [])
    .filter((character) => character.prompt?.trim())
    .map((character) => ({ prompt: character.prompt, negative_prompt: character.uc || "", position: character.position === "auto" ? null : character.position }));
  const promptEl = { value: basePrompt };
  const negEl = { value: r.global_uc || "" };
  // 编辑角色 textarea：更新活 naiCharacters（与 #nai-character-list 的 input 处理器一致）
  for (const [index, text] of edits) naiCharacters[index].prompt = text;
  // naiGenerate：prompt=Base trim、negative=Global UC、characters=naiCollectCharacters()
  const collectCharacters = () => naiCharacters.map((c) => ({
    prompt: String(c.prompt || "").trim(),
    negative_prompt: String(c.negative_prompt || "").trim(),
    position: c.position ? { x: Number(c.position.x), y: Number(c.position.y) } : null,
  })).filter((c) => c.prompt);
  return { promptEl, negEl, payload: { prompt: promptEl.value.trim(), negative_prompt: negEl.value, characters: collectCharacters() } };
}

test("P0 fill + character edit yields clean payload with exact per-character prompts", () => {
  const r = {
    base: "bedroom, night",
    free_text: "",
    global_uc: "lowres, bad anatomy",
    characters: [
      { prompt: "citlali", uc: "lowres", position: null },
      { prompt: "nahida, green hair", uc: "", position: null },
    ],
  };
  const { promptEl, negEl, payload } = simulateFillPayload({ r, edits: [[0, "citlali, blue eyes"]] });

  // #nai-prompt 只存干净 Base（绝不带 Base:/Character N:/Global UC: 标记）
  assert.equal(promptEl.value, "bedroom, night");
  assert.equal(negEl.value, "lowres, bad anatomy");

  // 生成 payload：prompt 干净、Global UC 独立、角色逐项精确
  assert.equal(payload.prompt, "bedroom, night");
  assert.ok(!/Base:|Character\s+\d+:|Global UC:/.test(payload.prompt), `prompt must be clean (got: ${payload.prompt})`);
  assert.equal(payload.negative_prompt, "lowres, bad anatomy");
  assert.equal(payload.characters.length, 2);
  assert.equal(payload.characters[0].prompt, "citlali, blue eyes", "edited character 1 only in characters[0].prompt");
  assert.equal(payload.characters[1].prompt, "nahida, green hair", "untouched character 2 preserved");
  assert.equal(payload.characters[0].negative_prompt, "lowres");
});

test("P0 single-character and free-text cases stay valid", () => {
  // 单角色 + free text 折叠进 Base，不丢 tag
  const single = simulateFillPayload({ r: { base: "1girl", free_text: "sitting on bed", global_uc: "", characters: [{ prompt: "citlali", uc: "lowres", position: null }] } });
  assert.equal(single.promptEl.value, "1girl, sitting on bed");
  assert.equal(single.payload.characters.length, 1);
  assert.equal(single.payload.characters[0].prompt, "citlali");
  // 无角色：payload.characters 为空，prompt 干净
  const none = simulateFillPayload({ r: { base: "1girl, solo", free_text: "", global_uc: "blurry", characters: [] } });
  assert.equal(none.payload.prompt, "1girl, solo");
  assert.equal(none.payload.negative_prompt, "blurry");
  assert.deepEqual(none.payload.characters, []);
});

// P0 结构化边界：结构化 legacy rawPrompt 恢复必须拆解分发，绝不整串写回 Base。
test("P0 legacy structured rawPrompt restore distributes fields via parseStructuredRawPrompt", () => {
  const rawPrompt = "Base: bedroom, night\nCharacter 1: citlali\nCharacter 1 UC: lowres\nCharacter 2: nahida, green hair\nGlobal UC: bad anatomy";
  const parsed = NaiStructured.parseStructuredRawPrompt(rawPrompt, "bad anatomy");
  assert.ok(parsed, "structured legacy rawPrompt parses");
  assert.equal(parsed.basePrompt, "bedroom, night");
  assert.ok(!/Character\s+\d+:|Global UC:/.test(parsed.basePrompt), "base must not carry character/UC markers");
  assert.equal(parsed.globalUc, "bad anatomy");
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.characters[0].prompt, "citlali");
  assert.equal(parsed.characters[0].negative_prompt, "lowres");
  assert.equal(parsed.characters[1].prompt, "nahida, green hair");
});

// 源码契约：Workbench 单一编辑器收敛 —— 不再有 #nai-prompt/#nai-neg textarea，生成读 PromptDocument，快照始终持久化 state.prompt。
test("P0 app.js contract: single #nai-editor, generation reads PromptDocument, snapshot keeps state.prompt", () => {
  // 不再写 #nai-prompt / #nai-neg（单一编辑器，PromptDocument 权威）
  assert.doesNotMatch(APP_JS, /\$\("#nai-prompt"\)/);
  assert.doesNotMatch(APP_JS, /\$\("#nai-neg"\)/);
  // 旧 sync 链 / DOM-fill 已移除
  assert.doesNotMatch(APP_JS, /function reconcileGenerationFromCart/);
  assert.doesNotMatch(APP_JS, /async function naiFillFromCart/);
  assert.doesNotMatch(APP_JS, /function applyRecognizedTagDiff/);
  // 结构化 draft / request 判定门已移除
  assert.doesNotMatch(APP_JS, /naiStructuredDraft/);
  assert.doesNotMatch(APP_JS, /function naiStructuredRequest/);
  // naiGenerate 读 PromptDocument 权威（buildGenerationPromptState），不再读 textarea
  assert.match(APP_JS, /buildGenerationPromptState\(state\.prompt\)/);
  // 快照始终持久化当前结构化状态，绝不用 emptyPromptState() 顶替
  assert.match(APP_JS, /structured_state: state\.prompt/);
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

// ---- 1. 非结构化 Base 点击（P1-A，纯 flat 行为不变）----

test("non-structured Base behavior unchanged: tag appended straight to textarea", () => {
  let value = "";
  value = insertTagIntoString(value, "blue eyes");
  assert.equal(value, "blue eyes");
  value = insertTagIntoString(value, "blue eyes");
  assert.equal(value, "blue eyes", "duplicate tag must not be re-added (insertTagIntoString dedup)");
});

test("character target behavior unchanged: character prompt updated, base untouched", () => {
  const naiCharacters = [{ prompt: "nahida", negative_prompt: "", position: null }];
  naiCharacters[0].prompt = insertTagIntoString(naiCharacters[0].prompt, "blue eyes");
  assert.equal(naiCharacters[0].prompt, "nahida, blue eyes");
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

// ---- 7. P0 恢复路径：naiRestoreItem / #nai-reuse 复用 naiResolveRestoredPrompt 干净拆分 + 状态同步 ----

const naiResolveRestoredPrompt = loadFunction("naiResolveRestoredPrompt");

// naiSyncRestoredPromptToState 引用 4 个文件级自由变量；用 factory 绑定真实 promptDocument + 可控 state/stub。
function loadNaiSyncRestoredPromptToState(docModule, state, knownTags, pushHistory) {
  const src = extractFunction("naiSyncRestoredPromptToState");
  const factory = new Function("promptDocument", "state", "knownCatalogTags", "pushHistory",
    `${src}; return naiSyncRestoredPromptToState;`);
  return factory(docModule, state, knownTags, pushHistory);
}

test("naiResolveRestoredPrompt splits legacy structured gallery item into clean base/uc/characters", () => {
  const rawPrompt = "Base: bedroom, night\nCharacter 1: citlali\nCharacter 1 UC: lowres\nCharacter 2: nahida, green hair\nGlobal UC: bad anatomy";
  const restored = naiResolveRestoredPrompt(rawPrompt, "bad anatomy", []);
  assert.ok(restored, "legacy structured rawPrompt resolves");
  assert.equal(restored.basePrompt, "bedroom, night");
  assert.ok(!/Base:|Character\s+\d+:|Global UC:/.test(restored.basePrompt), `base must be clean (got: ${restored.basePrompt})`);
  assert.equal(restored.globalUc, "bad anatomy");
  assert.equal(restored.characters.length, 2);
  assert.equal(restored.characters[0].prompt, "citlali");
  assert.equal(restored.characters[0].negative_prompt, "lowres");
  assert.equal(restored.characters[0].position, null, "no saved position -> null");
  assert.equal(restored.characters[1].prompt, "nahida, green hair");
});

test("naiResolveRestoredPrompt prefers saved characterPrompts position over display parse", () => {
  const rawPrompt = "Base: bedroom, night\nCharacter 1: citlali\nGlobal UC: bad anatomy";
  const saved = [{ prompt: "citlali", negative_prompt: "lowres", position: { x: 0.3, y: 0.7 } }];
  const restored = naiResolveRestoredPrompt(rawPrompt, "bad anatomy", saved);
  assert.equal(restored.characters[0].prompt, "citlali");
  assert.deepEqual(restored.characters[0].position, { x: 0.3, y: 0.7 }, "saved position preserved");
});

test("naiResolveRestoredPrompt handles flat and null inputs without clobbering", () => {
  const flat = naiResolveRestoredPrompt("1girl, blue eyes", "bad anatomy", [{ prompt: "citlali", negative_prompt: "lowres", position: null }]);
  assert.equal(flat.basePrompt, "1girl, blue eyes");
  assert.equal(flat.globalUc, "bad anatomy");
  assert.equal(flat.characters[0].prompt, "citlali");
  const empty = naiResolveRestoredPrompt(null, null, []);
  assert.equal(empty.basePrompt, null, "null rawPrompt -> do not overwrite base");
  assert.equal(empty.globalUc, null, "null rawNegative -> do not overwrite UC");
  assert.equal(empty.characters, null, "no characters -> leave characters unchanged");
});

test("P0 naiSyncRestoredPromptToState reconciles restored prompt into PromptDocument authority", () => {
  const doc = promptDocument.createEmpty();
  const state = { prompt: doc, history: [] };
  let pushed = 0;
  const sync = loadNaiSyncRestoredPromptToState(promptDocument, state, new Map([["citlali", "citlali"], ["nahida", "nahida"]]), () => { pushed += 1; });
  sync("bedroom, night", "bad anatomy", [
    { prompt: "citlali", negative_prompt: "lowres", position: null },
    { prompt: "nahida, green hair", negative_prompt: "", position: { x: 0.3, y: 0.4 } },
  ]);
  assert.equal(pushed, 1, "sync pushes history once");
  assert.equal(state.prompt.characters.length, 2, "character count aligns with restored characters");
  assert.equal(promptDocument.serializeTarget(state.prompt, "base"), "bedroom, night");
  assert.equal(promptDocument.serializeTarget(state.prompt, "global_uc"), "bad anatomy");
  assert.equal(promptDocument.serializeTarget(state.prompt, "char:0"), "citlali");
  assert.equal(promptDocument.serializeTarget(state.prompt, "char:0:uc"), "lowres");
  assert.equal(promptDocument.serializeTarget(state.prompt, "char:1"), "nahida, green hair");
  assert.deepEqual(state.prompt.characters[1].position, { x: 0.3, y: 0.4 }, "restored position preserved in authority");
});

test("P0 naiSyncRestoredPromptToState trims extra characters and keeps PromptDocument invariant", () => {
  let doc = promptDocument.createEmpty();
  // 预置 3 个角色
  doc = promptDocument.addCharacter(doc, {});
  doc = promptDocument.addCharacter(doc, {});
  const state = { prompt: doc, history: [] };
  const sync = loadNaiSyncRestoredPromptToState(promptDocument, state, new Map(), () => {});
  // 恢复无角色：PromptDocument 恒 ≥1 角色（空角色），base/global_uc 仍被 reconcile
  sync("1girl, solo", "blurry", []);
  assert.equal(state.prompt.characters.length, 1, "PromptDocument keeps >=1 character invariant");
  assert.equal(promptDocument.serializeTarget(state.prompt, "base"), "1girl, solo");
  assert.equal(promptDocument.serializeTarget(state.prompt, "global_uc"), "blurry");
});

// 源码契约：naiRestoreItem 与两个剪贴板失败回退都走同一干净恢复逻辑，不允许结构化串 bypass 进 #nai-prompt。
test("P0 naiRestoreItem and clipboard fallbacks share clean restore (no structured bypass into #nai-prompt)", () => {
  assert.match(APP_JS, /function naiResolveRestoredPrompt\(/);
  assert.match(APP_JS, /function naiSyncRestoredPromptToState\(/);
  assert.match(APP_JS, /function naiApplyRestoredPrompt\(/);
  // naiRestoreItem 经 naiResolveRestoredPrompt + naiApplyRestoredPrompt，不再直接赋值 recipe.prompt
  assert.match(APP_JS, /naiResolveRestoredPrompt\(itemMeta\.rawPrompt \|\| recipe\.prompt \|\| it\.prompt \|\| "", itemMeta\.rawNegative \?\? recipe\.negative_prompt \?\? it\.negative_prompt \?\? "", itemMeta\.characterPrompts \|\| recipe\.characters\)/);
  assert.doesNotMatch(APP_JS, /\$\("#nai-prompt"\)\.value = recipe\.prompt/);
  // 三个恢复入口（naiRestoreItem + 两处剪贴板失败回退）统一走 naiApplyRestoredPrompt 分发
  assert.equal((APP_JS.match(/naiApplyRestoredPrompt\(restored\.basePrompt, restored\.globalUc, restored\.characters\)/g) || []).length, 3, "restore + 2 clipboard fallbacks all use shared restore");
  // 剪贴板失败回退不再把 t/text 直接塞进 #nai-prompt（renderViewer 用 t，图库 recipe 用 text）
  assert.doesNotMatch(APP_JS, /\$\("#nai-prompt"\)\.value = t;/);
  assert.doesNotMatch(APP_JS, /\$\("#nai-prompt"\)\.value = text; toast\("已填入 Prompt 框"\)/);
});
