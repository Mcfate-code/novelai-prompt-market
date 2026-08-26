/**
 * Phase 2 Prompt Input / Autocomplete 键盘契约测试（static/nai-input-keys.js）。
 * 运行方式: node --test tests/test_nai_input_keys.mjs
 *
 * 覆盖：方向键导航（回卷/边界）、Tab 接受 + 分隔符 `, `、Esc 关闭、
 * 单 Enter 永远换行（弹窗打开也不接受）、Enter×2 在 300–400ms 窗口内恰好生成一次
 * 并撤销额外空行（不抹既有换行）、IME composing 不计 double-enter 不生成、
 * 鼠标接受契约、double-enter 状态复位、popup 主题变量 scope（:root 稳定公共 scope，
 * 覆盖层不透明、无 opacity hack）、hint 文案与转义、有状态 controller 接线。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_DOUBLE_ENTER_MS,
  ACCEPT_DELIMITER,
  HINT_TEXT,
  isComposing,
  moveSelection,
  clampSelection,
  stepDoubleEnter,
  classifyPopupKey,
  acceptActionFor,
  mouseAcceptAction,
  delimiterToAppend,
  trailingNewlineRange,
  removeRange,
  handleKeydown,
  createNaiInputKeys,
  buildHintHtml,
} from "../static/nai-input-keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(path.join(__dirname, "..", "static", "app.css"), "utf8");

function keyEvent(key, extra = {}) {
  return { key, preventDefault() {}, ...extra };
}

// ---- 1. 方向键导航 ----

test("moveSelection wraps forward/backward and guards empty lists", () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0, "末尾向下回卷到开头");
  assert.equal(moveSelection(0, -1, 3), 2, "开头向上回卷到末尾");
  assert.equal(moveSelection(0, 99, 4), 3, "大步长取模");
  assert.equal(moveSelection(0, 1, 0), 0, "空列表不导航");
  assert.equal(moveSelection(0, 1, -1), 0, "非法长度不导航");
});

test("clampSelection keeps selected within bounds", () => {
  assert.equal(clampSelection(0, 3), 0);
  assert.equal(clampSelection(5, 3), 2, "越界夹到末项");
  assert.equal(clampSelection(-1, 3), 0, "负值夹到首项");
  assert.equal(clampSelection(0, 0), 0, "空列表返回 0");
});

test("popup keys: arrows navigate, Tab accepts with delimiter, Esc closes", () => {
  const results = [{ tag: "blue eyes" }, { tag: "solo" }, { tag: "1girl" }];
  assert.deepEqual(classifyPopupKey(keyEvent("ArrowDown"), { open: true, results, selected: 0 }),
    { action: "navigate", direction: 1, index: 1, preventDefault: true });
  assert.deepEqual(classifyPopupKey(keyEvent("ArrowUp"), { open: true, results, selected: 0 }),
    { action: "navigate", direction: -1, index: 2, preventDefault: true }, "向上回卷");
  assert.deepEqual(classifyPopupKey(keyEvent("Tab"), { open: true, results, selected: 1 }),
    { action: "accept", index: 1, tag: "solo", delimiter: ACCEPT_DELIMITER, preventDefault: true });
  assert.deepEqual(classifyPopupKey(keyEvent("Escape"), { open: true, results, selected: 0 }),
    { action: "close", preventDefault: true });
});

test("popup closed or irrelevant keys pass through untouched", () => {
  const results = [{ tag: "a" }];
  assert.equal(classifyPopupKey(keyEvent("Tab"), { open: false, results }).action, "none");
  assert.equal(classifyPopupKey(keyEvent("ArrowDown"), { open: false, results }).action, "none");
  assert.equal(classifyPopupKey(keyEvent("a"), { open: true, results }).action, "none", "普通键不拦截");
  assert.equal(classifyPopupKey(keyEvent("Tab"), { open: true, results: [] }).action, "none", "空结果不产生 accept");
  const clamped = classifyPopupKey(keyEvent("Tab"), { open: true, results, selected: 9 });
  assert.deepEqual(clamped, { action: "accept", index: 0, tag: "a", delimiter: ACCEPT_DELIMITER, preventDefault: true }, "selected 越界夹到末项后接受");
  assert.equal(classifyPopupKey(null, { open: true, results }).action, "none");
});

// ---- 2. 单 Enter 永远换行 ----

test("single Enter is always a newline even when the popup is open", () => {
  const action = handleKeydown(keyEvent("Enter"), {
    popup: { open: true, results: [{ tag: "blue eyes" }], selected: 0 },
    doubleEnter: {},
  });
  assert.equal(action.action, "newline", "弹窗打开时 Enter 也绝不接受候选");
  assert.equal(action.preventDefault, undefined, "换行不拦截，交还默认行为");
  assert.ok(action.nextDoubleEnter, "double-enter 状态前进到 first-enter");
});

test("unrelated keys pass through untouched", () => {
  assert.equal(handleKeydown(keyEvent("a"), { popup: { open: false } }).action, "none");
  assert.equal(handleKeydown(keyEvent("Shift"), { popup: { open: true, results: [{ tag: "a" }], selected: 0 } }).action, "none");
});

// ---- 3. Enter×2 双 Enter -> Generate 恰好一次 + 撤销额外空行 ----

test("Enter x2 within the window generates exactly once and undoes the extra newline", () => {
  let clock = 1000;
  const now = () => clock;
  const opts = { options: { now, doubleEnterMs: 350 } };

  const first = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: {} });
  assert.equal(first.action, "newline", "第一击 Enter 仍是换行");

  clock = 1000 + 350; // 窗口边缘（<=350ms）
  const second = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: first.nextDoubleEnter });
  assert.equal(second.action, "generate");
  assert.equal(second.undo, true, "第二击 Enter 产生的空行需撤销");
  assert.equal(second.preventDefault, true, "第二击 Enter 不插入空行（只撤销本次产生的额外空行）");
  assert.deepEqual(second.nextDoubleEnter, { lastEnterAt: null }, "生成后计时器复位");

  // 第三击快速 Enter：全新换行，不再生成（exactly once）
  clock = 1000 + 360;
  const third = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: second.nextDoubleEnter });
  assert.equal(third.action, "newline", "第三击是全新 newline，不会连环生成");
});

test("double-enter window boundary: <= windowMs generates, +1ms does not", () => {
  const run = (delta) => {
    let clock = 100;
    const now = () => clock;
    const opts = { options: { now, doubleEnterMs: 350 } };
    const first = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: {} });
    clock = 100 + delta;
    return handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: first.nextDoubleEnter }).action;
  };
  assert.equal(run(350), "generate", "350ms 内生成");
  assert.equal(run(351), "newline", "超过窗口不生成");
  assert.equal(run(401), "newline", "超出 400ms 上限不生成");
});

test("Enter x2 slower than the window stays two newlines, never generates", () => {
  let clock = 0;
  const now = () => clock;
  const opts = { options: { now } };
  const first = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: {} });
  clock = 500;
  const second = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: first.nextDoubleEnter });
  assert.equal(second.action, "newline");
  assert.equal(second.undo, false, "不触发生成自然无空行需要撤销");
});

test("stepDoubleEnter is pure: same input produces same output regardless of history", () => {
  let clock = 0;
  const now = () => clock;
  assert.deepEqual(stepDoubleEnter({}, { windowMs: 350, now }), { action: "newline", undo: false, nextState: { lastEnterAt: 0 } });
  clock = 200;
  assert.deepEqual(stepDoubleEnter({ lastEnterAt: 0 }, { windowMs: 350, now }), { action: "generate", undo: true, nextState: { lastEnterAt: null } });
  clock = 500;
  assert.deepEqual(stepDoubleEnter({ lastEnterAt: 0 }, { windowMs: 350, now }), { action: "newline", undo: false, nextState: { lastEnterAt: 500 } });
  assert.deepEqual(stepDoubleEnter({ lastEnterAt: null }, { windowMs: 350, now }), { action: "newline", undo: false, nextState: { lastEnterAt: 500 } }, "已复位状态不连环生成");
});

// ---- 4. IME composing 优先：不计 double-enter、不生成、不导航/不接受 ----

test("IME composing Enter is a plain newline and never counts toward double-enter", () => {
  let clock = 0;
  const now = () => clock;
  const opts = { options: { now } };

  // compositionstart 之后 isComposing=true 的第一击 Enter
  const composing = handleKeydown(keyEvent("Enter", { isComposing: true }), { ...opts, doubleEnter: {} });
  assert.equal(composing.action, "newline");
  assert.equal(composing.composing, true);
  assert.equal(composing.nextDoubleEnter, undefined, "composing Enter 不推进 double-enter 状态");

  // 紧接着（窗口内）一个普通 Enter：不得触发生成（composing 那次不计入）
  const after = handleKeydown(keyEvent("Enter"), { ...opts, doubleEnter: {} });
  assert.equal(after.action, "newline", "首个非 composing Enter 仍是 newline");

  // context.composing（compositionend 尚未触发）同样优先
  const ctxComposing = handleKeydown(keyEvent("Enter"), { ...opts, composing: true, doubleEnter: {} });
  assert.equal(ctxComposing.action, "newline");
  assert.equal(ctxComposing.nextDoubleEnter, undefined);
});

test("composing keys never navigate or accept the popup", () => {
  const results = [{ tag: "a" }];
  const nav = handleKeydown(keyEvent("ArrowDown", { isComposing: true }), { popup: { open: true, results, selected: 0 } });
  assert.equal(nav.action, "none", "IME 期间方向键交还输入法/默认行为");
  const tab = handleKeydown(keyEvent("Tab", { isComposing: true }), { popup: { open: true, results, selected: 0 } });
  assert.equal(tab.action, "none", "IME 期间 Tab 不接受候选");
});

test("isComposing checks both event flag and context flag", () => {
  assert.equal(isComposing({ isComposing: true }, {}), true);
  assert.equal(isComposing({}, { composing: true }), true);
  assert.equal(isComposing({ isComposing: false }, {}), false);
  assert.equal(isComposing({}, {}), false);
});

// ---- 5. 鼠标接受契约 ----

test("acceptActionFor and mouseAcceptAction share the mouse callback contract", () => {
  const results = [{ tag: "blue eyes" }, { tag: "solo" }];
  assert.deepEqual(acceptActionFor(1, results), { action: "accept", index: 1, tag: "solo", delimiter: ACCEPT_DELIMITER });
  assert.equal(mouseAcceptAction, acceptActionFor, "鼠标回调 = 同一纯函数");
  assert.equal(acceptActionFor(9, results).action, "none", "越界不产生 accept");
  assert.equal(acceptActionFor(0, []).action, "none", "空结果不产生 accept");
});

test("delimiterToAppend appends the accept delimiter only when not already present", () => {
  assert.equal(delimiterToAppend("", ACCEPT_DELIMITER), ACCEPT_DELIMITER, "行尾接受 -> 补 ', '");
  assert.equal(delimiterToAppend(", solo", ACCEPT_DELIMITER), "", "后续已有分隔符 -> 不重复");
  assert.equal(delimiterToAppend("solo", ACCEPT_DELIMITER), ACCEPT_DELIMITER, "后续是普通文本 -> 补分隔符");
  assert.equal(delimiterToAppend(",", ACCEPT_DELIMITER), ", ", "仅逗号无空格也补完整分隔符");
  assert.equal(delimiterToAppend("", ""), "");
});

// ---- 6. 撤销额外空行：只删本次产生的，不抹既有换行 ----

test("trailingNewlineRange locates only the newline immediately before caret", () => {
  assert.deepEqual(trailingNewlineRange("1girl\n\n", 6), { start: 5, end: 6 }, "第二击 Enter 的空行紧邻 caret 前");
  assert.equal(trailingNewlineRange("1girl\n\n", 5), null, "caret 不在换行后 -> 不删除");
  assert.equal(trailingNewlineRange("1girl, solo", 11), null, "无换行 -> null");
  assert.equal(trailingNewlineRange("", 0), null);
});

test("removeRange deletes only the given range and preserves existing newlines", () => {
  const { value, caret } = removeRange("1girl\nsolo", { start: 5, end: 6 });
  assert.equal(value, "1girlsolo");
  assert.equal(caret, 5, "caret 回到删除位置");
  // 多行文本：只删除目标换行，其余行原样保留
  // "1girl\nforest\nsolo"：第二个换行在 index 12，删它 -> 第一个换行（index 5）保留
  const multiline = removeRange("1girl\nforest\nsolo", { start: 12, end: 13 });
  assert.equal(multiline.value, "1girl\nforestsolo", "既有换行（第 5 位）不被抹掉");
});

// ---- 7. popup 主题 scope：:root 稳定公共 scope，覆盖层不透明 ----

test("autocomplete popup theme variables live in the stable public :root scope", () => {
  // #nai-autocomplete 是 body 级 fixed 覆盖层（index.html 中不在 .nai-layout 内），
  // 主题变量必须定义在 :root 才能级联到它；否则 var(--nai-card) 计算失败 -> 透明背景。
  const rootBlock = APP_CSS.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  for (const name of ["--nai-card", "--nai-border", "--nai-text", "--nai-muted", "--nai-accent", "--nai-accent-hover", "--nai-sub"]) {
    assert.ok(rootBlock.includes(name), `${name} 必须在 :root 公共 scope 定义`);
  }
});

test("autocomplete overlay is opaque and uses the public theme vars (no opacity hack)", () => {
  const lines = APP_CSS.split("\n").filter((l) => l.includes("nai-autocomplete"));
  const block = lines.join("\n");
  assert.match(block, /background:\s*var\(--nai-card\)/, "背景引用公共主题变量（非 transparent）");
  assert.match(block, /border:\s*1px solid var\(--nai-border\)/, "边框引用公共主题变量");
  assert.ok(!/opacity\s*:\s*0/.test(block), "不得用 opacity hack 假装透明/隐藏");
  assert.match(APP_CSS, /\.nai-ac-hint\s*\{/, "hint 样式类存在，供 Integrator 挂载");
});

// ---- 8. 轻量 UI hint 契约 ----

test("hint text and html follow the lightweight UI contract", () => {
  assert.equal(HINT_TEXT, "Tab 补全 · Enter 换行 · Enter×2 生成");
  const html = buildHintHtml();
  assert.match(html, /class="nai-ac-hint"/);
  assert.ok(html.includes(HINT_TEXT), "默认文案 = HINT_TEXT");
  assert.equal(buildHintHtml("a<b"), '<div class="nai-ac-hint" data-nai-ac-hint>a&lt;b</div>', "文案转义防注入");
  assert.equal(buildHintHtml(""), '<div class="nai-ac-hint" data-nai-ac-hint></div>');
});

// ---- 9. 有状态 controller（createNaiInputKeys）一行接入 ----

test("createNaiInputKeys keeps composition and double-enter state across calls", () => {
  let clock = 0;
  const keys = createNaiInputKeys({ doubleEnterMs: 350, now: () => clock });

  keys.setComposing(true);
  assert.equal(keys.handleKeydown(keyEvent("Enter"), {}).action, "newline");
  assert.equal(keys.handleKeydown(keyEvent("Enter"), {}).action, "newline", "composing 期间连按 Enter 不生成");
  keys.setComposing(false);

  clock = 0;
  const first = keys.handleKeydown(keyEvent("Enter"), {});
  assert.equal(first.action, "newline");
  clock = 300;
  const second = keys.handleKeydown(keyEvent("Enter"), {});
  assert.equal(second.action, "generate");
  assert.deepEqual(keys.getState().doubleEnter, { lastEnterAt: null }, "生成后计时器复位");

  keys.resetDoubleEnter();
  assert.deepEqual(keys.getState().doubleEnter, {});
});

test("factory wiring returns the same action contract on existing handlers", () => {
  const keys = createNaiInputKeys({ doubleEnterMs: 350 });
  const popup = { open: true, results: [{ tag: "blue eyes" }, { tag: "solo" }], selected: 0 };

  assert.deepEqual(keys.handleKeydown(keyEvent("ArrowDown"), { popup }),
    { action: "navigate", direction: 1, index: 1, preventDefault: true });
  assert.deepEqual(keys.handleKeydown(keyEvent("Tab"), { popup }),
    { action: "accept", index: 0, tag: "blue eyes", delimiter: ACCEPT_DELIMITER, preventDefault: true });
  assert.deepEqual(keys.handleKeydown(keyEvent("Escape"), { popup }), { action: "close", preventDefault: true });

  const enter = keys.handleKeydown(keyEvent("Enter"), { popup });
  assert.equal(enter.action, "newline", "controller 同样保证单 Enter 换行、不接受候选");
});

// ---- 10. 契约常量 ----

test("contract constants are stable", () => {
  assert.equal(ACCEPT_DELIMITER, ", ");
  assert.ok(DEFAULT_DOUBLE_ENTER_MS >= 300 && DEFAULT_DOUBLE_ENTER_MS <= 400, "double-enter 窗口须在 300–400ms");
});