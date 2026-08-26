"use strict";

/**
 * NSFW Scene Builder —— Phase 2 独立前端组件（供 Integrator 后续 wiring）。
 *
 * 设计约束（与 static/visual-builder.js、static/tag-assistant.js 同一契约精神）：
 *  - 纯模块：不引用 window.state / app.js 全局；DOM 只在 mount()/render() 触碰。
 *  - 无第二份 Prompt 权威状态：永远通过 PromptBridge.getDocument() 按需读取，
 *    组件只缓存「视图数据」（本组件的 UI 选择模型：participants / scene / stage /
 *    position / body_focus / activities / 每角色 clothing），不保存 PromptDocument 副本。
 *    所有改动只 dispatch，靠 subscribe 刷新回流。
 *  - PromptBridge 由集成方（Integrator）提供：
 *      getDocument() -> PromptDocument（schema v2，见 prompt-document.js）
 *      getActiveTarget() -> 'base' | 'global_uc' | 'char:N' | 'char:N:uc'
 *      subscribe(listener) -> unsubscribe
 *      dispatch(action)   -> 见下方「Action 契约」
 *  - 成人内容策略：组件只读集成方注入的 settings（adolescent_mode / NSFW 返回）。
 *    青少年模式（adolescent_mode=true）下组件整体禁用 / 隐藏，绝不绕过内容策略，
 *    不硬编码绕过逻辑。缺省未注入时按「已启用成人」处理，但集成方必须在 wiring
 *    时把后端返回的 adolescent_mode 传进来。
 *  - 不凭记忆大量造 canonical tags：场景 / 体位 / 服装状态 / 附加活动 / 身体聚焦的
 *    真实候选一律由集成方通过 options 注入（options.participants / scenes / positions /
 *    clothingStates / activities / bodyFocus），或由语义 / 推荐 API 返回。组件只内置
 *    stage 语义标识（PREPARATION/FOREPLAY/MAIN_ACT/CLIMAX/AFTERMATH，非 canonical tag）
 *    与 participant 计数档（1/2/3/4+，非 canonical tag）。
 *
 * 挂载示例（wiring 由 Integrator 完成）：
 *   import { createNsfwBuilder } from "/static/nsfw-builder.js";
 *   const builder = createNsfwBuilder({
 *     root: document.getElementById("nsfw-builder-root"),
 *     bridge: window.PromptBridge,
 *     adolescentMode: settings.adolescent_mode,   // 后端 /api/settings
 *     // 真实候选（canonical tag 可选，缺 tag 只更新 context 不 ADD_TAG）：
 *     participants: [{ key:"1", label:"1" }, { key:"2", label:"2" }, ...],
 *     scenes: [{ key:"indoor", label:"室内", tag:"bedroom" }, ...],
 *     stages: undefined,           // 缺省用内置语义标识
 *     positions: [{ key:"x", label:"X", tag:"...", minParticipants:2 }, ...],
 *     clothingStates: [{ key:"clothed", label:"穿衣", tag:"..." }, ...],
 *     activities: [{ key:"a", label:"A", tag:"..." }, ...],
 *     bodyFocus: [{ key:"face", label:"面部" }, ...],
 *     recommend: async (payload) => [...],   // 可选注入推荐来源
 *   });
 *   builder.mount();
 *
 * Action 契约（组件发出的全部动作，由集成方实现）：
 *   SET_EXCLUSIVE_GROUP { type:"SET_EXCLUSIVE_GROUP", payload:{
 *       group, key, newTag, target, characterIndex, members } }
 *     严格互斥组：participant_count / primary_scene_type / stage / position /
 *     clothing_state（clothing_state 按角色作用域）。新选择 dispatch 这一个 action，
 *     Integrator 必须「原子删除同组旧 entries + 加入 newTag + 更新 assistant_context +
 *     只通知一次」。newTag 为空表示只设 group（无 canonical tag），不 ADD_TAG。
 *   SET_ASSISTANT_CONTEXT { type:"SET_ASSISTANT_CONTEXT", payload:{ context } }
 *     非互斥上下文（body_focus / additional_activities / 全量 context 快照）——
 *     上下文 metadata 绝不直接编译成 Prompt tags。
 *   ADD_TAG { type:"ADD_TAG", payload:{ tag, target, section? } }
 *     需要真实 canonical tag 的选择（带 tag 的附加活动、推荐点击）才 ADD_TAG。
 */

import { getTargetEntries } from "./prompt-document.js";

// ---- 常量 ----

// stage 为语义标识（非 canonical tag），按 Recommendation V2 契约枚举。
export const STAGE_KEYS = ["PREPARATION", "FOREPLAY", "MAIN_ACT", "CLIMAX", "AFTERMATH"];
export const STAGE_LABELS = {
  PREPARATION: "准备", FOREPLAY: "前戏", MAIN_ACT: "主戏", CLIMAX: "高潮", AFTERMATH: "余韵",
};

// 严格互斥组 -> 组 key（Recommendation V2 / SET_EXCLUSIVE_GROUP 契约）。
export const GROUP_KEYS = {
  participants: "participant_count",
  scene: "primary_scene_type",
  stage: "stage",
  position: "position",
  clothing: "clothing_state",
};
export const EXCLUSIVE_GROUP_ORDER = ["participants", "scene", "stage", "position", "clothing"];

// participant 计数档（非 canonical tag）。
export const DEFAULT_PARTICIPANTS = [
  { key: "1", label: "1" }, { key: "2", label: "2" },
  { key: "3", label: "3" }, { key: "4+", label: "4+" },
];

export const DEFAULT_STAGES = STAGE_KEYS.map((key) => ({ key, label: STAGE_LABELS[key], zh: STAGE_LABELS[key] }));

export const REC_LIMIT = 20;

// ---- 小工具（无 DOM） ----

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 选项归一化：key 必须唯一；tag 可选（缺省不 ADD_TAG）；minParticipants / requiresScenes 用于位置过滤。
export function normalizeOption(raw, fallbackKey = "") {
  if (raw == null || typeof raw !== "object") return null;
  const key = String(raw.key ?? raw.id ?? raw.value ?? fallbackKey);
  if (!key) return null;
  return {
    key,
    label: String(raw.label ?? raw.key ?? raw.id ?? key),
    zh: String(raw.zh ?? ""),
    tag: String(raw.tag ?? ""),
    minParticipants: raw.minParticipants == null ? null : Number(raw.minParticipants),
    requiresScenes: Array.isArray(raw.requiresScenes) ? raw.requiresScenes.map(String) : null,
    meta: (raw.meta && typeof raw.meta === "object") ? raw.meta : {},
  };
}

export function normalizeOptions(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map(normalizeOption).filter(Boolean);
}

// 位置候选按 participant / scene 过滤：
//  - minParticipants：participant_count 低于该值则排除；
//  - requiresScenes：仅在 primary_scene_type 命中列出的 scene key 时保留；
//    未选 scene（sceneKey 为空）时不过滤 requiresScenes（交给用户自主）。
export function filterPositions(positions, { participantCount = null, sceneKey = "" } = {}) {
  const count = Number(participantCount);
  const hasCount = Number.isFinite(count) && count > 0;
  const scene = String(sceneKey || "");
  return (positions || []).filter((p) => {
    if (p.minParticipants != null && hasCount && count < p.minParticipants) return false;
    if (p.requiresScenes && p.requiresScenes.length && scene && !p.requiresScenes.includes(scene)) return false;
    return true;
  });
}

// 严格互斥组 -> 该组的全部 canonical tag 成员（供 Integrator 原子删除同组旧 entries）。
// clothing 组的成员集与角色无关（作用域由 payload.characterIndex 决定）。
export function exclusiveMembers(group, options, characterIndex = null) {
  const g = String(group || "");
  const list = {
    [GROUP_KEYS.participants]: options.participants,
    [GROUP_KEYS.scene]: options.scenes,
    [GROUP_KEYS.stage]: options.stages,
    [GROUP_KEYS.position]: options.positions,
    [GROUP_KEYS.clothing]: options.clothingStates,
  }[g];
  return (Array.isArray(list) ? list : []).map((o) => o && o.tag ? String(o.tag) : "").filter(Boolean);
}

// ---- context 构建（全部上下文走 assistant_context，不直接编译成 Prompt tags） ----

// participant 档 -> 数值（"4+" -> 4）；供 context / 位置过滤使用。
export function participantNumber(participants) {
  const p = String(participants ?? "");
  const m = p.match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 4 ? 4 : n;
}

export function buildContext({
  participants = null, scene = "", stage = "", position = "", bodyFocus = "",
  activities = [], clothingState = {}, mode = "nsfw",
} = {}) {
  const ctx = { mode };
  if (participants != null && participants !== "") ctx.participant_count = participantNumber(participants);
  if (scene) ctx.primary_scene_type = scene;
  if (stage) ctx.stage = stage;
  if (position) ctx.position = position;
  if (bodyFocus) ctx.body_focus = bodyFocus;
  const acts = (Array.isArray(activities) ? activities : []).map(String).filter(Boolean);
  if (acts.length) ctx.additional_activities = acts;
  if (clothingState && typeof clothingState === "object") {
    const cleaned = {};
    for (const [idx, key] of Object.entries(clothingState)) if (key) cleaned[idx] = key;
    if (Object.keys(cleaned).length) ctx.clothing_state = cleaned;
  }
  return ctx;
}

// ---- Action 构建 ----

export function buildSetExclusiveGroupAction({ group, key, newTag = "", target = "", characterIndex = null, members = [] } = {}) {
  return {
    type: "SET_EXCLUSIVE_GROUP",
    payload: {
      group: String(group || ""),
      key: String(key || ""),
      newTag: String(newTag || ""),
      target: String(target || ""),
      characterIndex: characterIndex == null ? null : Number(characterIndex),
      members: (members || []).map(String),
    },
  };
}

export function buildSetAssistantContextAction(context) {
  return { type: "SET_ASSISTANT_CONTEXT", payload: { context: (context && typeof context === "object") ? context : {} } };
}

export function buildAddTagAction(tag, target = "", section = "") {
  const payload = { tag: String(tag || ""), target: String(target || "") };
  if (String(section).trim()) payload.section = String(section).trim();
  return { type: "ADD_TAG", payload };
}

// 返回是否真正 dispatch 成功（无桥 / 桥无 dispatch / 抛错时返回 false，不抛出）。
export function dispatchAction(bridge, action) {
  if (!bridge || typeof bridge.dispatch !== "function") return false;
  try {
    bridge.dispatch(action);
    return true;
  } catch {
    return false;
  }
}

// 从 PromptDocument 提取 positive 标签（base + 各角色 prompt；UC 不参与，与后端一致）。
export function positiveTagsFromDocument(doc) {
  const tags = [];
  if (!doc || typeof doc !== "object") return tags;
  const push = (entry) => { if (entry && String(entry.tag).trim()) tags.push(String(entry.tag).trim()); };
  for (const entry of getTargetEntries(doc, "base")) push(entry);
  for (let i = 0; i < (Array.isArray(doc.characters) ? doc.characters.length : 0); i++) {
    for (const entry of getTargetEntries(doc, `char:${i}`)) push(entry);
  }
  const seen = new Set();
  return tags.filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 推荐 payload（对齐 Recommendation V2 的 context 字段）。
export function buildRecommendPayload(context, doc, { target = "", limit = REC_LIMIT } = {}) {
  const ctx = (context && typeof context === "object") ? context : {};
  const payload = {
    tags: positiveTagsFromDocument(doc),
    target: String(target || ""),
    limit: Number(limit) > 0 ? Number(limit) : REC_LIMIT,
    mode: ctx.mode || "nsfw",
    participant_count: ctx.participant_count ?? undefined,
    primary_scene_type: String(ctx.primary_scene_type || ""),
    stage: String(ctx.stage || ""),
    position: String(ctx.position || ""),
    body_focus: String(ctx.body_focus || ""),
  };
  if (Array.isArray(ctx.additional_activities) && ctx.additional_activities.length) {
    payload.additional_activities = ctx.additional_activities.map(String);
  }
  if (ctx.clothing_state && typeof ctx.clothing_state === "object") {
    payload.clothing_state = ctx.clothing_state;
  }
  return payload;
}

// 推荐条目归一化（兼容 {tag,canonical,zh,reason,section} 与 {tag}）。
export function normalizeRecommendation(item) {
  if (!item || typeof item !== "object") return null;
  const tag = String(item.tag ?? item.canonical ?? "");
  if (!tag) return null;
  return {
    tag,
    canonical: String(item.canonical ?? item.tag ?? ""),
    zh: String(item.zh ?? ""),
    reason: String(item.reason ?? ""),
    section: String(item.section ?? ""),
  };
}

export function normalizeRecommendations(data) {
  if (!data || typeof data !== "object") return [];
  const raw = Array.isArray(data) ? data : (Array.isArray(data.recommendations) ? data.recommendations : []);
  return raw.map(normalizeRecommendation).filter(Boolean);
}

// ---- ARIA / 键盘辅助（无 DOM，便于测试） ----

// 单选组方向键换位：wrapping；从 -1（未选中）开始按方向落到首 / 尾。
export function radioMoveIndex(currentIndex, delta, count) {
  const n = Number(count) || 0;
  if (n <= 0) return -1;
  const c = Number(currentIndex);
  const start = Number.isFinite(c) && c >= 0 && c < n ? c : -1;
  if (start < 0) return delta >= 0 ? 0 : n - 1;
  return (start + Number(delta) + n) % n;
}

// 是否已选中（供 aria-pressed / aria-checked）。
export function isSelected(current, value) {
  return current != null && String(current) === String(value);
}

// 该组选项是否对当前 participant 计数可见（用于禁用不符合人数要求的选项）。
export function optionVisibleForCount(option, participantCount) {
  if (!option || option.minParticipants == null) return true;
  const count = participantNumber(participantCount);
  if (count == null) return true;
  return count >= option.minParticipants;
}

function emptyView() {
  return { status: "idle", error: "", message: "", recs: [], recStatus: "idle", context: {} };
}

/**
 * NsfwBuilder 组件实例。options：
 *   root            挂载容器（缺省则只做无 DOM 的核心逻辑，便于 Node 测试）
 *   bridge          PromptBridge（缺省回退 window.PromptBridge）
 *   apiBase         后端前缀（默认 ""，即同源）
 *   fetchImpl       自定义 fetch（测试注入）
 *   adolescentMode  是否青少年模式（后端 /api/settings；true=禁用/隐藏本组件）
 *   mode            Recommendation V2 的 mode（默认 "nsfw"）
 *   participants    计数档候选（默认 1/2/3/4+，非 canonical tag）
 *   scenes          主场景候选（canonical tag 可选）
 *   stages          阶段候选（默认内置语义标识）
 *   positions       体位候选（支持 minParticipants / requiresScenes 过滤）
 *   clothingStates  服装状态候选（canonical tag 可选，按角色作用域）
 *   activities      附加活动候选（multi-select，canonical tag 可选）
 *   bodyFocus       身体聚焦候选
 *   recommend       可注入推荐函数 async(payload) -> recs（缺省 POST /api/recommendations）
 */
export class NsfwBuilder {
  constructor(options = {}) {
    this.root = options.root || null;
    this.apiBase = String(options.apiBase || "");
    this.bridge = options.bridge || (typeof window !== "undefined" && window.PromptBridge ? window.PromptBridge : null);
    this.fetchImpl = options.fetchImpl || null;
    this.mode = String(options.mode || "nsfw");
    this.adolescentMode = options.adolescentMode === true || options.settings?.adolescent_mode === true;
    this.options = {
      participants: normalizeOptions(options.participants || DEFAULT_PARTICIPANTS),
      scenes: normalizeOptions(options.scenes),
      stages: normalizeOptions(options.stages || DEFAULT_STAGES),
      positions: normalizeOptions(options.positions),
      clothingStates: normalizeOptions(options.clothingStates),
      activities: normalizeOptions(options.activities),
      bodyFocus: normalizeOptions(options.bodyFocus),
    };
    this.recommendImpl = typeof options.recommend === "function" ? options.recommend : null;
    this.openState = {};
    this.context = {};
    Object.defineProperty(this, "selections", { configurable: true, get: () => ({
      participants: this.context.participant_count == null ? null : String(this.context.participant_count), scene: this.context.primary_scene_type || null,
      stage: this.context.stage || null, position: this.context.position || null, bodyFocus: this.context.body_focus || null,
      activities: [...(this.context.additional_activities || [])], clothing: { ...(this.context.clothing_state || {}) },
    }) });
    this.view = emptyView();
    this._destroyed = false;
    this._unsubscribe = null;
    this.onClick = (event) => this.handleClick(event);
    this.onChange = (event) => this.handleChange(event);
    this.onKeydown = (event) => this.handleKeydown(event);
    this.onBridgeChange = () => { if (!this._destroyed) this.refresh(); };
  }

  isDisabled() { return !!this.adolescentMode; }
  setAdolescentMode(value) {
    this.adolescentMode = value === true;
    if (this.root) this.render();
  }

  mount() {
    if (this._destroyed) return;
    if (this.root) {
      this.render();
      this.root.addEventListener("click", this.onClick);
      this.root.addEventListener("change", this.onChange);
      this.root.addEventListener("keydown", this.onKeydown);
    }
    const bridge = this.bridge;
    if (bridge && typeof bridge.subscribe === "function") {
      this._unsubscribe = bridge.subscribe(this.onBridgeChange);
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._unsubscribe) { try { this._unsubscribe(); } catch { /* 忽略 */ } this._unsubscribe = null; }
    if (this.root) {
      this.root.removeEventListener("click", this.onClick);
      this.root.removeEventListener("change", this.onChange);
      this.root.removeEventListener("keydown", this.onKeydown);
    }
  }

  setBridge(bridge) {
    this.bridge = bridge || null;
    if (this.bridge && typeof this.bridge.subscribe === "function") {
      if (this._unsubscribe) { try { this._unsubscribe(); } catch { /* 忽略 */ } }
      this._unsubscribe = this.bridge.subscribe(this.onBridgeChange);
    }
    if (!this._destroyed) this.refresh();
  }

  _hydrateContext() {
    const doc = this.bridge?.getDocument?.() || {};
    const raw = doc.assistant_context || {};
    this.context = { ...raw, clothing_state: { ...(raw.clothing_state || {}) }, additional_activities: [...(raw.additional_activities || [])] };
    return this.context;
  }

  currentContext() {
    return { ...this._hydrateContext(), mode: this.mode };
  }

  // 桥变化 -> 刷新（组件 UI 选择模型是自身状态，无需重读文档；这里仅维护空态与目标）。
  refresh() {
    if (this._destroyed) return;
    const bridge = this.bridge;
    if (!bridge || typeof bridge.getDocument !== "function") {
      this.view = { ...emptyView(), status: "empty", message: "未检测到 PromptBridge：NSFW Scene Builder 需要 getDocument / getActiveTarget / dispatch。" };
      if (this.root) this.render();
      return;
    }
    const doc = bridge.getDocument();
    if (!doc || typeof doc !== "object") {
      this.view = { ...emptyView(), status: "empty", message: "PromptBridge 未返回 PromptDocument（schema v2）。" };
      if (this.root) this.render();
      return;
    }
    this._hydrateContext();
    this.view = { ...this.view, status: "ok", context: this.context };
    if (this.root) this.render();
  }

  _activeTarget() {
    const bridge = this.bridge;
    return bridge && typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "base";
  }

  // 当前活动角色索引：active target 为 char:N 则取 N，否则 0（clothing 作用域）。
  _activeCharIndex() {
    const m = String(this._activeTarget() || "").match(/^char:(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  // ---- 严格互斥组选择：dispatch 单个 SET_EXCLUSIVE_GROUP，交给 Integrator 原子处理 ----
  selectExclusive(group, key) {
    if (this.isDisabled()) return false;
    const groupKey = GROUP_KEYS[group];
    if (!groupKey) return false;
    const option = this._findOption(group, key);
    const target = this._activeTarget();
    const characterIndex = group === "clothing" ? this._activeCharIndex() : null;
    const members = exclusiveMembers(groupKey, this.options, characterIndex);
    const action = buildSetExclusiveGroupAction({
      group: groupKey, key: String(key || ""),
      newTag: option ? option.tag : "",
      target, characterIndex, members,
    });
    const ok = dispatchAction(this.bridge, action);
    return ok;
  }

  _findOption(group, key) {
    const listKey = {
      participants: "participants", scene: "scenes", stage: "stages",
      position: "positions", clothing: "clothingStates",
      bodyfocus: "bodyFocus", activity: "activities", activities: "activities",
    }[group];
    const list = (listKey && this.options[listKey]) || [];
    return list.find((o) => o && o.key === String(key || "")) || null;
  }

  // ---- 非互斥上下文（body_focus）：dispatch SET_ASSISTANT_CONTEXT ----
  selectBodyFocus(key) {
    if (this.isDisabled()) return false;
    const context = { ...this.currentContext(), body_focus: String(key || "") };
    const action = buildSetAssistantContextAction(context);
    return dispatchAction(this.bridge, action);
  }

  // ---- 附加活动（multi-select）：语义清晰——上下文更新（SET_ASSISTANT_CONTEXT）；
  // 若该活动带 canonical tag 且为新增，则再 ADD_TAG 到 active target。
  toggleActivity(key) {
    if (this.isDisabled()) return false;
    const option = this._findOption("activities", key);
    const current = this._hydrateContext();
    const activities = [...(current.additional_activities || [])];
    const idx = activities.indexOf(String(key || ""));
    const added = idx < 0;
    if (added) activities.push(String(key || ""));
    else activities.splice(idx, 1);
    const context = { ...current, additional_activities: activities };
    const ctxAction = buildSetAssistantContextAction(context);
    const ctxOk = dispatchAction(this.bridge, ctxAction);
    if (option && option.tag) {
      const target = this._activeTarget();
      const entries = getTargetEntries(this.bridge?.getDocument?.(), target);
      const existing = entries.find((entry) => String(entry.tag).toLowerCase() === option.tag.toLowerCase());
      if (added && !existing) dispatchAction(this.bridge, buildAddTagAction(option.tag, target, "other"));
      if (!added && existing) dispatchAction(this.bridge, { type: "REMOVE_TAG", payload: { target, entryId: existing.id } });
    }
    return ctxOk;
  }

  // ---- 推荐：注入 recommend 或默认 POST /api/recommendations ----
  async recommend() {
    if (this.isDisabled()) return [];
    const bridge = this.bridge;
    const doc = bridge && typeof bridge.getDocument === "function" ? bridge.getDocument() : null;
    if (!doc || typeof doc !== "object") {
      this.view = { ...this.view, recStatus: "empty", message: "未检测到 PromptBridge：推荐需要当前 Prompt 数据。" };
      if (this.root) this.render();
      return [];
    }
    const context = this.currentContext();
    const payload = buildRecommendPayload(context, doc, { target: this._activeTarget() });
    this.view = { ...this.view, recStatus: "loading" };
    if (this.root) this.render();
    try {
      const data = await this._fetchRecommend(payload);
      const recs = normalizeRecommendations(data);
      this.view = { ...this.view, recs, recStatus: recs.length ? "ok" : "empty", message: recs.length ? "" : "暂无可用推荐。" };
      if (this.root) this.render();
      return recs;
    } catch (error) {
      this.view = { ...this.view, recStatus: "error", error: String(error?.message || error) };
      if (this.root) this.render();
      return [];
    }
  }

  async _fetchRecommend(payload) {
    if (this.recommendImpl) return this.recommendImpl(payload);
    const fetchImpl = this.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("fetch 不可用（后端未连接？）");
    const res = await fetchImpl(`${this.apiBase}/api/recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res || !res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* 忽略 */ }
      throw new Error(`HTTP ${res ? res.status : "?"}${detail ? `：${detail}` : ""}`);
    }
    return res.json();
  }

  // 点击推荐 -> 只 ADD_TAG 到 active target；不改变 stage / position / 任何 strict group。
  applyRecommendation(rec) {
    if (this.isDisabled()) return false;
    const item = normalizeRecommendation(rec);
    if (!item) return false;
    const target = this._activeTarget();
    return dispatchAction(this.bridge, buildAddTagAction(item.tag, target, item.section || ""));
  }

  // ---- 事件委托（root 单监听器）+ 基础键盘可用性 ----

  handleClick(event) {
    if (!this.root) return;
    const node = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-action]") : null;
    if (!node) return;
    const action = node.dataset.action;
    if (action === "exclusive") {
      this.selectExclusive(node.dataset.group, node.dataset.key);
    } else if (action === "body-focus") {
      this.selectBodyFocus(node.dataset.key);
    } else if (action === "activity") {
      this.toggleActivity(node.dataset.key);
    } else if (action === "recommend") {
      this.recommend();
    } else if (action === "rec-add") {
      const ok = this.applyRecommendation({ tag: node.dataset.tag, section: node.dataset.section || "" });
      if (!ok) this.flashStatus("未连接 PromptBridge，无法加入推荐标签。");
    }
  }

  handleChange(event) {
    const node = event.target;
    if (!node || !node.dataset) return;
    if (node.dataset.action === "exclusive-select") {
      this.selectExclusive(node.dataset.group, node.value);
    }
  }

  handleKeydown(event) {
    if (!this.root) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      const group = event.target && typeof event.target.closest === "function" ? event.target.closest('[role="radiogroup"]') : null;
      if (!group) return;
      const buttons = Array.from(group.querySelectorAll('[role="radio"][data-action]'));
      if (!buttons.length) return;
      const idx = buttons.indexOf(event.target);
      if (idx < 0) return;
      event.preventDefault();
      const delta = (event.key === "ArrowRight" || event.key === "ArrowDown") ? 1 : -1;
      const next = radioMoveIndex(idx, delta, buttons.length);
      const btn = buttons[next];
      if (btn) {
        btn.focus();
        const action = btn.dataset.action;
        if (action === "exclusive" && btn.dataset.group) this.selectExclusive(btn.dataset.group, btn.dataset.key);
        else if (action === "body-focus") this.selectBodyFocus(btn.dataset.key);
      }
    }
  }

  flashStatus(message) {
    const status = this.root && this.root.querySelector(".nb-status-flash");
    if (status) status.textContent = message;
  }

  // ---- 渲染 ----

  render() {
    if (!this.root) return;
    this.root.innerHTML = this.isDisabled()
      ? `<div class="nsfw-builder is-disabled" role="region" aria-label="NSFW Scene Builder">
           <div class="nb-disabled" role="status">当前为青少年模式，NSFW Scene Builder 已禁用。</div>
         </div>`
      : `<div class="nsfw-builder" role="region" aria-label="NSFW Scene Builder">
          ${this.statusHtml()}
          <div class="nb-status-flash" aria-live="polite"></div>
          ${this.exclusiveHtml()}
          ${this.contextHtml()}
          ${this.recommendHtml()}
        </div>`;
  }

  statusHtml() {
    const v = this.view;
    if (v.status === "error") return `<div class="nb-status nb-error" role="alert">${esc(v.error || "")}</div>`;
    if (v.status === "empty") return `<div class="nb-status nb-empty" aria-live="polite">${esc(v.message || "暂无内容")}</div>`;
    return "";
  }

  exclusiveHtml() {
    const visiblePositions = filterPositions(this.options.positions, {
      participantCount: this.context.participant_count,
      sceneKey: this.context.primary_scene_type,
    });
    const positionDisabled = this.context.participant_count == null && this.options.positions.some((p) => p.minParticipants != null);
    const parts = [];
    if (this.options.participants.length) {
      parts.push(this.radioGroupHtml("participants", "人数", this.options.participants, this.context.participant_count));
    }
    if (this.options.scenes.length) {
      parts.push(this.radioGroupHtml("scene", "主场景", this.options.scenes, this.context.primary_scene_type));
    }
    if (this.options.stages.length) {
      parts.push(this.radioGroupHtml("stage", "阶段", this.options.stages, this.context.stage));
    }
    if (visiblePositions.length || this.options.positions.length) {
      parts.push(this.radioGroupHtml("position", "体位", visiblePositions, this.context.position, {
        disabled: positionDisabled,
        hint: positionDisabled ? "先选择人数以启用体位候选（存在人数下限选项）。" : "",
      }));
    }
    if (this.options.clothingStates.length) {
      parts.push(this.radioGroupHtml("clothing", `服装状态（角色 ${this._activeCharIndex() + 1}）`, this.options.clothingStates, this.context.clothing_state?.[this._activeCharIndex()] || null));
    }
    return `<section class="nb-group" aria-label="严格互斥选择">${parts.join("")}</section>`;
  }

  radioGroupHtml(group, label, options, current, { disabled = false, hint = "", action = "exclusive" } = {}) {
    if (!options || !options.length) return "";
    const charGroup = group === "clothing";
    return `<fieldset class="nb-fieldset" ${disabled ? "disabled" : ""}>
      <legend class="nb-legend">${esc(label)}</legend>
      <div class="nb-options" role="radiogroup" aria-label="${esc(label)}" data-group="${esc(group)}">
        ${options.map((o) => `
          <button type="button" role="radio" data-action="${esc(action)}" data-group="${esc(group)}" data-key="${esc(o.key)}"
            aria-checked="${isSelected(current, o.key)}" ${charGroup ? `data-char="${this._activeCharIndex()}"` : ""}
            class="${isSelected(current, o.key) ? "active" : ""}">
            ${esc(o.label)}${o.tag ? ` <small class="nb-tag">${esc(o.tag)}</small>` : ""}
          </button>`).join("")}
      </div>
      ${hint ? `<div class="nb-hint">${esc(hint)}</div>` : ""}
    </fieldset>`;
  }

  contextHtml() {
    const parts = [];
    if (this.options.bodyFocus.length) {
      parts.push(this.radioGroupHtml("bodyfocus", "身体聚焦", this.options.bodyFocus, this.context.body_focus, { action: "body-focus" }));
    }
    if (this.options.activities.length) {
      parts.push(this.multiHtml("activity", "附加活动", this.options.activities, this.context.additional_activities || []));
    }
    if (!parts.length) return "";
    return `<section class="nb-group" aria-label="上下文选择">${parts.join("")}</section>`;
  }

  multiHtml(group, label, options, selected) {
    return `<fieldset class="nb-fieldset">
      <legend class="nb-legend">${esc(label)}<small class="nb-multi-note">（可多选）</small></legend>
      <div class="nb-options">
        ${options.map((o) => {
          const active = selected.includes(o.key);
          return `<button type="button" data-action="activity" data-key="${esc(o.key)}" aria-pressed="${active}"
            class="${active ? "active" : ""}">
            ${esc(o.label)}${o.tag ? ` <small class="nb-tag">${esc(o.tag)}</small>` : ""}
          </button>`;
        }).join("")}
      </div>
    </fieldset>`;
  }

  recommendHtml() {
    const v = this.view;
    return `<section class="nb-group" aria-label="推荐">
      <div class="nb-legend">推荐</div>
      <button type="button" class="nb-recommend-btn" data-action="recommend">获取推荐</button>
      <div class="nb-recs" aria-live="polite">
        ${v.recStatus === "loading" ? `<div class="nb-hint">加载中…</div>` : ""}
        ${v.recStatus === "empty" ? `<div class="nb-hint">${esc(v.message || "暂无可用推荐。")}</div>` : ""}
        ${v.recStatus === "error" ? `<div class="nb-error" role="alert">${esc(v.error || "")}</div>` : ""}
        ${v.recs.length ? v.recs.map((r) => `
          <button type="button" class="nb-rec" data-action="rec-add" data-tag="${esc(r.tag)}" data-section="${esc(r.section || "")}"
            aria-label="加入 ${esc(r.tag)} 到当前目标">
            ${esc(r.tag)}${r.zh ? ` <small class="nb-zh">${esc(r.zh)}</small>` : ""}
          </button>`).join("") : ""}
      </div>
    </section>`;
  }
}

export function createNsfwBuilder(options) {
  return new NsfwBuilder(options);
}

export default createNsfwBuilder;
