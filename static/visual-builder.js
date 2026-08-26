"use strict";

/**
 * Visual Prompt Builder —— 独立前端组件（语义卡片 + chip 编辑，无画布 / 无连线）。
 *
 * 设计约束（与 static/tag-assistant.js 同一契约精神）：
 *  - 纯模块：不引用 window.state / app.js 全局；DOM 只在 mount()/render() 触碰。
 *  - 无第二份 Prompt 权威状态：永远通过 PromptBridge.getDocument() 按需读取，
 *    组件只缓存「视图数据」（语义卡片树 / 选中节点 / 工作区选择），不保存
 *    PromptDocument 副本。所有编辑动作只 dispatch，靠 subscribe 刷新回流。
 *  - PromptBridge 由集成方（Integrator）提供：
 *      getDocument() -> PromptDocument（schema v2，见 prompt-document.js）
 *      getActiveTarget() -> 'base' | 'global_uc' | 'char:N' | 'char:N:uc'
 *      subscribe(listener) -> unsubscribe
 *      dispatch(action)   -> 见下方「Action 契约」
 *  - 一级工作区：Base / Character 1..N / +（添加角色）；Base 与 Character 内容
 *    互不串用（每个工作区只渲染自己目标的 chip，新增标签一律写入 active target）。
 *  - 语义卡片来自 GET /api/catalog/semantic（Base/Character 概念骨架），不硬编码
 *    数千 taxonomy；节点可选择并显示推荐/seed tags，ADD_TAG 到当前 active target。
 *  - 青少年模式由后端在响应中直接裁剪 nsfw 节点，组件原样渲染，不绕过内容策略。
 *
 * 挂载示例：
 *   import { createVisualBuilder } from "/static/visual-builder.js";
 *   const builder = createVisualBuilder({ root: document.getElementById("visual-prompt-root"), bridge: window.PromptBridge });
 *   builder.mount();
 *
 * Action 契约（组件发出的全部动作，由集成方实现）：
 *   ADD_TAG          { type:"ADD_TAG",          payload:{ tag, target, section?, weight? } }
 *   REMOVE_TAG       { type:"REMOVE_TAG",       payload:{ target, entryId } }
 *   SET_WEIGHT       { type:"SET_WEIGHT",       payload:{ target, entryId, weight } }
 *   MOVE_SECTION     { type:"MOVE_SECTION",     payload:{ target, entryId, section } }
 *   ADD_CHARACTER    { type:"ADD_CHARACTER",    payload:{ name? } }
 *   REMOVE_CHARACTER { type:"REMOVE_CHARACTER", payload:{ index } }
 *   RENAME_CHARACTER { type:"RENAME_CHARACTER", payload:{ index, name } }
 */

import { SECTION_IDS, getTargetEntries } from "./prompt-document.js";

export const SECTION_LABELS = {
  character: "角色", appearance: "外观", clothing: "服装", expression: "表情", action: "动作",
  composition: "构图", scene: "场景", style: "风格", quality: "质量", other: "其他",
};
export const TARGET_LABELS = {
  base: "Base", global_uc: "Global UC", character: "Character",
};
export const WEIGHT_STEP = 0.05;
export const MIN_WEIGHT = 0.1;

/**
 * Base 工作区「Quality」语义卡的兜底骨架：语义导航树当前不含 quality 节点
 * （config/prompt_navigation.json 的 Base 子节点为 Style/Composition/Environment/
 * Lighting/Time-Weather/Objects），但 Visual Builder 的 Base 语义卡规格要求
 * Quality。仅当后端返回的 base 树下没有 section=quality 的节点时注入这一条
 * 最小骨架（seed_tags 取自项目质量分区常用词，见 prompt/sections.py 的 quality 规则），
 * 绝不硬编码全量 taxonomy。
 */
export const QUALITY_FALLBACK_NODE = {
  id: "base_quality", label: "Quality", zh: "质量", target: "base", section: "quality",
  nsfw: false,
  seed_tags: ["masterpiece", "best quality", "highres", "absurdres"],
  children: [],
};

// ---- 小工具（无 DOM） ----

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 权重显示：四舍五入到 2 位小数并去掉尾零（1.30 -> 1.3）。
export function trimWeight(weight) {
  const w = Number(weight);
  if (!Number.isFinite(w)) return "1";
  return String(Math.round(w * 100) / 100);
}

// chip 文案：weight=1 简洁显示 tag；非 1 显示如 `blue eyes · 1.3`。
export function chipLabel(entry) {
  const tag = String(entry?.tag ?? "").trim();
  if (!tag) return "";
  const w = Number(entry?.weight ?? 1);
  return w === 1 ? tag : `${tag} · ${trimWeight(w)}`;
}

// 权重步进：±WEIGHT_STEP，夹在 [MIN_WEIGHT, +∞)，2 位小数。
export function adjustWeight(weight, delta = 0, min = MIN_WEIGHT) {
  const w = Number(weight);
  if (!Number.isFinite(w)) return Number(min);
  const d = Number(delta);
  const next = Math.round((w + (Number.isFinite(d) ? d : 0)) * 100) / 100;
  return next < min ? Number(min) : next;
}

// 目标 -> 一级工作区：base/global_uc 归 Base；char:N(:uc) 归 char:N；未知为空。
export function workspaceForTarget(target) {
  const t = String(target ?? "");
  if (t === "base" || t === "global_uc") return "base";
  const m = t.match(/^char:(\d+)(:uc)?$/);
  return m ? `char:${m[1]}` : "";
}

// 工作区 tabs：Base + 每个角色（角色名缺省 Character N）。
export function workspaceTabs(doc) {
  const tabs = [{ key: "base", label: "Base", index: null }];
  if (doc && Array.isArray(doc.characters)) {
    doc.characters.forEach((ch, i) => {
      tabs.push({ key: `char:${i}`, label: String(ch?.name || `Character ${i + 1}`), index: i });
    });
  }
  return tabs;
}

// 条目按固定分区顺序分组；每组附带 chip 展示文案与所属 target。
export function groupEntriesBySection(entries, target) {
  const groups = [];
  for (const section of SECTION_IDS) {
    const items = (entries || []).filter((e) => e && e.section === section && String(e.tag).trim());
    if (!items.length) continue;
    groups.push({
      section,
      label: SECTION_LABELS[section] || section,
      target: String(target ?? ""),
      entries: items.map((e) => ({ ...e, target: String(target ?? ""), display: chipLabel(e) })),
    });
  }
  return groups;
}

// 工作区 -> 该工作区两个目标的 chip 分组（prompt 正片 / UC 负面），无匹配工作区返回 null。
export function buildWorkspaceChips(doc, workspaceKey) {
  const key = String(workspaceKey ?? "");
  let promptTarget = "";
  let ucTarget = "";
  if (key === "base") {
    promptTarget = "base";
    ucTarget = "global_uc";
  } else {
    const m = key.match(/^char:(\d+)$/);
    if (!m || !doc || !Array.isArray(doc.characters) || !doc.characters[Number(m[1])]) return null;
    promptTarget = `char:${m[1]}`;
    ucTarget = `${promptTarget}:uc`;
  }
  return {
    prompt: groupEntriesBySection(getTargetEntries(doc, promptTarget), promptTarget),
    uc: groupEntriesBySection(getTargetEntries(doc, ucTarget), ucTarget),
  };
}

// 语义树节点 -> 卡片 DTO（纯视图数据）。
export function normalizeSemanticNode(node) {
  if (!node || typeof node !== "object" || !node.id) return null;
  return {
    id: String(node.id),
    label: String(node.label ?? node.id),
    zh: String(node.zh ?? ""),
    section: String(node.section ?? ""),
    target: String(node.target ?? ""),
    seedTags: Array.isArray(node.seed_tags) ? node.seed_tags.map(String) : [],
    children: Array.isArray(node.children) ? node.children.map(normalizeSemanticNode).filter(Boolean) : [],
  };
}

// 工作区 -> 语义卡片列表（base -> tree.base.children，char:N -> tree.character.children）。
// Base 缺 Quality 节点时注入 QUALITY_FALLBACK_NODE（见上）。
export function semanticCards(tree, workspaceKey) {
  if (!tree || typeof tree !== "object") return [];
  const isCharacter = String(workspaceKey ?? "").startsWith("char");
  const root = isCharacter ? tree.character : tree.base;
  const cards = Array.isArray(root?.children) ? root.children.map(normalizeSemanticNode).filter(Boolean) : [];
  if (!isCharacter && !cards.some((c) => c.section === "quality")) {
    cards.push(normalizeSemanticNode(QUALITY_FALLBACK_NODE));
  }
  return cards;
}

export function cardSectionLabel(section) {
  return SECTION_LABELS[String(section ?? "")] || "";
}

// ---- Action 构建（与 PromptBridge 契约一一对应） ----
export function buildAddTagAction(tag, target, section = "", weight) {
  const payload = { tag: String(tag ?? ""), target: String(target ?? "") };
  if (String(section).trim()) payload.section = String(section).trim();
  if (weight != null) payload.weight = weight;
  return { type: "ADD_TAG", payload };
}
export function buildRemoveTagAction(target, entryId) {
  return { type: "REMOVE_TAG", payload: { target: String(target ?? ""), entryId: String(entryId ?? "") } };
}
export function buildSetWeightAction(target, entryId, weight) {
  return { type: "SET_WEIGHT", payload: { target: String(target ?? ""), entryId: String(entryId ?? ""), weight: Number(weight) } };
}
export function buildMoveSectionAction(target, entryId, section) {
  return { type: "MOVE_SECTION", payload: { target: String(target ?? ""), entryId: String(entryId ?? ""), section: String(section ?? "") } };
}
export function buildAddCharacterAction(name = "") {
  const payload = String(name).trim() ? { name: String(name).trim() } : {};
  return { type: "ADD_CHARACTER", payload };
}
export function buildRemoveCharacterAction(index) {
  return { type: "REMOVE_CHARACTER", payload: { index: Number(index) } };
}
export function buildRenameCharacterAction(index, name) {
  return { type: "RENAME_CHARACTER", payload: { index: Number(index), name: String(name ?? "") } };
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

function emptyView() {
  return {
    status: "idle", error: "", message: "", tree: null, nodeById: {}, activeNodeId: "", nodeStatus: "",
    tabs: [], activeTarget: "", workspace: "base", chips: null, cards: [],
  };
}

/**
 * VisualBuilder 组件实例。options：
 *   root       挂载容器（缺省则只做无 DOM 的核心逻辑，便于 Node 测试）
 *   bridge     PromptBridge（缺省回退 window.PromptBridge）
 *   apiBase    后端前缀（默认 ""，即同源）
 *   fetchImpl  自定义 fetch（测试注入）
 */
export class VisualBuilder {
  constructor(options = {}) {
    this.root = options.root || null;
    this.apiBase = String(options.apiBase || "");
    this.bridge = options.bridge || (typeof window !== "undefined" && window.PromptBridge ? window.PromptBridge : null);
    this.fetchImpl = options.fetchImpl || null;
    this.view = emptyView();
    this.ucOpen = false;              // UC 区折叠状态（视图状态，非 Prompt 状态）
    this.viewWorkspace = "";          // 当前查看的工作区（'' = 跟随 active target）
    this._workspaceExplicit = false;  // 用户是否手动选了工作区 tab
    this._lastTargetWs = "";
    this._destroyed = false;
    this._unsubscribe = null;
    this.onClick = (event) => this.handleClick(event);
    this.onChange = (event) => this.handleChange(event);
    this.onKeydown = (event) => this.handleKeydown(event);
    this.onBridgeChange = () => { if (!this._destroyed) this.refresh(); };
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
    this.reloadTree();
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

  // 工作区跟随 active target；用户手动选择后保持（active target 换工作区时重新跟随）。
  _syncWorkspace(targetWs) {
    if (!this._workspaceExplicit || this._lastTargetWs !== targetWs) {
      this.viewWorkspace = targetWs || "base";
      this._lastTargetWs = targetWs;
    }
  }

  // 从 PromptBridge 按需读取文档并刷新视图（不保存文档副本）。
  refresh() {
    if (this._destroyed) return;
    const bridge = this.bridge;
    if (!bridge || typeof bridge.getDocument !== "function") {
      this.view = { ...emptyView(), status: "empty", message: "未检测到 PromptBridge：Visual Builder 需要 PromptDocument 与 dispatch 能力。" };
      if (this.root) this.render();
      return;
    }
    const doc = bridge.getDocument();
    if (!doc || typeof doc !== "object") {
      this.view = { ...emptyView(), status: "empty", message: "PromptBridge 未返回 PromptDocument（schema v2）。" };
      if (this.root) this.render();
      return;
    }
    const target = typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "base";
    const targetWs = workspaceForTarget(target);
    this._syncWorkspace(targetWs);
    const cards = semanticCards(this.view.tree, this.viewWorkspace);
    this.view = {
      ...emptyView(),
      status: "ok",
      tree: this.view.tree,
      nodeById: this.view.nodeById,
      activeNodeId: this.view.activeNodeId,
      nodeStatus: this.view.nodeStatus,
      tabs: workspaceTabs(doc),
      activeTarget: String(target || "base"),
      workspace: this.viewWorkspace,
      chips: buildWorkspaceChips(doc, this.viewWorkspace),
      cards,
    };
    if (this.root) this.render();
  }

  selectWorkspace(key) {
    const k = String(key || "");
    if (k !== "base" && !/^char:\d+$/.test(k)) return;
    this._workspaceExplicit = true;
    this.viewWorkspace = k;
    this.refresh();
  }

  async api(path, opts = {}) {
    const fetchImpl = this.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("fetch 不可用（后端未连接？）");
    const res = await fetchImpl(`${this.apiBase}${path}`, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!res || !res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* 忽略 */ }
      throw new Error(`HTTP ${res ? res.status : "?"}${detail ? `：${detail}` : ""}`);
    }
    return res.json();
  }

  // 语义卡片骨架：GET /api/catalog/semantic（青少年模式裁剪由后端完成，原样渲染）。
  async reloadTree() {
    if (this._destroyed) return;
    this.view = { ...this.view, status: this.view.status === "ok" ? this.view.status : "loading" };
    if (this.root) this.render();
    try {
      const data = await this.api("/api/catalog/semantic");
      const tree = data && typeof data.tree === "object" ? data.tree : null;
      if (!tree || (!tree.base && !tree.character)) {
        this.view = { ...emptyView(), status: "empty", message: "语义导航树未配置（/api/catalog/semantic 无数据）。" };
        if (this.root) this.render();
        return;
      }
      this.view.tree = tree;
      this.refresh();
    } catch (error) {
      this.view = { ...emptyView(), status: "error", error: String(error?.message || error) };
      if (this.root) this.render();
    }
  }

  // 选择目录节点：下钻单节点刷新推荐/seed tags（后端按青少年模式过滤）。
  async selectNode(nodeId) {
    if (this._destroyed) return;
    const id = String(nodeId || "");
    this.view.activeNodeId = id;
    this.view.nodeStatus = "loading";
    if (this.root) this.render();
    try {
      const data = await this.api(`/api/catalog/semantic?node_id=${encodeURIComponent(id)}`);
      const node = normalizeSemanticNode(data && data.node);
      if (node) this.view.nodeById = { ...this.view.nodeById, [id]: node };
      this.view.nodeStatus = node ? "ok" : "empty";
    } catch (error) {
      this.view.nodeStatus = "error";
      this.view.error = String(error?.message || error);
    }
    if (this.root) this.render();
  }

  // ---- dispatch 路径（全部只 dispatch，不读 window.state、不改文档） ----

  addTag(tag, section = "") {
    const bridge = this.bridge;
    const target = bridge && typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "";
    return dispatchAction(bridge, buildAddTagAction(tag, target, section));
  }

  removeChip(target, entryId) {
    return dispatchAction(this.bridge, buildRemoveTagAction(target, entryId));
  }

  setChipWeight(target, entryId, weight) {
    return dispatchAction(this.bridge, buildSetWeightAction(target, entryId, weight));
  }

  moveChipSection(target, entryId, section) {
    return dispatchAction(this.bridge, buildMoveSectionAction(target, entryId, section));
  }

  addCharacter(name = "") {
    return dispatchAction(this.bridge, buildAddCharacterAction(name));
  }

  removeCharacter(index) {
    return dispatchAction(this.bridge, buildRemoveCharacterAction(index));
  }

  renameCharacter(index, name) {
    return dispatchAction(this.bridge, buildRenameCharacterAction(index, name));
  }

  // ---- 事件委托（root 单监听器）+ 基础键盘可用性 ----

  handleClick(event) {
    const node = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-action]") : null;
    if (!node) return;
    const action = node.dataset.action;
    if (action === "workspace") {
      this.selectWorkspace(node.dataset.workspace);
    } else if (action === "add-character") {
      const ok = this.addCharacter();
      if (!ok && this.root) this.flashStatus("未连接 PromptBridge，无法添加角色。");
    } else if (action === "remove-character") {
      const ok = this.removeCharacter(Number(node.dataset.index));
      if (!ok && this.root) this.flashStatus("未连接 PromptBridge，无法移除角色。");
    } else if (action === "card") {
      this.selectNode(node.dataset.node);
    } else if (action === "add") {
      const ok = this.addTag(node.dataset.tag, node.dataset.section || "");
      if (!ok && this.root) this.flashStatus("未连接 PromptBridge，无法加入标签。");
    } else if (action === "weight-down" || action === "weight-up") {
      const chip = node.closest(".vb-chip");
      const current = Number(chip?.dataset?.weight ?? 1);
      const next = adjustWeight(current, action === "weight-up" ? WEIGHT_STEP : -WEIGHT_STEP);
      this.setChipWeight(node.dataset.target, node.dataset.entryId, next);
    } else if (action === "remove-tag") {
      this.removeChip(node.dataset.target, node.dataset.entryId);
    } else if (action === "uc-toggle") {
      this.ucOpen = !this.ucOpen; // 与 <details> 原生切换同步；不重建 DOM，避免闪烁
    } else if (action === "retry") {
      this.reloadTree();
    }
  }

  handleChange(event) {
    const node = event.target;
    if (!node || !node.dataset) return;
    if (node.dataset.action === "move-section") {
      this.moveChipSection(node.dataset.target, node.dataset.entryId, node.value);
    } else if (node.dataset.action === "rename-character") {
      this.renameCharacter(Number(node.dataset.index), node.value);
    }
  }

  handleKeydown(event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const tabBtn = event.target && typeof event.target.closest === "function" ? event.target.closest('[role="tab"]') : null;
      if (tabBtn && this.root) {
        const tabs = Array.from(this.root.querySelectorAll('[role="tab"][data-workspace]'));
        const idx = tabs.indexOf(tabBtn);
        if (idx >= 0) {
          event.preventDefault();
          const next = tabs[(idx + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          this.selectWorkspace(next.dataset.workspace);
          const focused = this.root.querySelector(`[role="tab"][data-workspace="${next.dataset.workspace}"]`);
          if (focused) focused.focus();
        }
      }
    }
  }

  flashStatus(message) {
    const status = this.root && this.root.querySelector(".vb-status-flash");
    if (status) status.textContent = message;
  }

  // ---- 渲染 ----

  render() {
    if (!this.root) return;
    const v = this.view;
    const statusHtml = this.statusHtml();
    const workspaceTab = v.tabs.find((t) => t.key === v.workspace) || null;
    const targetWs = workspaceForTarget(v.activeTarget);
    const inActiveWs = v.workspace === targetWs;
    const targetLabel = this.targetLabel(v.activeTarget);
    const charWorkspace = workspaceTab && workspaceTab.index != null ? workspaceTab : null;
    const canRemoveChar = charWorkspace != null && v.tabs.length > 2; // Base + 至少 2 个角色才允许移除

    this.root.innerHTML = `
      <div class="visual-builder" role="region" aria-label="Visual Prompt Builder">
        <div class="vb-header">
          <div class="vb-workspaces" role="tablist" aria-label="工作区">
            ${v.tabs.map((tab) => `
              <button type="button" role="tab" data-action="workspace" data-workspace="${esc(tab.key)}"
                id="vb-ws-${esc(tab.key)}" aria-selected="${v.workspace === tab.key}"
                class="${v.workspace === tab.key ? "active" : ""}">${esc(tab.label)}</button>`).join("")}
            <button type="button" class="vb-add-ws" data-action="add-character" aria-label="添加角色" title="添加角色">+</button>
          </div>
          <div class="vb-target" aria-live="polite">
            当前目标：${esc(targetLabel)}
            ${inActiveWs ? "" : `<span class="vb-target-note">（当前查看「${esc(workspaceTab ? workspaceTab.label : "")}」，新增标签仍写入「${esc(targetLabel)}」）</span>`}
          </div>
          ${charWorkspace ? `
            <div class="vb-char-actions">
              <label class="vb-rename-label">角色名
                <input type="text" class="vb-rename-input" data-action="rename-character" data-index="${charWorkspace.index}"
                  value="${esc(charWorkspace.label)}" aria-label="角色名（回车或失焦后生效）" />
              </label>
              ${canRemoveChar ? `
                <button type="button" class="vb-remove-char" data-action="remove-character" data-index="${charWorkspace.index}" aria-label="移除角色「${esc(charWorkspace.label)}」">移除角色</button>` : ""}
            </div>` : ""}
        </div>
        <div class="vb-status-flash" aria-live="polite"></div>
        ${statusHtml}
        <div class="vb-body">
          ${this.chipsHtml(v)}
          ${this.cardsHtml(v)}
        </div>
      </div>`;
    const renameInput = this.root.querySelector('input[data-action="rename-character"]');
    if (renameInput && typeof document !== "undefined" && document.activeElement !== renameInput) {
      renameInput.value = workspaceTab ? workspaceTab.label : "";
    }
  }

  targetLabel(target) {
    const t = String(target || "");
    if (t === "base") return "Base";
    if (t === "global_uc") return "Global UC";
    const m = t.match(/^char:(\d+)(:uc)?$/);
    if (m) return `Character ${Number(m[1]) + 1}${m[2] ? " UC" : ""}`;
    return TARGET_LABELS[t] || t || "Base";
  }

  statusHtml() {
    const v = this.view;
    if (v.status === "error") {
      return `<div class="vb-status vb-error" role="alert">${esc(v.error || "")}<button type="button" class="vb-retry" data-action="retry">重试</button></div>`;
    }
    if (v.status === "loading") return `<div class="vb-status vb-loading" aria-live="polite">加载中…</div>`;
    if (v.status === "empty") return `<div class="vb-status vb-empty" aria-live="polite">${esc(v.message || "暂无内容")}</div>`;
    if (v.status === "idle") return `<div class="vb-status vb-hint">${esc(v.message || "")}</div>`;
    return "";
  }

  chipHtml(entry) {
    return `<span class="vb-chip" data-target="${esc(entry.target)}" data-entry-id="${esc(entry.id)}" data-weight="${Number(entry.weight ?? 1)}">
      <span class="vb-chip-label" title="分区：${esc(SECTION_LABELS[entry.section] || entry.section)}">${esc(entry.display)}</span>
      <button type="button" class="vb-chip-btn" data-action="weight-down" data-target="${esc(entry.target)}" data-entry-id="${esc(entry.id)}" aria-label="降低「${esc(entry.tag)}」权重">−</button>
      <button type="button" class="vb-chip-btn" data-action="weight-up" data-target="${esc(entry.target)}" data-entry-id="${esc(entry.id)}" aria-label="提高「${esc(entry.tag)}」权重">＋</button>
      <select class="vb-chip-move" data-action="move-section" data-target="${esc(entry.target)}" data-entry-id="${esc(entry.id)}" aria-label="移动「${esc(entry.tag)}」到分区">
        ${SECTION_IDS.map((s) => `<option value="${s}" ${s === entry.section ? "selected" : ""}>${SECTION_LABELS[s]}</option>`).join("")}
      </select>
      <button type="button" class="vb-chip-btn vb-chip-del" data-action="remove-tag" data-target="${esc(entry.target)}" data-entry-id="${esc(entry.id)}" aria-label="删除「${esc(entry.tag)}」">×</button>
    </span>`;
  }

  groupHtml(group, uc = false) {
    return `<div class="vb-chip-group${uc ? " vb-uc-group" : ""}">
      <div class="vb-chip-group-label">${esc(group.label)}${group.target !== this.view.workspace ? `<span class="vb-chip-target">（${esc(this.targetLabel(group.target))}）</span>` : ""}</div>
      <div class="vb-chip-row">${group.entries.map((e) => this.chipHtml(e)).join("")}</div>
    </div>`;
  }

  chipsHtml(v) {
    const chips = v.chips;
    const promptGroups = chips ? chips.prompt : [];
    const ucGroups = chips ? chips.uc : [];
    const ucTarget = v.workspace === "base" ? "global_uc" : `${v.workspace}:uc`;
    const ucLabel = v.workspace === "base" ? "Global UC" : `${this.targetLabel(v.workspace)} UC`;
    const emptyHint = promptGroups.length ? "" : `<div class="vb-status vb-hint">当前工作区暂无已选标签：从下方语义卡片点选标签加入，或切换到其他工作区。</div>`;
    return `<section class="vb-chips" aria-label="已选标签（chip 编辑）">
      <div class="vb-section-title">已选标签</div>
      ${emptyHint}
      ${promptGroups.map((g) => this.groupHtml(g, false)).join("")}
      <details class="vb-uc" ${this.ucOpen ? "open" : ""}>
        <summary data-action="uc-toggle" role="button" aria-label="展开 / 折叠 ${esc(ucLabel)}">${esc(ucLabel)}</summary>
        <div class="vb-uc-body">
          ${ucGroups.length ? ucGroups.map((g) => this.groupHtml(g, true)).join("") : `<div class="vb-status vb-hint">${esc(ucLabel)} 暂无标签。</div>`}
        </div>
      </details>
    </section>`;
  }

  cardHtml(card, depth = 0) {
    const fresh = this.view.nodeById && this.view.nodeById[card.id] ? this.view.nodeById[card.id] : card;
    const active = this.view.activeNodeId === fresh.id;
    const section = cardSectionLabel(fresh.section);
    const chips = fresh.seedTags.map((tag) => `
      <button type="button" class="vb-seed" data-action="add" data-tag="${esc(tag)}" data-section="${esc(fresh.section)}"
        aria-label="加入 ${esc(tag)} 到当前目标">＋ ${esc(tag)}</button>`).join("");
    return `<div class="vb-card ${active ? "active" : ""}" style="--vb-depth:${depth}">
      <button type="button" class="vb-card-head" data-action="card" data-node="${esc(fresh.id)}" aria-expanded="${active && fresh.children.length ? "true" : "false"}">
        <span class="vb-card-label">${esc(fresh.label)}</span>
        ${fresh.zh ? `<span class="vb-card-zh">${esc(fresh.zh)}</span>` : ""}
        ${section ? `<span class="vb-card-section">${esc(section)}</span>` : ""}
        <span class="vb-card-state">${active ? "▾" : "▸"}</span>
      </button>
      <div class="vb-card-seeds">
        ${chips || `<span class="vb-hint">该节点暂无推荐标签</span>`}
      </div>
      ${active && fresh.children.length ? `<div class="vb-card-children">${fresh.children.map((c) => this.cardHtml(c, depth + 1)).join("")}</div>` : ""}
    </div>`;
  }

  cardsHtml(v) {
    const cards = v.cards || [];
    const intro = `<div class="vb-cards-title">语义卡片</div>
      <div class="vb-cards-hint">点击卡片查看该创作意图的推荐 / seed 标签；点「＋ 标签」加入当前目标。</div>`;
    if (v.status === "error") return `<section class="vb-cards" aria-label="语义卡片">${intro}${this.statusHtml()}</section>`;
    if (v.status === "loading" && !cards.length) return `<section class="vb-cards" aria-label="语义卡片">${intro}${this.statusHtml()}</section>`;
    if (v.status === "empty") return `<section class="vb-cards" aria-label="语义卡片">${intro}${this.statusHtml()}</section>`;
    if (!cards.length) return `<section class="vb-cards" aria-label="语义卡片">${intro}<div class="vb-status vb-hint">当前工作区暂无语义卡片（/api/catalog/semantic 未配置该目标骨架）。</div></section>`;
    return `<section class="vb-cards" aria-label="语义卡片">${intro}<div class="vb-card-grid">${cards.map((c) => this.cardHtml(c, 0)).join("")}</div></section>`;
  }
}

export function createVisualBuilder(options) {
  return new VisualBuilder(options);
}

export default createVisualBuilder;
