"use strict";

/**
 * NSFW Scene Builder —— Scene Composer（产品化）独立前端组件。
 *
 * 设计约束（与 static/visual-builder.js、static/tag-assistant.js 同一契约精神）：
 *  - 纯模块：不引用 window.state / app.js 全局；DOM 只在 mount()/render() 触碰。
 *  - 无第二份权威状态：`PromptDocument.assistant_context` 是唯一的场景上下文。
 *    组件不缓存任何业务副本（无 this.selections / sceneStore / builderState）。
 *    每次刷新一律从 PromptBridge.getDocument().assistant_context 水合（currentContext() /
 *    _hydrateContext() 是唯一水合路径）；所有改动只 dispatch，靠 subscribe 刷新回流。
 *  - PromptBridge 由集成方（Integrator）提供：
 *      getDocument() -> PromptDocument（schema v2，见 prompt-document.js）
 *      getActiveTarget() -> 'base' | 'global_uc' | 'char:N' | 'char:N:uc'
 *      subscribe(listener) -> unsubscribe
 *      dispatch(action)   -> 见下方「Action 契约」
 *  - 成人内容策略：组件只读集成方注入的 settings（adolescent_mode）。青少年模式
 *    （adolescent_mode=true）下组件整体禁用 / 隐藏，绝不绕过内容策略。缺省未注入按
 *    「已启用成人」处理，但集成方必须在 wiring 时把后端返回的 adolescent_mode 传进来。
 *  - 不凭记忆造 canonical tags：环境/情境 / 体位 / 服装状态 / 附加活动 / 身体聚焦的真实
 *    候选一律由集成方通过 options 注入（后端 GET /api/nsfw-builder/options 已按
 *    config/scene_composer.json + data/nsfw_taxonomy.json 逐条校验 sqlite 后下发），
 *    或由推荐 API 返回。成人姿势模板是单独的显式库（pose-variation.js），只在本组件
 *    渲染，不混入通用标签推荐；stage 仍只内置语义标识（PREPARATION/FOREPLAY/MAIN_ACT/
 *    CLIMAX/AFTERMATH，非 canonical tag）与 participant 计数档（严格 1–6，非 canonical tag）。
 *
 * UI 分区（渲染顺序）：人数 → 主要行为 → 互动关系 → 阶段 → 角色（每角色衣着，全部同时可见）→
 *   体位 → 附加活动 → 身体焦点 → 镜头环境（构图 + 环境/情境）→ 推荐。
 *
 * 挂载示例（wiring 由 Integrator 完成）：
 *   import { createNsfwBuilder } from "/static/nsfw-builder.js";
 *   const builder = createNsfwBuilder({
 *     root: document.getElementById("nsfw-builder-root"),
 *     bridge: window.PromptBridge,
 *     adolescentMode: settings.adolescent_mode,   // 后端 /api/settings
 *     mode: "adult",                              // Recommendation V2 mode
 *     participants: [...], scenes: [...], positions: [...],
 *     clothingStates: [...], activities: [...], bodyFocus: [...],
 *     recommend: async (payload) => [...],        // 可选注入推荐来源
 *   });
 *   builder.mount();
 *
 * Action 契约（组件发出的全部动作，由集成方实现）：
 *   SET_EXCLUSIVE_GROUP { type:"SET_EXCLUSIVE_GROUP", payload:{
 *       group, key, newTag, target, characterIndex, members } }
 *     严格互斥组：participant_count / primary_scene_type / stage / position /
 *     clothing_state（clothing_state 按角色作用域 char:N）。新选择 dispatch 这一个
 *     action，Integrator 必须「原子删除同组旧 entries + 加入 newTag + 更新
 *     assistant_context + 只通知一次」。newTag 为空表示只设 group（无 canonical tag）。
 *     作用域：scene/stage/participant_count → target="base"；position / primary_act
 *     写入所有角色卡的 action；clothing_state → target=`char:${characterIndex}`。
 *   SET_ASSISTANT_CONTEXT { type:"SET_ASSISTANT_CONTEXT", payload:{ context } }
 *     非互斥上下文（body_focus / additional_activities / 全量 context 快照）——
 *     上下文 metadata 绝不直接编译成 Prompt tags。
 *   ADD_TAG { type:"ADD_TAG", payload:{ tag, target, section?, source?, bundle_name? } }
 *     需要真实 canonical tag 的选择（带 tag 的附加活动新增、推荐点击）才 ADD_TAG。
 *     附加活动新增携带 source:"scene_activity" / bundle_name:"scene-builder" 溯源标记。
 *   REMOVE_TAG { type:"REMOVE_TAG", payload:{ target, entryId } }
 *     附加活动取消时，仅移除带 scene_activity / scene-builder 溯源标记的自身条目。
 *   APPLY_POSE_VARIATION { type:"APPLY_POSE_VARIATION", payload:{ target:"characters", plan } }
 *     姿势模板写入各角色卡的 action 与结构化 pose_variation / interactions，并由 Integrator 原子通知。
 *   SCENE_PROPOSAL { type:"SCENE_PROPOSAL", payload:{
 *       kind, count?, autoRemovableEmptyIndices?, blockedIndices? } }
 *     参与者增减的高层提议，由 Integrator 决定角色槽增删 / 基础主体数同步 / 手动移除提示。
 *     kind ∈ {"sync_participants", "remove_characters_blocked"}。组件本身不直接增删角色。
 */

import { getTargetEntries } from "./prompt-document.js";
import { compatiblePoses, normalizePlan, POSE_LIBRARY } from "./pose-variation.js";

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
  { key: "3", label: "3" },
  { key: "4", label: "4" }, { key: "5", label: "5" },
  { key: "6", label: "6" },
];

export const DEFAULT_STAGES = STAGE_KEYS.map((key) => ({ key, label: STAGE_LABELS[key], zh: STAGE_LABELS[key] }));

export const REC_LIMIT = 20;
export const TEMPLATE_API_VERSION = 1;

// ---- 小工具（无 DOM） ----

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 选项归一化：key 必须唯一；tag 可选（缺省不 ADD_TAG）；minParticipants / requiresScenes 用于位置过滤。
export function normalizeOption(raw, fallbackKey = "") {
  if (raw == null || typeof raw !== "object") return null;
  const key = String(raw.key ?? raw.id ?? raw.value ?? fallbackKey);
  if (!key) return null;
  const option = {
    key,
    label: String(raw.label ?? raw.key ?? raw.id ?? key),
    zh: String(raw.zh ?? ""),
    tag: String(raw.tag ?? ""),
    minParticipants: raw.minParticipants == null ? null : Number(raw.minParticipants),
    requiresScenes: Array.isArray(raw.requiresScenes) ? raw.requiresScenes.map(String) : null,
    meta: (raw.meta && typeof raw.meta === "object") ? raw.meta : {},
  };
  if (raw.maxParticipants != null) option.maxParticipants = Number(raw.maxParticipants);
  if (Array.isArray(raw.allowedStages)) option.allowedStages = raw.allowedStages.map(String);
  if (Array.isArray(raw.allowedPrimaryActs)) option.allowedPrimaryActs = raw.allowedPrimaryActs.map(String);
  if (raw.route) option.route = String(raw.route);
  if (raw.section) option.section = String(raw.section);
  return option;
}

export function normalizeOptions(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map(normalizeOption).filter(Boolean);
}

// 后端已审核模板兼容 pose-variation.js 的计划字段；保留结构信息，避免把
// 导入模板误当成普通标签选项。
export function normalizePoseTemplates(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map((raw, index) => {
    const structure = (raw?.structure && typeof raw.structure === "object") ? raw.structure : raw;
    if (!structure || typeof structure !== "object") return null;
    const id = String(raw.id ?? structure.id ?? `imported-pose-${index + 1}`);
    // 选项可能先经过后端 DTO 再经过构造器归一化；避免二次归一化把
    // `imported-7` 变成 `imported-imported-7`，导致按钮无法应用模板。
    const normalizedId = id.startsWith("imported-") ? id : `imported-${id}`;
    const count = Number(structure.participant_count ?? raw.minParticipants ?? 1);
    return {
      id: normalizedId,
      label: String(raw.label ?? structure.label ?? `导入姿势 ${index + 1}`),
      minParticipants: Number.isFinite(count) ? count : 1,
      maxParticipants: Number.isFinite(count) ? count : 1,
      baseTags: Array.isArray(raw.baseTags) ? raw.baseTags.map(String) : (structure.base_tags || []).map(String),
      cameraTags: Array.isArray(raw.cameraTags) ? raw.cameraTags.map(String) : (structure.camera_tags || []).map(String),
      camera: Array.isArray(raw.camera) ? raw.camera.map(String) : (structure.camera_tags || []).map(String),
      roleTags: Array.isArray(raw.roleTags) ? raw.roleTags : (structure.role_tags || []),
      relations: Array.isArray(raw.relations) ? raw.relations : (structure.relations || []),
      sourceLabel: String(raw.sourceLabel ?? raw.source?.source_type ?? "导入"),
      adultOnly: true,
    };
  }).filter(Boolean);
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
    primary_act: options.primaryActs,
    [GROUP_KEYS.scene]: [...(options.scenes || []), ...(options.environments || [])],
    [GROUP_KEYS.stage]: options.stages,
    [GROUP_KEYS.position]: options.positions,
    [GROUP_KEYS.clothing]: options.clothingStates,
    composition: options.compositions,
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
  return n >= 1 ? Math.min(6, n) : null;
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
    primary_act: String(ctx.primary_act || ""),
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
  payload.character_state = ctx.character_state || {};
  payload.expressions = ctx.expressions || {};
  payload.interactions = ctx.interactions || [];
  payload.composition = String(ctx.composition || "");
  payload.environment = String(ctx.environment || "");
  payload.structured_state = doc;
  return payload;
}

// 推荐条目归一化（兼容 {tag,canonical,zh,reason,section} 与 {tag}）。
export function normalizeRecommendation(item) {
  if (!item || typeof item !== "object") return null;
  const tag = String(item.tag ?? item.canonical ?? "");
  if (!tag) return null;
  const normalized = {
    tag,
    canonical: String(item.canonical ?? item.tag ?? ""),
    zh: String(item.zh ?? ""),
    reason: String(item.reason ?? ""),
    section: String(item.section ?? ""),
  };
  // Keep the field absent for injected/legacy recommendations, so the public
  // DTO stays backward compatible.  A backend-provided target is authoritative.
  if (item.target != null && String(item.target)) normalized.target = String(item.target);
  return normalized;
}

export function normalizeRecommendations(data) {
  if (!data || typeof data !== "object") return [];
  const raw = Array.isArray(data) ? data : (Array.isArray(data.recommendations) ? data.recommendations : []);
  return raw.map(normalizeRecommendation).filter(Boolean);
}

const RECOMMEND_GROUP_LABELS = {
  adult_context: "成人场景语境", contextual: "当前语境", related: "相关标签",
  next_steps: "建议下一步", global_related: "全局关联", cooccurrence: "共现关联",
};
function recommendationGroupLabel(value) { const key = String(value || ""); return RECOMMEND_GROUP_LABELS[key] || key || "推荐"; }

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
 *   participants    计数档候选（默认 1–6，非 canonical tag）
 *   scenes          环境/情境（scenarios）候选（canonical tag 可选）
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
    this.active = options.active !== false;
    this.mode = String(options.mode || "nsfw");
    this.adolescentMode = options.adolescentMode === true || options.settings?.adolescent_mode === true;
    this.options = {
      participants: normalizeOptions(options.participants || DEFAULT_PARTICIPANTS),
      primaryActs: normalizeOptions(options.primaryActs),
      scenes: normalizeOptions(options.scenarios || options.scenes),
      environments: normalizeOptions(options.environments),
      stages: normalizeOptions(options.stages || DEFAULT_STAGES),
      positions: normalizeOptions(options.positions),
      clothingStates: normalizeOptions(options.clothingStates),
      activities: normalizeOptions(options.additionalActivities || options.activities),
      interactionActions: normalizeOptions(options.interactionActions),
      characterStates: normalizeOptions(options.characterStates),
      expressions: normalizeOptions(options.expressions),
      compositions: normalizeOptions(options.compositions),
      bodyFocus: normalizeOptions(options.bodyFocus),
      poseTemplates: normalizePoseTemplates(options.poseTemplates),
    };
    this.recommendImpl = typeof options.recommend === "function" ? options.recommend : null;
    this.openState = {};
    // 互动关系 Actor/Target/Relation 的 UI 草稿（非业务权威状态；apply 时随 `<select>` 实时读取）。
    this.interactionDraft = { actor: 0, target: 1, relation: "directional" };
    this.context = {};
    this.view = emptyView();
    this._destroyed = false;
    this._unsubscribe = null;
    this.onClick = (event) => this.handleClick(event);
    this.onChange = (event) => this.handleChange(event);
    this.onKeydown = (event) => this.handleKeydown(event);
    this._recommendationSeq = 0;
    this._recommendTimer = null;
    this.templateCandidates = [];
    this.templateNotice = "";
    this.templateApiStatus = "unknown";
    this.getGenerationConfig = typeof options.getGenerationConfig === "function" ? options.getGenerationConfig : () => ({});
    this.onBridgeChange = (_doc, action) => {
      if (this._destroyed || !this.active) return;
      this.refresh();
      if (action?.type !== "SCENE_WARNING") this.scheduleRecommend();
    };
  }

  isDisabled() { return !!this.adolescentMode; }
  setAdolescentMode(value) {
    this.adolescentMode = value === true;
    if (this.root) this.render();
  }

  setActive(value) {
    const next = value !== false;
    if (this.active === next) return;
    this.active = next;
    clearTimeout(this._recommendTimer);
    if (!next) {
      this._recommendationSeq += 1;
      return;
    }
    if (!this._destroyed) {
      this.refresh();
      this.scheduleRecommend();
      void this.refreshTemplateLibrary();
    }
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
    if (this.active) void this.refreshTemplateLibrary();
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
    this.context = { ...raw, clothing_state: { ...(raw.clothing_state || {}) }, character_state: { ...(raw.character_state || {}) }, expressions: { ...(raw.expressions || {}) }, additional_activities: [...(raw.additional_activities || [])], interactions: [...(raw.interactions || [])] };
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
      this.view = { ...emptyView(), status: "empty", message: "未检测到提示词桥接：成人场景构建器需要文档、当前目标和调度能力。" };
      if (this.root) this.render();
      return;
    }
    const doc = bridge.getDocument();
    if (!doc || typeof doc !== "object") {
      this.view = { ...emptyView(), status: "empty", message: "提示词桥接未返回有效的提示词文档（schema v2）。" };
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

  _dispatchProposal(payload) {
    return dispatchAction(this.bridge, { type: "SCENE_PROPOSAL", payload });
  }

  // ---- 参与者（人数）：严格互斥组 participant_count + SCENE_PROPOSAL 高层提议 ----
  selectParticipants(key) {
    if (this.isDisabled()) return false;
    const requestedN = participantNumber(key);
    if (requestedN == null) return false;
    const doc = this.bridge?.getDocument?.() || {};
    const blocked = (doc.characters || []).slice(requestedN).map((ch, offset) => this._characterNonEmpty(ch, requestedN + offset) ? requestedN + offset : null).filter((i) => i != null);
    if (blocked.length) {
      this.view = { ...this.view, blockedIndices: blocked.map((i) => ({ index: i, label: `角色 ${i + 1} 仍有内容` })) };
      if (this.root) this.render();
      this._dispatchProposal({ kind: "remove_characters_blocked", blockedIndices: blocked });
      return false;
    }
    const setOk = dispatchAction(this.bridge, buildSetExclusiveGroupAction({
      group: GROUP_KEYS.participants,
      key: String(key),
      newTag: "",
      target: "base",
      characterIndex: null,
      members: exclusiveMembers(GROUP_KEYS.participants, this.options),
    }));
    if (!setOk) return false;
    const autoRemovableEmptyIndices = requestedN < (doc.characters || []).length
      ? (doc.characters || []).slice(requestedN).map((_, offset) => requestedN + offset)
      : [];
    return this._dispatchProposal({ kind: "sync_participants", count: requestedN, autoRemovableEmptyIndices });
  }

  _characterNonEmpty(character, index) {
    if (!character || typeof character !== "object") return false;
    if (character.position) return true;
    for (const section of [character.prompt_sections, character.uc_sections, character.prompt, character.uc]) {
      if (Array.isArray(section)) {
        if (section.some((e) => e && String(e.tag ?? e.raw ?? "").trim())) return true;
      } else if (section && typeof section === "object") {
        for (const entries of Object.values(section)) {
          if (Array.isArray(entries) && entries.some((e) => e && String(e.tag ?? e.raw ?? "").trim())) return true;
        }
      }
    }
    return false;
  }

  // ---- 严格互斥组：scene / stage 写入 Base；position / primary_act 写入角色卡 ----
  // Character Assignment：场景 / 阶段归 Base；体位 / 主要行为归每个角色 action。
  selectExclusive(group, key) {
    if (this.isDisabled()) return false;
    const groupKey = GROUP_KEYS[group];
    if (!groupKey) return false;
    if (groupKey === GROUP_KEYS.participants) return this.selectParticipants(key);
    if (groupKey === GROUP_KEYS.clothing) return false;
    const option = this._findOption(group, key);
    if (option && !this._compatibility(option).ok) return false;
    const members = exclusiveMembers(groupKey, this.options);
    const action = buildSetExclusiveGroupAction({
      group: groupKey, key: String(key || ""),
      newTag: option ? option.tag : "",
      target: "base", characterIndex: null, members,
    });
    return dispatchAction(this.bridge, action);
  }

  selectPrimaryAct(key) {
    if (this.isDisabled()) return false;
    const option = this.options.primaryActs.find((item) => item.key === String(key));
    if (!option || !this._compatibility(option).ok) return false;
    return dispatchAction(this.bridge, buildSetExclusiveGroupAction({ group: "primary_act", key, newTag: option.tag, target: "base", members: exclusiveMembers("primary_act", this.options) }));
  }

  applyInteraction(actionKey, actor, target, relation = "directional") {
    const option = this.options.interactionActions.find((o) => o.key === String(actionKey));
    if (!option?.tag || Number(actor) === Number(target)) return false;
    return dispatchAction(this.bridge, { type: "APPLY_INTERACTION", payload: { interaction: { id: `scene-${Date.now()}`, actor: Number(actor), action: option.tag, target: Number(target), relation } } });
  }
  removeInteraction(id) { return dispatchAction(this.bridge, { type: "REMOVE_INTERACTION", payload: { id } }); }

  selectCharacterState(kind, key, characterIndex) {
    const map = { clothing: ["clothingStates", "clothing_state"], expression: ["expressions", "expressions"], state: ["characterStates", "character_state"] }[kind];
    if (!map) return false;
    const option = this.options[map[0]].find((o) => o.key === String(key));
    const members = this.options[map[0]].map((o) => o.tag).filter(Boolean);
    return dispatchAction(this.bridge, buildSetExclusiveGroupAction({ group: map[1], key, newTag: option?.tag || "", target: `char:${characterIndex}`, characterIndex, members }));
  }

  // ---- 服装状态（按角色作用域）：显式 characterIndex，dispatch 单个 SET_EXCLUSIVE_GROUP ----
  selectClothing(key, characterIndex) {
    if (this.isDisabled()) return false;
    const option = this._findOption("clothing", key);
    const idx = characterIndex == null ? 0 : Number(characterIndex);
    const members = exclusiveMembers(GROUP_KEYS.clothing, this.options);
    const action = buildSetExclusiveGroupAction({
      group: GROUP_KEYS.clothing, key: String(key || ""),
      newTag: option ? option.tag : "",
      target: `char:${idx}`, characterIndex: idx, members,
    });
    return dispatchAction(this.bridge, action);
  }

  _findOption(group, key) {
    // 「环境/情境」互斥组 = scenarios + environments 合并（两者都写 primary_scene_type → base）。
    if (group === "scene") {
      const merged = [...this.options.scenes, ...this.options.environments];
      return merged.find((o) => o && o.key === String(key || "")) || null;
    }
    const listKey = {
      participants: "participants", scene: "scenes", stage: "stages",
      primaryAct: "primaryActs",
      position: "positions", clothing: "clothingStates",
      bodyfocus: "bodyFocus", activity: "activities", activities: "activities",
    }[group];
    const list = (listKey && this.options[listKey]) || [];
    return list.find((o) => o && o.key === String(key || "")) || null;
  }

  _compatibility(option) {
    const count = participantNumber(this.context.participant_count);
    if (count && option.minParticipants != null && count < option.minParticipants) return { ok: false, reason: `至少 ${option.minParticipants} 人` };
    if (count && option.maxParticipants != null && count > option.maxParticipants) return { ok: false, reason: `最多 ${option.maxParticipants} 人` };
    if (option.requiresScenes?.length && this.context.primary_scene_type && !option.requiresScenes.includes(String(this.context.primary_scene_type))) return { ok: false, reason: "与当前情境不兼容" };
    if (option.allowedStages?.length && this.context.stage && !option.allowedStages.includes(String(this.context.stage))) return { ok: false, reason: "与当前阶段不兼容" };
    if (option.allowedPrimaryActs?.length && this.context.primary_act && !option.allowedPrimaryActs.includes(String(this.context.primary_act))) return { ok: false, reason: "与主要行为不兼容" };
    return { ok: true, reason: "" };
  }

  scheduleRecommend() {
    clearTimeout(this._recommendTimer);
    this._recommendTimer = setTimeout(() => this.recommend(), 320);
  }

  // ---- 非互斥上下文（body_focus）：dispatch SET_ASSISTANT_CONTEXT ----
  selectBodyFocus(key) {
    if (this.isDisabled()) return false;
    const context = { ...this.currentContext(), body_focus: String(key || "") };
    const option = this._findOption("bodyfocus", key);
    const ok = dispatchAction(this.bridge, buildSetAssistantContextAction(context));
    if (option?.tag) dispatchAction(this.bridge, buildAddTagAction(option.tag, "base", option.section || "composition"));
    return ok;
  }

  // ---- 附加活动（multi-select）：对称 + 溯源 ----
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
    const ctxOk = dispatchAction(this.bridge, buildSetAssistantContextAction(context));
    if (option && option.tag) {
      const target = "base";
      const entries = getTargetEntries(this.bridge?.getDocument?.(), target);
      if (added) {
        // 仅当同 tag 尚不存在（大小写不敏感）时 ADD_TAG；携带 scene_activity / scene-builder 溯源。
        const existing = entries.find((entry) => String(entry.tag).toLowerCase() === option.tag.toLowerCase());
        if (!existing) {
          dispatchAction(this.bridge, {
            type: "ADD_TAG",
            payload: {
              tag: option.tag, target,
              section: option.section || "action",
              source: "scene_activity", bundle_name: "scene-builder",
            },
          });
        }
      } else {
        // 仅移除带自身溯源标记（scene_activity / scene-builder）的条目；不删用户自有同名 tag。
        const matching = entries.filter((entry) =>
          String(entry.tag).toLowerCase() === option.tag.toLowerCase() &&
          (entry.source === "scene_activity" || entry.bundle_name === "scene-builder")
        );
        for (const entry of matching) {
          dispatchAction(this.bridge, { type: "REMOVE_TAG", payload: { target, entryId: entry.id } });
        }
      }
    }
    return ctxOk;
  }

  // ---- 推荐：注入 recommend 或默认 POST /api/recommendations ----
  async recommend() {
    if (this.isDisabled() || !this.active) return false;
    const bridge = this.bridge;
    const doc = bridge && typeof bridge.getDocument === "function" ? bridge.getDocument() : null;
    if (!doc || typeof doc !== "object") {
      this.view = { ...this.view, recStatus: "empty", message: "未检测到提示词桥接：推荐需要当前提示词数据。" };
      if (this.root) this.render();
      return [];
    }
    const context = this.currentContext();
    const payload = buildRecommendPayload(context, doc, { target: "base" });
    payload.structured_state = doc;
    payload.generation_config = this.getGenerationConfig();
    payload.active_target = "base";
    const seq = ++this._recommendationSeq;
    this.view = { ...this.view, recStatus: "loading" };
    if (this.root) this.render();
    try {
      const data = await this._fetchRecommend(payload);
      if (seq !== this._recommendationSeq) return [];
      const groups = Array.isArray(data?.groups) && data.groups.length
        ? data.groups.map((g) => ({ group: String(g?.group || ""), recommendations: normalizeRecommendations({ recommendations: g?.recommendations }) })).filter((g) => g.recommendations.length)
        : [];
      const recs = normalizeRecommendations(data);
      this.view = {
        ...this.view, groups, recs, nextSteps: Array.isArray(data?.next_steps) ? data.next_steps : [],
        recStatus: (groups.length || recs.length) ? "ok" : "empty",
        message: (groups.length || recs.length) ? "" : "暂无可用推荐。",
      };
      if (this.root) this.render();
      return recs;
    } catch (error) {
      if (seq !== this._recommendationSeq) return [];
      this.view = { ...this.view, recStatus: "error", error: String(error?.message || error), groups: [] };
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
    const activeTarget = this._activeTarget();
    const target = item.target && /^(?:base|char:\d+)$/.test(item.target)
      ? item.target
      : (/^(?:base|char:\d+)$/.test(activeTarget) ? activeTarget : "base");
    return dispatchAction(this.bridge, buildAddTagAction(item.tag, target, item.section || ""));
  }

  // ---- 事件委托（root 单监听器）+ 基础键盘可用性 ----

  handleClick(event) {
    if (!this.root) return;
    const node = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-action]") : null;
    if (!node) return;
    const action = node.dataset.action;
    if (action === "participants") {
      this.selectParticipants(node.dataset.key);
    } else if (action === "exclusive") {
      if (node.dataset.group === "primaryAct") this.selectPrimaryAct(node.dataset.key);
      else this.selectExclusive(node.dataset.group, node.dataset.key);
    } else if (action === "clothing") {
      this.selectClothing(node.dataset.key, Number(node.dataset.char));
    } else if (action === "char-state") {
      this.selectCharacterState(node.dataset.kind, node.dataset.key, Number(node.dataset.char));
    } else if (action === "interaction-add") {
      const draft = this.interactionDraft || { actor: 0, target: 1, relation: "directional" };
      this.applyInteraction(node.dataset.key, draft.actor, draft.target, draft.relation);
    } else if (action === "interaction-remove") {
      this.removeInteraction(node.dataset.id);
    } else if (action === "body-focus") {
      this.selectBodyFocus(node.dataset.key);
    } else if (action === "activity") {
      this.toggleActivity(node.dataset.key);
    } else if (action === "recommend") {
      this.recommend();
    } else if (action === "pose-template") {
      const ok = this.applyPoseTemplate(node.dataset.id);
      if (!ok) this.flashStatus("当前人数下没有兼容的姿势模板。");
    } else if (action === "template-import-civitai") {
      this.importCivitaiTemplate();
    } else if (action === "template-approve") {
      this.approveTemplate(node.dataset.id);
    } else if (action === "template-reject") {
      this.rejectTemplate(node.dataset.id);
    } else if (action === "template-refresh") {
      this.refreshTemplateLibrary();
    } else if (action === "rec-add") {
      const ok = this.applyRecommendation({ tag: node.dataset.tag, section: node.dataset.section || "" });
      if (!ok) this.flashStatus("未连接 PromptBridge，无法加入推荐标签。");
    }
  }

  applyPoseTemplate(id) {
    if (this.isDisabled()) return false;
    const count = participantNumber(this.context.participant_count) || 1;
    const pose = compatiblePoses(count, [...POSE_LIBRARY, ...this.options.poseTemplates]).find((item) => item.id === String(id));
    if (!pose) return false;
    // 导入模板可能带有 source/target 关系；保留 relations，内置模板则由
    // normalizePlan 按人数生成默认环形关系。
    const plan = normalizePlan(pose, count);
    return dispatchAction(this.bridge, { type: "APPLY_POSE_VARIATION", payload: { target: "characters", plan } });
  }

  handleChange(event) {
    const node = event.target;
    if (!node || !node.dataset) return;
    if (node.dataset.action === "exclusive-select") {
      this.selectExclusive(node.dataset.group, node.value);
    } else if (node.dataset.action === "interaction-select") {
      const field = node.dataset.input;
      if (field === "actor" || field === "target" || field === "relation") {
        this.interactionDraft = { ...(this.interactionDraft || { actor: 0, target: 1, relation: "directional" }), [field]: node.value };
        if (this.root) this.render();
      }
    } else if (node.dataset.action === "template-import-file") {
      this.importTemplateFile(node.files?.[0]);
      node.value = "";
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
        if (action === "participants") this.selectParticipants(btn.dataset.key);
        else if (action === "exclusive" && btn.dataset.group) this.selectExclusive(btn.dataset.group, btn.dataset.key);
        else if (action === "clothing") this.selectClothing(btn.dataset.key, Number(btn.dataset.char));
        else if (action === "body-focus") this.selectBodyFocus(btn.dataset.key);
      }
    }
  }

  flashStatus(message) {
    const status = this.root && this.root.querySelector(".nb-status-flash");
    if (status) status.textContent = message;
  }

  // ---- 渲染（顺序：人数 / 主要行为 / 互动关系 / 阶段 / 角色 / 体位 / 附加活动 / 身体焦点 / 镜头环境 / 推荐） ----

  render() {
    if (!this.root) return;
    if (!this.isDisabled()) this._hydrateContext();
    this.root.innerHTML = this.isDisabled()
      ? `<div class="nsfw-builder is-disabled" role="region" aria-label="成人场景构建器">
           <div class="nb-disabled" role="status">当前为青少年模式，成人场景构建器已禁用。</div>
         </div>`
      : `<div class="nsfw-builder" role="region" aria-label="成人场景构建器">
          ${this.summaryHtml()}
          ${this.dashboardHtml()}
          ${this.statusHtml()}
          <div class="nb-status-flash" aria-live="polite"></div>
          ${this.noticesHtml()}
          ${this.participantsHtml()}
          ${this.primaryActHtml()}
          ${this.interactionsHtml()}
          ${this.stageHtml()}
         ${this.charactersHtml()}
         ${this.positionHtml()}
          ${this.poseTemplatesHtml()}
         ${this.activitiesHtml()}
          ${this.bodyFocusHtml()}
          ${this.compositionEnvironmentHtml()}
          ${this.recommendHtml()}
        </div>`;
  }

  dashboardHtml() {
    const groups = [["人物", this.context.participant_count], ["主要行为", this.context.primary_act], ["互动关系", this.context.interactions?.length], ["阶段体位", this.context.stage || this.context.pose_variation?.label || this.context.position], ["角色状态", Object.keys(this.context.clothing_state || {}).length + Object.keys(this.context.character_state || {}).length], ["镜头环境", this.context.composition || this.context.environment || this.context.primary_scene_type]];
    const done = groups.filter(([, value]) => value).length;
    return `<nav class="nb-dashboard" aria-label="场景自由跳转">${groups.map(([label,value]) => `<a href="#nb-${esc(label)}" class="nb-${value ? "filled" : "empty"}">${esc(label)}<small>${value ? "已填" : "未填"}</small></a>`).join("")}<span>${done}/${groups.length}</span></nav>`;
  }
  summaryHtml() {
    const doc = this.bridge?.getDocument?.() || {}; const c = this.context;
    const chars = (doc.characters || []).map((ch,i) => `角色 ${i+1} ${/^Character \d+$/.test(String(ch.name || "")) ? "" : ch.name || ""}: ${c.clothing_state?.[i] || "-"}/${c.expressions?.[i] || "-"}/${c.character_state?.[i] || "-"}`);
    const rows = (c.interactions || []).map((r) => `角色 ${r.actor+1} ${r.action} 角色 ${r.target+1}`);
    return `<header class="nb-summary"><strong>成人场景编排 V2</strong><div>${esc(`${c.participant_count || doc.characters?.length || 1}人 · ${c.primary_scene_type || c.environment || "环境未定"} · ${c.primary_act || "主要行为未定"} · ${c.stage || "阶段未定"} · ${c.pose_variation?.label || c.position || "体位未定"}`)}</div><small>${esc([...chars,...rows].join(" | "))}</small></header>`;
  }

  statusHtml() {
    const v = this.view;
    if (v.status === "error") return `<div class="nb-status nb-error" role="alert">${esc(v.error || "")}</div>`;
    if (v.status === "empty") return `<div class="nb-status nb-empty" aria-live="polite">${esc(v.message || "暂无内容")}</div>`;
    return "";
  }

  noticesHtml() {
    const blocked = this.view.blockedIndices || [];
    if (!blocked.length) return "";
    return blocked.map((b) => `<div class="nb-notice" role="status">${esc(b.label || `角色 ${Number(b.index) + 1} 仍有内容，请手动移除`)}</div>`).join("");
  }

  participantsHtml() {
    if (!this.options.participants.length) return "";
    return this.radioGroupHtml("人数", this.options.participants, this.context.participant_count == null ? null : String(this.context.participant_count), { action: "participants", dataGroup: "participants", id: "nb-人物" });
  }

  primaryActHtml() { return this.radioGroupHtml("主要行为 · 写入基础提示词", this.options.primaryActs, this.context.primary_act || null, { action: "exclusive", dataGroup: "primaryAct", id: "nb-主要行为" }); }
  interactionsHtml() {
    const count = participantNumber(this.context.participant_count) || 1;
    if (count < 2) return `<div class="nb-notice">选择 2–6 人以启用互动关系</div>`;
    const draft = this.interactionDraft || (this.interactionDraft = { actor: 0, target: 1, relation: "directional" });
    const clamp = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), count - 1) : fallback; };
    const actor = clamp(draft.actor, 0);
    const target = clamp(draft.target, 1);
    this.interactionDraft = { ...draft, actor, target };
    const actors = Array.from({length:count},(_,i)=>`<option value="${i}" ${i===actor?"selected":""}>角色 ${i+1}</option>`).join("");
    const targets = Array.from({length:count},(_,i)=>`<option value="${i}" ${i===target?"selected":""}>角色 ${i+1}</option>`).join("");
    const relationSel = `<option value="directional" ${draft.relation!=="mutual"?"selected":""}>定向</option><option value="mutual" ${draft.relation==="mutual"?"selected":""}>相互</option>`;
    return `<section class="nb-fieldset" id="nb-互动关系"><legend class="nb-legend">互动关系 · 发起者 → 行为 → 目标</legend><div class="nb-interaction-controls"><select data-action="interaction-select" data-input="actor">${actors}</select><select data-action="interaction-select" data-input="target">${targets}</select><select data-action="interaction-select" data-input="relation">${relationSel}</select>${this.options.interactionActions.map(o=>`<button data-action="interaction-add" data-key="${esc(o.key)}">${esc(o.label)} <small>互动：角色 ${actor+1} → 角色 ${target+1}</small></button>`).join("")}</div>${(this.context.interactions||[]).map(r=>`<div>角色 ${r.actor+1} → ${esc(r.action)} → 角色 ${r.target+1} <button data-action="interaction-remove" data-id="${esc(r.id)}">移除</button></div>`).join("")}</section>`;
  }

  stageHtml() {
    if (!this.options.stages.length) return "";
    return this.radioGroupHtml("阶段", this.options.stages, this.context.stage || null, { action: "exclusive", dataGroup: "stage", id: "nb-阶段体位" });
  }

  charactersHtml() {
    const count = participantNumber(this.context.participant_count);
    const n = count == null ? 1 : Math.max(1, count);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(this.charClothingHtml(i) + this.charStateHtml(i, "expression", "表情", this.options.expressions, this.context.expressions?.[i]) + this.charStateHtml(i, "state", "状态", this.options.characterStates, this.context.character_state?.[i]));
    return `<section class="nb-group nb-char-clothing-group" aria-label="角色服装状态" id="nb-角色状态">${parts.join("")}</section>`;
  }
  charStateHtml(i, kind, label, options, current) { return `<fieldset class="nb-fieldset"><legend>角色 ${i+1} ${label} · 写入角色 ${i+1}</legend><div class="nb-options">${options.map(o=>`<button data-action="char-state" data-kind="${kind}" data-char="${i}" data-key="${esc(o.key)}" class="${isSelected(current,o.key)?"active":""}">${esc(o.label)}</button>`).join("")}</div></fieldset>`; }

  charClothingHtml(characterIndex) {
    const label = `角色 ${characterIndex + 1} 衣着`;
    const current = this.context.clothing_state?.[characterIndex] || null;
    const options = this.options.clothingStates;
    return `<fieldset class="nb-fieldset nb-char-clothing">
      <legend class="nb-legend">${esc(label)}</legend>
      <div class="nb-options" role="radiogroup" aria-label="${esc(label)}" data-group="clothing" data-char="${characterIndex}">
        ${options.map((o) => `
          <button type="button" role="radio" data-action="clothing" data-key="${esc(o.key)}" data-char="${characterIndex}"
            aria-checked="${isSelected(current, o.key)}"
            class="${isSelected(current, o.key) ? "active" : ""}">
            ${esc(o.label)}${o.tag ? ` <small class="nb-tag">${esc(o.tag)}</small>` : ""}
          </button>`).join("")}
      </div>
    </fieldset>`;
  }

  positionHtml() {
    const count = participantNumber(this.context.participant_count);
    if (count == null || count < 2) {
      return `<fieldset class="nb-fieldset">
        <legend class="nb-legend">体位</legend>
        <div class="nb-notice">选择多人以启用体位</div>
      </fieldset>`;
    }
    const visiblePositions = filterPositions(this.options.positions, {
      participantCount: this.context.participant_count,
      sceneKey: this.context.primary_scene_type,
    });
    if (!visiblePositions.length) {
      return `<fieldset class="nb-fieldset">
        <legend class="nb-legend">体位</legend>
        <div class="nb-notice">当前环境 / 情境下暂无可用体位。</div>
      </fieldset>`;
    }
    return this.radioGroupHtml("体位", visiblePositions, this.context.position || null, { action: "exclusive", dataGroup: "position" });
  }

  poseTemplatesHtml() {
    const count = participantNumber(this.context.participant_count) || 1;
    const poses = compatiblePoses(count, [...POSE_LIBRARY, ...this.options.poseTemplates]);
    const cards = poses.map((pose) => { const active = this.context.pose_variation?.id === pose.id; const source = pose.sourceLabel ? `<small class="nb-template-source">${esc(pose.sourceLabel)}</small>` : ""; return `<button type="button" data-action="pose-template" data-id="${esc(pose.id)}" class="${active ? "active" : ""}" aria-pressed="${active}">${esc(pose.label)}${source}<small class="nb-tag">${esc((pose.baseTags || []).join(", "))}</small></button>`; }).join("");
    const candidates = this.templateCandidates.map((item) => this.templateCandidateHtml(item)).join("");
    const notice = this.templateNotice ? `<div class="nb-hint" role="status">${esc(this.templateNotice)}</div>` : "";
    const apiHint = this.templateApiStatus === "error" ? `<div class="nb-notice" role="alert">模板服务暂不可用，请先重启后端服务。<button type="button" data-action="template-refresh">重新连接</button></div>` : "";
    return `<fieldset class="nb-fieldset nb-pose-templates"><legend class="nb-legend">成人姿势模板 <small class="nb-multi-note">（只在成人场景构建器管理）</small></legend><div class="nb-options">${cards || `<span class="nb-hint">暂无已审核模板，请导入一个候选。</span>`}</div><div class="nb-hint">模板只替换姿势和互动关系，不改角色身份、画风或生成参数。</div><div class="nb-template-import"><div class="nb-template-import-title">导入带元数据的模板</div><div class="nb-template-import-row"><input type="text" data-template-civitai-input placeholder="Civitai 图片 ID 或 URL" aria-label="Civitai 图片 ID 或 URL"><button type="button" data-action="template-import-civitai">导入在线元数据</button></div><label class="nb-template-file">或选择本地 PNG / JSON / Prompt <input type="file" data-action="template-import-file" accept=".png,.json,.workflow,.txt,.prompt,.parameters"></label>${apiHint}${notice}${candidates}</div></fieldset>`;
  }

  templateCandidateHtml(item) {
    const structure = item?.structure && typeof item.structure === "object" ? item.structure : {};
    const status = String(item?.status || item?.review?.status || "pending");
    const participantCount = Number(structure.participant_count || item?.participant_count || 1);
    const baseTags = Array.isArray(structure.base_tags) ? structure.base_tags.map(String).filter(Boolean) : [];
    const cameraTags = Array.isArray(structure.camera_tags) ? structure.camera_tags.map(String).filter(Boolean) : [];
    const roles = Array.isArray(structure.role_tags) ? structure.role_tags.map((tags, index) => `角色 ${index + 1}：${(Array.isArray(tags) ? tags : []).map(String).filter(Boolean).join("、") || "未分配"}`) : [];
    const relations = Array.isArray(structure.relations) ? structure.relations.map((row) => `角色 ${Number(row.source) + 1} → ${String(row.action || "互动")} → 角色 ${Number(row.target) + 1}`) : [];
    const removed = Array.isArray(structure.removed_tags) ? structure.removed_tags.map((row) => String(row?.tag || "")).filter(Boolean) : [];
    const unresolved = Array.isArray(structure.unresolved_tags) ? structure.unresolved_tags.map(String).filter(Boolean) : [];
    const metrics = structure.metrics && typeof structure.metrics === "object" ? structure.metrics : {};
    const issues = Array.isArray(item?.quality_issues) ? item.quality_issues.map(String).filter(Boolean) : [];
    let actions = `<span class="nb-template-status">${esc(status === "approved" ? "已批准" : status === "rejected" ? "已拒绝" : status === "blocked" ? "已阻断" : "待审核")}</span>`;
    if (status === "pending") {
      actions = `<button type="button" data-action="template-approve" data-id="${esc(item.id)}">批准加入</button><button type="button" data-action="template-reject" data-id="${esc(item.id)}">拒绝</button>`;
    }
    const sourceUrl = item?.source?.source_url ? `<a href="${esc(item.source.source_url)}" target="_blank" rel="noreferrer">查看来源</a>` : "";
    const list = (label, values) => values.length ? `<div><strong>${label}</strong>：${esc(values.join("；"))}</div>` : "";
    return `<details class="nb-template-candidate"><summary><span>${esc(item?.label || `模板 ${item?.id || ""}`)}</span><small>${esc(status)}</small></summary><div class="nb-template-review-detail"><div><strong>参与者</strong>：${esc(`${participantCount} 人`)}</div>${list("姿势/动作", baseTags)}${list("镜头/构图", cameraTags)}${list("角色分配", roles)}${list("互动关系", relations)}${list("已移除", removed)}${list("未识别", unresolved)}<div><strong>评分</strong>：标签有效率 ${esc(`${Math.round(Number(metrics.tag_validity || 0) * 100)}%`)}，完整度 ${esc(`${Math.round(Number(metrics.completeness || 0) * 100)}%`)}</div>${issues.length ? list("结构问题", issues) : ""}<div class="nb-template-review-actions">${sourceUrl}${actions}</div></div></details>`;
  }

  _templateFetch() {
    return this.fetchImpl || (typeof fetch === "function" ? fetch : null);
  }

  async refreshTemplateLibrary() {
    const fetchImpl = this._templateFetch();
    if (!fetchImpl || this.isDisabled()) return false;
    this.templateApiStatus = "loading";
    try {
      const readJson = async (url) => {
        const response = await fetchImpl(url);
        if (response.status === 404) throw new Error("后端服务版本过旧，请重启应用后再试");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      };
      const runtime = await readJson(`${this.apiBase}/api/runtime-info`);
      if (Number(runtime?.template_api_version || 0) < TEMPLATE_API_VERSION) throw new Error("后端模板接口版本过旧，请重启应用后再试");
      const [approved, pending] = await Promise.all([
        readJson(`${this.apiBase}/api/templates?status=approved`),
        readJson(`${this.apiBase}/api/templates?status=pending`),
      ]);
      this.options.poseTemplates = normalizePoseTemplates(approved?.templates || []);
      this.templateCandidates = Array.isArray(pending?.templates) ? pending.templates : [];
      this.templateApiStatus = "ready";
      if (this.root) this.render();
      return true;
    } catch (error) {
      this.templateApiStatus = "error";
      this.templateNotice = `模板刷新失败：${error.message}`;
      if (this.root) this.render();
      return false;
    }
  }

  async refreshPoseTemplates() { return this.refreshTemplateLibrary(); }

  async importCivitaiTemplate() {
    const input = this.root?.querySelector("[data-template-civitai-input]");
    const value = String(input?.value || "").trim();
    if (!value) { this.templateNotice = "请输入 Civitai 图片 ID 或 URL"; if (this.root) this.render(); return; }
    const fetchImpl = this._templateFetch();
    if (!fetchImpl) return;
    try {
      const response = await fetchImpl(`${this.apiBase}/api/templates/import/civitai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_id_or_url: value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      this.templateCandidates = [data.template, ...this.templateCandidates.filter((item) => item.id !== data.template?.id)].filter(Boolean);
      this.templateNotice = data.duplicate ? "该姿势结构已存在，未重复保存。" : "已导入候选，请人工确认后加入模板库。";
      if (input) input.value = "";
      if (this.root) this.render();
    } catch (error) {
      this.templateNotice = `导入失败：${error.message}`;
      if (this.root) this.render();
    }
  }

  async importTemplateFile(file) {
    if (!file) return;
    const fetchImpl = this._templateFetch();
    if (!fetchImpl) return;
    try {
      const form = new FormData(); form.append("upload", file, file.name);
      const response = await fetchImpl(`${this.apiBase}/api/templates/import/file`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      this.templateCandidates = [data.template, ...this.templateCandidates.filter((item) => item.id !== data.template?.id)].filter(Boolean);
      this.templateNotice = data.duplicate ? "该姿势结构已存在，未重复保存。" : "已导入候选，请人工确认后加入模板库。";
      if (this.root) this.render();
    } catch (error) {
      this.templateNotice = `导入失败：${error.message}`;
      if (this.root) this.render();
    }
  }

  async approveTemplate(id) {
    const fetchImpl = this._templateFetch();
    if (!fetchImpl) return;
    try {
      const response = await fetchImpl(`${this.apiBase}/api/templates/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      this.templateCandidates = this.templateCandidates.filter((item) => String(item.id) !== String(id));
      this.templateNotice = "模板已加入 NSFW Builder。";
      const refreshed = await this.refreshPoseTemplates();
      if (!refreshed) this.templateNotice = "模板已批准，但列表刷新失败，请重新连接模板服务。";
      if (this.root) this.render();
    } catch (error) {
      this.templateNotice = `批准失败：${error.message}`;
      if (this.root) this.render();
    }
  }

  async rejectTemplate(id) {
    const fetchImpl = this._templateFetch();
    if (!fetchImpl) return;
    try {
      const response = await fetchImpl(`${this.apiBase}/api/templates/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "rejected", note: "用户拒绝" }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      this.templateNotice = "候选已拒绝。";
      await this.refreshTemplateLibrary();
      if (this.root) this.render();
    } catch (error) {
      this.templateNotice = `拒绝失败：${error.message}`;
      if (this.root) this.render();
    }
  }

  activitiesHtml() {
    if (!this.options.activities.length) return "";
    return `<section class="nb-group" aria-label="附加活动">
      <fieldset class="nb-fieldset">
        <legend class="nb-legend">附加活动<small class="nb-multi-note">（可多选）</small></legend>
        <div class="nb-options">
          ${this.options.activities.map((o) => {
            const active = (this.context.additional_activities || []).includes(o.key);
            return `<button type="button" data-action="activity" data-key="${esc(o.key)}" aria-pressed="${active}"
              class="${active ? "active" : ""}">
              ${esc(o.label)}${o.tag ? ` <small class="nb-tag">${esc(o.tag)}</small>` : ""}
            </button>`;
          }).join("")}
        </div>
      </fieldset>
    </section>`;
  }

  bodyFocusHtml() {
    if (!this.options.bodyFocus.length) return "";
    return this.radioGroupHtml("身体聚焦", this.options.bodyFocus, this.context.body_focus || null, { action: "body-focus", dataGroup: "bodyfocus" });
  }
  compositionEnvironmentHtml() { return `<section id="nb-镜头环境"><div class="nb-legend">镜头环境 · 写入基础提示词</div>${this.radioGroupHtml("构图", this.options.compositions, this.context.composition, { action:"exclusive", dataGroup:"composition" })}${this.radioGroupHtml("环境 / 情境", [...this.options.scenes,...this.options.environments], this.context.primary_scene_type || this.context.environment, { action:"exclusive", dataGroup:"scene" })}</section>`; }

  radioGroupHtml(label, options, current, { action = "exclusive", dataGroup = "", disabled = false, hint = "", id = "" } = {}) {
    if (!options || !options.length) return "";
    const groupAttr = dataGroup ? ` data-group="${esc(dataGroup)}"` : "";
    return `<fieldset class="nb-fieldset" ${disabled ? "disabled" : ""}${id ? ` id="${esc(id)}"` : ""}>
      <legend class="nb-legend">${esc(label)}</legend>
      <div class="nb-options" role="radiogroup" aria-label="${esc(label)}"${groupAttr}>
        ${options.map((o) => { const comp=this._compatibility(o); const retained=isSelected(current,o.key)&&!comp.ok; return `
          <button type="button" role="radio" data-action="${esc(action)}"${groupAttr} data-key="${esc(o.key)}"
            ${!comp.ok && !retained ? "disabled" : ""} title="${esc(comp.reason)}"
            aria-checked="${isSelected(current, o.key)}"
            class="${isSelected(current, o.key) ? "active" : ""}">
            ${esc(o.label)}${o.tag ? ` <small class="nb-tag">${esc(o.tag)}</small>` : ""}
          </button>${retained ? `<small class="nb-warning">已保留：${esc(comp.reason)}</small>` : ""}`; }).join("")}
      </div>
      ${hint ? `<div class="nb-hint">${esc(hint)}</div>` : ""}
    </fieldset>`;
  }

  recommendHtml() {
    const v = this.view;
    const recButtonHtml = (r) => `
      <button type="button" class="nb-rec" data-action="rec-add" data-tag="${esc(r.tag)}" data-section="${esc(r.section || "")}"
        aria-label="加入 ${esc(r.tag)} 到当前目标">
        ${esc(r.tag)}${r.zh ? ` <small class="nb-zh">${esc(r.zh)}</small>` : ""}
      </button>`;
    const groups = Array.isArray(v.groups) && v.groups.length
      ? v.groups.map((g) => `<div class="nb-rec-group">
          <div class="nb-rec-group-title">${esc(recommendationGroupLabel(g.group))}</div>
          <div class="nb-recs">${g.recommendations.map(recButtonHtml).join("")}</div>
        </div>`).join("")
      : "";
    return `<section class="nb-group" aria-label="推荐">
      <div class="nb-legend">推荐</div>
      <button type="button" class="nb-recommend-btn" data-action="recommend">重试 / 刷新引导</button>
      ${(v.nextSteps || []).map(s=>`<div class="nb-next-step">下一步：${esc(s.zh || s.label || s.node_id)}</div>`).join("")}
      <div class="nb-recs" aria-live="polite">
        ${v.recStatus === "loading" ? `<div class="nb-hint">加载中…</div>` : ""}
        ${v.recStatus === "empty" ? `<div class="nb-hint">${esc(v.message || "暂无可用推荐。")}</div>` : ""}
        ${v.recStatus === "error" ? `<div class="nb-error" role="alert">${esc(v.error || "")}</div>` : ""}
        ${groups || (v.recs.length ? v.recs.map(recButtonHtml).join("") : "")}
      </div>
    </section>`;
  }
}

export function createNsfwBuilder(options) {
  return new NsfwBuilder(options);
}

export default createNsfwBuilder;
