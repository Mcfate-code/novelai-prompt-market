"use strict";

/**
 * Prompt Input / Autocomplete 键盘契约（Phase 2，独立模块，供 Integrator 接线）。
 *
 * 独立纯模块：不持有 DOM、不持有 PromptDocument、不引用 app.js / window.state。
 * 所有逻辑（double-enter 时序 / IME 状态 / 方向键导航 / 候选接受 / 分隔符 / hint 文案）
 * 均可脱离浏览器在 Node 中测试（见 tests/test_nai_input_keys.mjs）。
 *
 * 键盘契约（Integrator 在现有 handler 上 wiring，勿抢改 app.js）：
 *   - ArrowUp / ArrowDown   弹窗打开时导航候选（首尾回卷），preventDefault
 *   - Tab                   接受当前选中候选并追加分隔符 `, `，preventDefault
 *   - Escape                关闭弹窗，preventDefault
 *   - 单 Enter               永远换行（即使弹窗打开也绝不接受候选），不 preventDefault
 *   - Enter×2               在 300–400ms 窗口内（默认 350ms）触发 Generate 恰好一次，
 *                           并撤销本次检测产生的额外空行（第二击 Enter 的换行），
 *                           绝不抹掉既有换行；第三击快速 Enter 是全新换行，不再生成
 *   - IME composing 的 Enter 一律按普通换行处理（不计入 double-enter、不生成、
 *                           不导航 / 不接受弹窗），`event.isComposing` 与
 *                           context.composing（compositionstart/end）两者都优先
 *   - 鼠标接受契约：mousedown handler 调用 acceptActionFor(index, results)
 *                    得到 { action:"accept", tag, delimiter:", " } 后自行应用
 *
 * 用法（纯函数式）：
 *   const action = handleKeydown(event, {
 *     popup:   { open, results, selected },
 *     doubleEnter: state.doubleEnter,          // 由 action.nextDoubleEnter 更新
 *     composing: isComposing,                  // compositionstart/end 维护
 *     options: { doubleEnterMs: 350, now: Date.now },
 *   });
 *   if (action.nextDoubleEnter) state.doubleEnter = action.nextDoubleEnter;
 *
 * 或（有状态 controller，适合一行接入）：
 *   const keys = createNaiInputKeys({ doubleEnterMs: 350 });
 *   input.addEventListener("keydown", (e) => {
 *     const action = keys.handleKeydown(e, { popup: { open, results, selected } });
 *     apply(action);
 *   });
 *   input.addEventListener("compositionstart", () => keys.setComposing(true));
 *   input.addEventListener("compositionend",  () => keys.setComposing(false));
 *
 * Action 统一形态：{ action, preventDefault?, ...payload }。
 *   action 取值：navigate / accept / close / newline / generate / none。
 */

export const DEFAULT_DOUBLE_ENTER_MS = 350; // 需求窗口 300–400ms，取中值
export const ACCEPT_DELIMITER = ", ";
export const HINT_TEXT = "Tab 补全 · Enter 换行 · Enter×2 生成";

// ---- IME / 组合状态 ----

// `event.isComposing`（keydown 自带）与 context.composing（compositionstart/end 维护）优先。
export function isComposing(event, context = {}) {
  return !!event?.isComposing || !!context?.composing;
}

// ---- 弹窗导航 ----

// 方向键导航：selected + delta，首尾回卷。length<=0 时固定返回 0（不导航）。
export function moveSelection(current, delta, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const n = Number(length);
  return (((Number(current) + Number(delta)) % n) + n) % n;
}

// 接受前把 selected 夹到有效区间；空列表返回 0。
export function clampSelection(selected, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.min(Math.max(Number(selected), 0), Number(length) - 1);
}

// ---- double-enter（Generate）检测 ----

// 状态：{ lastEnterAt: number|null }。纯函数：返回 action 与 nextState，不持有全局。
//  - 第二击 Enter 在 windowMs 内 -> { action:"generate", undo:true, nextState:{lastEnterAt:null} }
//  - 否则                          -> { action:"newline",  undo:false, nextState:{lastEnterAt:t} }
// undo:true 表示「撤销本次检测产生的额外空行」——即第二击 Enter 应 preventDefault，
// 该换行不插入；第一击 Enter 已插入的换行属既有换行，绝不删除。
export function stepDoubleEnter(state = {}, { windowMs = DEFAULT_DOUBLE_ENTER_MS, now = Date.now } = {}) {
  const t = now();
  const last = state.lastEnterAt ?? null;
  if (last != null && t - last <= windowMs) {
    return { action: "generate", undo: true, nextState: { lastEnterAt: null } };
  }
  return { action: "newline", undo: false, nextState: { lastEnterAt: t } };
}

// ---- 弹窗按键分类（Enter 之外）----

// open=false 或非弹窗键一律返回 { action:"none" }（交还默认行为，不 preventDefault）。
export function classifyPopupKey(event, { open = false, results = [], selected = 0 } = {}) {
  if (!open || !event) return { action: "none" };
  const key = event.key;
  if (key === "ArrowDown" || key === "ArrowUp") {
    const delta = key === "ArrowDown" ? 1 : -1;
    return { action: "navigate", direction: delta, index: moveSelection(selected, delta, results.length), preventDefault: true };
  }
  if (key === "Tab") {
    const index = clampSelection(selected, results.length);
    const item = results[index];
    if (!item) return { action: "none" };
    return { action: "accept", index, tag: String(item.tag), delimiter: ACCEPT_DELIMITER, preventDefault: true };
  }
  if (key === "Escape") return { action: "close", preventDefault: true };
  return { action: "none" };
}

// ---- 接受候选（Tab / 鼠标共用）----

// 接受 action：{ action:"accept", index, tag, delimiter: ACCEPT_DELIMITER }。
// 鼠标回调契约：弹窗 option 的 mousedown handler 调用本函数并应用返回的 action。
export function acceptActionFor(index, results = []) {
  const item = results[index];
  if (!item) return { action: "none" };
  return { action: "accept", index, tag: String(item.tag), delimiter: ACCEPT_DELIMITER };
}

export const mouseAcceptAction = acceptActionFor;

// 接受后追加分隔符：仅当光标后文本尚未以 delimiter 开头时追加，避免 `, , ` 重复。
// 典型接线：const { value, caret } = replacePromptTokenWithCaret(...action.tag...);  // Integrator 既有实现
//           const suffix = delimiterToAppend(value.slice(caret), action.delimiter);
//           input.value = value + suffix;
export function delimiterToAppend(afterText, delimiter = ACCEPT_DELIMITER) {
  if (!delimiter) return "";
  return String(afterText).startsWith(delimiter) ? "" : delimiter;
}

// ---- 撤销「本次检测产生的额外空行」----

// 定位 caret 正前方的那一个换行（即第二击 Enter 刚产生的空行）；不存在返回 null。
// 只撤销它，绝不抹掉既有换行。
export function trailingNewlineRange(value, caret) {
  if (caret > 0 && String(value)[caret - 1] === "\n") return { start: caret - 1, end: caret };
  return null;
}

// 删除给定 range，caret 回到 range.start。value/range 均来自上方的纯函数。
export function removeRange(value, range) {
  if (!range) return { value: String(value), caret: 0 };
  const text = String(value);
  return { value: text.slice(0, range.start) + text.slice(range.end), caret: range.start };
}

// ---- 主入口 ----

/**
 * 统一键盘决策入口。context：
 *   { popup: { open, results, selected }, doubleEnter, composing,
 *     options: { doubleEnterMs, now } }
 * 返回 action（见文件头）。Enter 分支永远优先于弹窗分支：单 Enter 即使弹窗打开也是换行。
 */
export function handleKeydown(event, context = {}) {
  const { popup = {}, doubleEnter = {}, options = {} } = context;
  const composing = isComposing(event, context);

  if (event?.key === "Enter") {
    if (composing) {
      // IME 组合中的 Enter：普通换行，不计入 double-enter、不生成、不接受候选。
      return { action: "newline", composing: true, undo: false };
    }
    const step = stepDoubleEnter(doubleEnter, {
      windowMs: options.doubleEnterMs ?? DEFAULT_DOUBLE_ENTER_MS,
      now: options.now ?? Date.now,
    });
    if (step.action === "generate") {
      // preventDefault：第二击 Enter 的空行不插入，即「撤销本次检测产生的额外空行」。
      return { action: "generate", undo: true, preventDefault: true, nextDoubleEnter: step.nextState };
    }
    return { action: "newline", undo: false, nextDoubleEnter: step.nextState };
  }

  if (composing) return { action: "none" }; // IME 中的其它键交还输入法 / 默认行为
  return classifyPopupKey(event, { open: popup.open, results: popup.results ?? [], selected: popup.selected ?? 0 });
}

// ---- 有状态 controller（composition + double-enter 状态持有，一行接入）----

export function createNaiInputKeys(options = {}) {
  const state = {
    composing: false,
    doubleEnter: {},
    windowMs: options.doubleEnterMs ?? DEFAULT_DOUBLE_ENTER_MS,
    now: options.now ?? null, // 测试注入时钟
  };
  return {
    handleKeydown(event, ctx = {}) {
      const action = handleKeydown(event, {
        composing: state.composing,
        ...ctx,
        popup: ctx.popup ?? { open: false, results: [], selected: 0 },
        doubleEnter: state.doubleEnter,
        options: { doubleEnterMs: state.windowMs, now: state.now },
      });
      if (action.nextDoubleEnter) state.doubleEnter = action.nextDoubleEnter;
      return action;
    },
    setComposing(value) { state.composing = !!value; },
    resetDoubleEnter() { state.doubleEnter = {}; },
    getState() { return { composing: state.composing, doubleEnter: { ...state.doubleEnter } }; },
  };
}

// ---- 轻量 UI hint 契约 ----

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// 返回 Integrator 可直接挂载的 hint DOM 字符串（如置于弹窗底部 / 输入框旁）。
export function buildHintHtml(text = HINT_TEXT) {
  return `<div class="nai-ac-hint" data-nai-ac-hint>${escapeHtml(text)}</div>`;
}

// 供浏览器 <script> 标签使用时挂到 window；Node 测试环境下跳过。
if (typeof window !== "undefined") {
  window.NaiInputKeys = {
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
  };
}