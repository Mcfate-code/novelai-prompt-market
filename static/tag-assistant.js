"use strict";

/**
 * Tag Assistant —— 独立前端组件（推荐 / 目录 / 搜索 / 收藏 四入口）。
 *
 * 设计约束（与项目的 prompt-document.js 同一契约精神）：
 *  - 纯模块：不引用 window.state / app.js 全局；DOM 只在 mount()/render() 触碰。
 *  - 无第二份权威 Prompt 状态：永远通过 PromptBridge.getDocument() 按需读取，
 *    组件只缓存「视图数据」（推荐结果 / 语义骨架 / 搜索结果 / 收藏列表），
 *    不保存 PromptDocument 副本。
 *  - PromptBridge 由集成方（Integrator）提供：
 *      getDocument() -> PromptDocument（schema v2，见 prompt-document.js）
 *      getActiveTarget() -> 'base' | 'global_uc' | 'char:N' | 'char:N:uc'
 *      subscribe(listener) -> unsubscribe
 *      dispatch(action)   -> ADD_TAG / REMOVE_TAG / SET_WEIGHT / MOVE_SECTION
 *    本组件只消费 ADD_TAG：{ type:'ADD_TAG', payload:{ tag, target, section?, weight? } }。
 *
 * 挂载示例：
 *   import { createTagAssistant } from "/static/tag-assistant.js";
 *   const assistant = createTagAssistant({ root: document.getElementById("tag-assistant-root"), bridge: window.PromptBridge });
 *   assistant.mount();
 *
 * 依赖的既有后端接口（禁止修改后端）：
 *   POST /api/recommendations {tags,target,node_id,limit}
 *   GET  /api/catalog/semantic?node_id=
 *   GET  /api/search?q=&limit=
 *   GET  /api/favorites
 */

import { getTargetEntries } from "./prompt-document.js";

export const TAB_LABELS = { recommend: "推荐", catalog: "目录", search: "搜索", favorites: "收藏" };
export const TAB_ORDER = ["recommend", "catalog", "search", "favorites"];
export const SECTION_LABELS = {
  character: "角色", appearance: "外观", clothing: "服装", expression: "表情", action: "动作",
  composition: "构图", scene: "场景", style: "画风", quality: "质量", other: "其他",
};
export const SECTION_IDS_ORDER = ["character", "appearance", "clothing", "expression", "action", "composition", "scene", "style", "quality", "other"];
export const TARGET_LABELS = { base: "Base Prompt", global_uc: "Global UC", character: "Character" };
export const DEFAULT_DEBOUNCE_MS = 400;
export const DEFAULT_SEARCH_DEBOUNCE_MS = 250;
export const REC_LIMIT = 20;
export const SEARCH_LIMIT = 20;

// ---- 小工具（无 DOM） ----
export function debounce(fn, ms = DEFAULT_DEBOUNCE_MS) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function abbreviateCount(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return v ? String(v) : "";
}

// ---- 推荐：从 PromptDocument 提取 positive 标签（base + 各角色 prompt；UC 不参与，与后端一致） ----
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

// 已选集合：整个文档所有目标的条目（大小写不敏感）——推荐据此去重。
export function selectedTagKeys(doc) {
  const keys = new Set();
  if (!doc || typeof doc !== "object") return keys;
  const targets = ["base", "global_uc"];
  for (let i = 0; i < (Array.isArray(doc.characters) ? doc.characters.length : 0); i++) targets.push(`char:${i}`, `char:${i}:uc`);
  for (const target of targets) {
    for (const entry of getTargetEntries(doc, target)) {
      if (String(entry.tag).trim()) keys.add(String(entry.tag).trim().toLocaleLowerCase());
    }
  }
  return keys;
}

// active target -> 后端允许的 target（base|character）
export function mapBackendTarget(target) {
  const t = String(target || "");
  if (/^char:\d+$/.test(t)) return "character";
  if (/^char:\d+:uc$/.test(t)) return "character"; // 角色 UC 正向语境仍是该角色
  return "base"; // base / global_uc / 未知
}

export function buildRecommendPayload(doc, target, nodeId = "", limit = REC_LIMIT) {
  return {
    tags: positiveTagsFromDocument(doc),
    target: mapBackendTarget(target),
    node_id: String(nodeId || ""),
    limit: Number(limit) > 0 ? Number(limit) : REC_LIMIT,
  };
}

// 推荐去重：tag 或 canonical 命中已选集合即剔除（大小写不敏感）。
export function filterSelected(recommendations, selected) {
  const keys = selected instanceof Set ? selected : new Set((selected || []).map((k) => String(k).toLocaleLowerCase()));
  return (recommendations || []).filter((item) => {
    const tag = String(item?.tag ?? item?.canonical ?? "").toLocaleLowerCase();
    const canonical = String(item?.canonical ?? item?.tag ?? "").toLocaleLowerCase();
    return !keys.has(tag) && !keys.has(canonical);
  });
}

// ---- 统一 Tag card DTO：兼容 推荐 / 搜索 / 收藏 / 节点种子 四种来源 ----
export function toCard(item) {
  if (!item || typeof item !== "object") return null;
  const tag = String(item.tag ?? item.canonical ?? "");
  if (!tag) return null;
  return {
    tag,
    canonical: String(item.canonical ?? item.tag ?? ""),
    zh: String(item.zh ?? ""),
    postCount: Number(item.post_count ?? item.postCount ?? 0) || 0,
    section: String(item.section ?? ""),
    count: Number(item.count ?? 0) || 0,
    reason: String(item.reason ?? ""),
    source: Array.isArray(item.source) ? item.source.map(String) : (item.source ? [String(item.source)] : []),
    matchReason: String(item.match_reason ?? ""),
  };
}

export function toCards(items) {
  return (items || []).map(toCard).filter(Boolean);
}

// 按语义分区分组（固定分区顺序，保持组内后端排序）。
export function groupRecommendations(recommendations) {
  const bySection = new Map();
  for (const item of recommendations || []) {
    const card = toCard(item);
    if (!card) continue;
    const section = SECTION_IDS_ORDER.includes(card.section) ? card.section : "other";
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(card);
  }
  return SECTION_IDS_ORDER.filter((section) => bySection.has(section)).map((section) => ({
    section,
    label: SECTION_LABELS[section],
    items: bySection.get(section),
  }));
}

// ---- 目录：语义导航骨架（不展开 5 万标签树） ----
export function flattenSemanticTree(tree) {
  const roots = [];
  if (!tree || typeof tree !== "object") return roots;
  for (const key of ["base", "character"]) {
    const root = tree[key];
    if (!root || typeof root !== "object") continue;
    const nodes = [];
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || !node.id) return;
      nodes.push({
        id: String(node.id),
        label: String(node.label ?? node.id),
        zh: String(node.zh ?? ""),
        depth,
        nsfw: !!node.nsfw,
        seedTags: Array.isArray(node.seed_tags) ? node.seed_tags.map(String) : [],
      });
      for (const child of node.children || []) walk(child, depth + 1);
    };
    for (const child of root.children || []) walk(child, 1);
    roots.push({ key, label: String(root.label ?? (key === "base" ? "Base" : "Character")), nodes });
  }
  return roots;
}

// 节点种子标签兜底（词库真实标签，无推荐结果时展示）。
export function recommendFallback(node) {
  if (!node || !Array.isArray(node.seedTags) || !node.seedTags.length) return [];
  return node.seedTags.map((tag) => ({ tag, canonical: tag, zh: "", postCount: 0, section: "", count: 0, reason: "node_seed", source: ["node_seed"] }));
}

// ---- PromptBridge dispatch 契约 ----
export function buildAddTagAction(tag, { target = "", section = "", weight } = {}) {
  const payload = { tag: String(tag ?? ""), target: String(target ?? "") };
  if (String(section).trim()) payload.section = String(section).trim();
  if (weight != null) payload.weight = weight;
  return { type: "ADD_TAG", payload };
}

// 返回是否真正 dispatch 成功（无桥 / 桥无 dispatch 时返回 false，不抛错）。
export function dispatchAddTag(bridge, action) {
  if (!bridge || typeof bridge.dispatch !== "function") return false;
  try {
    bridge.dispatch(action);
    return true;
  } catch {
    return false;
  }
}

function emptyView() {
  return { status: "idle", error: "", message: "", groups: [], cards: [], nodes: [], activeNode: null, seedFallback: false, targetLabel: "", nodeLabel: "", query: "" };
}

/**
 * TagAssistant 组件实例。options：
 *   root       挂载容器（缺省则只做无 DOM 的核心逻辑，便于 Node 测试）
 *   bridge     PromptBridge（缺省回退 window.PromptBridge）
 *   apiBase    后端前缀（默认 ""，即同源）
 *   limit      推荐 / 搜索条数（默认 20）
 *   debounceMs PromptBridge 变化 -> 推荐刷新的防抖毫秒（默认 400）
 *   nodeId     初始语义节点（可选）
 *   fetchImpl  自定义 fetch（测试注入）
 */
export class TagAssistant {
  constructor(options = {}) {
    this.root = options.root || null;
    this.apiBase = String(options.apiBase || "");
    this.limit = Number(options.limit) > 0 ? Number(options.limit) : REC_LIMIT;
    this.debounceMs = Number(options.debounceMs) > 0 ? Number(options.debounceMs) : DEFAULT_DEBOUNCE_MS;
    this.bridge = options.bridge || (typeof window !== "undefined" && window.PromptBridge ? window.PromptBridge : null);
    this.fetchImpl = options.fetchImpl || null;
    this.nodeId = String(options.nodeId || "");
    this.tab = "recommend"; // 默认推荐入口
    this.searchQuery = "";
    this.view = emptyView();
    this.nodesCache = null;
    this._searchSeq = 0;
    this._destroyed = false;
    this._unsubscribe = null;
    this._refresh = debounce(() => { if (!this._destroyed) this.reloadRecommendations({ silent: true }); }, this.debounceMs);
    this._searchRefresh = debounce(() => { if (!this._destroyed) this.reloadSearch().then(() => this.renderResults()); }, DEFAULT_SEARCH_DEBOUNCE_MS);
    this.onClick = (event) => this.handleClick(event);
    this.onKeydown = (event) => this.handleKeydown(event);
    this.onBridgeChange = () => { if (!this._destroyed) this._refresh(); };
  }

  mount() {
    if (this._destroyed) return;
    if (this.root) {
      this.render();
      this.root.addEventListener("click", this.onClick);
      this.root.addEventListener("keydown", this.onKeydown);
    }
    const bridge = this.bridge;
    if (bridge && typeof bridge.subscribe === "function") {
      this._unsubscribe = bridge.subscribe(this.onBridgeChange);
    }
    this.reload(this.tab);
  }

  destroy() {
    this._destroyed = true;
    if (this._unsubscribe) { try { this._unsubscribe(); } catch { /* 忽略 */ } this._unsubscribe = null; }
    this._refresh.cancel();
    this._searchRefresh.cancel();
    if (this.root) {
      this.root.removeEventListener("click", this.onClick);
      this.root.removeEventListener("keydown", this.onKeydown);
    }
  }

  setBridge(bridge) {
    this.bridge = bridge || null;
    if (this.bridge && typeof this.bridge.subscribe === "function") {
      if (this._unsubscribe) { try { this._unsubscribe(); } catch { /* 忽略 */ } }
      this._unsubscribe = this.bridge.subscribe(this.onBridgeChange);
    }
    if (!this._destroyed) this.reload("recommend");
  }

  setTab(tab) {
    if (!Object.prototype.hasOwnProperty.call(TAB_LABELS, tab)) return;
    this.tab = tab;
    this.reload(tab);
  }

  async reload(tab) {
    if (this._destroyed) return;
    this.tab = tab;
    if (tab === "recommend") await this.reloadRecommendations({ silent: false });
    else if (tab === "catalog") await this.reloadCatalog();
    else if (tab === "search") await this.reloadSearch();
    else if (tab === "favorites") await this.reloadFavorites();
    if (this.root) {
      if (tab === "search") this.renderResults();
      else this.render();
    }
  }

  findNode(nodeId) {
    const id = String(nodeId || "");
    if (!id || !Array.isArray(this.nodesCache)) return null;
    return this.nodesCache.find((node) => node.id === id) || null;
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

  async reloadRecommendations({ silent = false } = {}) {
    const bridge = this.bridge;
    const doc = bridge && typeof bridge.getDocument === "function" ? bridge.getDocument() : null;
    if (!doc || typeof doc !== "object") {
      this.view = { ...emptyView(), status: "empty", message: "未检测到 PromptBridge：推荐需要当前 Prompt 数据，其余入口（目录 / 搜索 / 收藏）不受影响。" };
      return;
    }
    if (!silent) this.view = { ...emptyView(), status: "loading" };
    const target = typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "base";
    const payload = buildRecommendPayload(doc, target, this.nodeId, this.limit);
    const selected = selectedTagKeys(doc);
    try {
      const data = await this.api("/api/recommendations", { method: "POST", body: JSON.stringify(payload) });
      const recs = filterSelected(data.recommendations || [], selected);
      const groups = groupRecommendations(recs);
      const activeNode = this.findNode(this.nodeId);
      const fallback = recommendFallback(activeNode);
      this.view = {
        ...emptyView(),
        status: groups.length ? "ok" : (fallback.length ? "ok" : "empty"),
        groups: groups.length ? groups : (fallback.length ? [{ section: "node_seed", label: "节点种子（词库真实标签）", items: fallback }] : []),
        seedFallback: !groups.length && fallback.length > 0,
        targetLabel: TARGET_LABELS[mapBackendTarget(target)] || target,
        nodeLabel: activeNode ? (activeNode.label || this.nodeId) : "",
        message: (!groups.length && !fallback.length)
          ? "暂无推荐：继续添加标签后会自动刷新；或从「目录」选择一个创作意图节点（如 Indoor → bedroom）。"
          : "",
      };
    } catch (error) {
      this.view = { ...emptyView(), status: "error", error: String(error?.message || error) };
    }
  }

  async reloadCatalog() {
    this.view = { ...emptyView(), status: "loading" };
    try {
      const data = await this.api("/api/catalog/semantic");
      const groups = flattenSemanticTree(data.tree || {});
      this.nodesCache = groups.flatMap((group) => group.nodes);
      this.view = {
        ...emptyView(),
        status: groups.length ? "ok" : "empty",
        nodes: groups,
        activeNode: this.findNode(this.nodeId),
        nodeLabel: this.findNode(this.nodeId)?.label || "",
        message: groups.length ? "" : "语义导航骨架未配置（/api/catalog/semantic 无数据）。",
      };
    } catch (error) {
      this.view = { ...emptyView(), status: "error", error: String(error?.message || error) };
    }
  }

  async selectNode(nodeId) {
    this.nodeId = String(nodeId || "");
    const node = this.findNode(this.nodeId);
    const base = { ...emptyView(), nodes: this.view.nodes, activeNode: node, nodeLabel: node ? node.label : this.nodeId };
    const bridge = this.bridge;
    const doc = bridge && typeof bridge.getDocument === "function" ? bridge.getDocument() : null;
    if (!doc || typeof doc !== "object") {
      this.view = { ...base, status: "empty", message: "未检测到 PromptBridge：该节点的推荐需要当前 Prompt 数据。" };
      if (this.root) this.render();
      return;
    }
    this.view = { ...base, status: "loading" };
    if (this.root) this.render();
    const target = typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "base";
    const payload = buildRecommendPayload(doc, target, this.nodeId, this.limit);
    try {
      const data = await this.api("/api/recommendations", { method: "POST", body: JSON.stringify(payload) });
      const recs = filterSelected(data.recommendations || [], selectedTagKeys(doc));
      const groups = groupRecommendations(recs);
      const fallback = recommendFallback(node);
      this.view = {
        ...base,
        status: groups.length || fallback.length ? "ok" : "empty",
        groups: groups.length ? groups : (fallback.length ? [{ section: "node_seed", label: "节点种子（词库真实标签）", items: fallback }] : []),
        seedFallback: !groups.length && fallback.length > 0,
        targetLabel: TARGET_LABELS[mapBackendTarget(target)] || target,
        message: (!groups.length && !fallback.length) ? "该节点暂无可用推荐标签。" : "",
      };
      if (this.root) this.render();
    } catch (error) {
      this.view = { ...base, status: "error", error: String(error?.message || error) };
      if (this.root) this.render();
    }
  }

  async reloadSearch() {
    const q = String(this.searchQuery || "").trim();
    if (!q) {
      this.view = { ...emptyView(), status: "idle", query: q, message: "输入英文 / 中文 / 拼音 / 别名搜索（复用 /api/search）。" };
      return;
    }
    const seq = ++this._searchSeq;
    this.view = { ...emptyView(), status: "loading", query: q };
    try {
      const data = await this.api(`/api/search?q=${encodeURIComponent(q)}&limit=${this.limit}`);
      if (seq !== this._searchSeq) return;
      const cards = toCards(data.results);
      this.view = { ...emptyView(), status: cards.length ? "ok" : "empty", query: q, cards, message: cards.length ? "" : `未找到与「${q}」匹配的标签。` };
    } catch (error) {
      if (seq !== this._searchSeq) return;
      this.view = { ...emptyView(), status: "error", query: q, error: String(error?.message || error) };
    }
  }

  async reloadFavorites() {
    this.view = { ...emptyView(), status: "loading" };
    try {
      const data = await this.api("/api/favorites");
      const cards = toCards(data.favorites);
      this.view = { ...emptyView(), status: cards.length ? "ok" : "empty", cards, message: cards.length ? "" : "还没有收藏标签。" };
    } catch (error) {
      this.view = { ...emptyView(), status: "error", error: String(error?.message || error) };
    }
  }

  // 点击 + ：dispatch ADD_TAG 到 active target（无桥时返回 false，由 UI 提示）。
  addTag(tag, section = "") {
    const bridge = this.bridge;
    const target = bridge && typeof bridge.getActiveTarget === "function" ? bridge.getActiveTarget() : "";
    return dispatchAddTag(bridge, buildAddTagAction(tag, { target, section }));
  }

  // ---- 事件委托（root 单监听器）+ 基础键盘可用性 ----
  handleClick(event) {
    const node = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-action]") : null;
    if (!node) return;
    const action = node.dataset.action;
    if (action === "tab") this.setTab(node.dataset.tab);
    else if (action === "retry") {
      if (this.tab === "search") this.reloadSearch().then(() => this.renderResults());
      else this.reload(this.tab);
    } else if (action === "node") this.selectNode(node.dataset.node);
    else if (action === "add") {
      const ok = this.addTag(node.dataset.tag, node.dataset.section || "");
      if (!ok && this.root) {
        const status = this.root.querySelector(".ta-status");
        if (status) status.textContent = "未连接 PromptBridge，无法加入标签。";
      }
    } else if (action === "search") {
      const input = this.root && this.root.querySelector(".ta-search-input");
      if (input) this.searchQuery = input.value;
      this._searchRefresh.cancel();
      this.reloadSearch().then(() => this.renderResults());
    } else if (action === "clear") {
      this.searchQuery = "";
      this._searchRefresh.cancel();
      this.reloadSearch().then(() => this.renderResults());
    }
  }

  handleKeydown(event) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const tabBtn = event.target && typeof event.target.closest === "function" ? event.target.closest('[role="tab"]') : null;
      if (tabBtn && this.root) {
        const tabs = Array.from(this.root.querySelectorAll('[role="tab"][data-tab]'));
        const idx = tabs.indexOf(tabBtn);
        if (idx >= 0) {
          event.preventDefault();
          const next = tabs[(idx + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          this.setTab(next.dataset.tab);
          const focused = this.root.querySelector(`[role="tab"][data-tab="${next.dataset.tab}"]`);
          if (focused) focused.focus();
        }
      }
    } else if (event.key === "Escape" && this.tab === "search" && this.searchQuery) {
      this.searchQuery = "";
      this._searchRefresh.cancel();
      this.reloadSearch().then(() => this.renderResults());
    }
  }

  bindSearchInput() {
    const input = this.root && this.root.querySelector(".ta-search-input");
    if (!input) return;
    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      this._searchRefresh();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.searchQuery = input.value;
        this._searchRefresh.cancel();
        this.reloadSearch().then(() => this.renderResults());
      }
    });
  }

  // ---- 渲染 ----
  render() {
    if (!this.root) return;
    this.root.innerHTML = `
      <div class="tag-assistant" role="region" aria-label="标签助手">
        <div class="ta-tabs" role="tablist" aria-label="标签助手入口">
          ${TAB_ORDER.map((key) => `
            <button type="button" role="tab" data-action="tab" data-tab="${key}"
              id="ta-tab-${key}" aria-controls="ta-panel" aria-selected="${this.tab === key}"
              class="${this.tab === key ? "active" : ""}">${esc(TAB_LABELS[key])}</button>`).join("")}
        </div>
        <div class="ta-panel" id="ta-panel" role="tabpanel" aria-labelledby="ta-tab-${this.tab}">
          ${this.renderPanel()}
        </div>
      </div>`;
    if (this.tab === "search") this.bindSearchInput();
  }

  renderPanel() {
    if (this.tab === "catalog") return this.renderCatalog();
    if (this.tab === "search") return this.renderSearch();
    if (this.tab === "favorites") return this.renderFavorites();
    return this.renderRecommend();
  }

  statusHtml(status, message = "") {
    if (status === "error") {
      return `<div class="ta-status ta-error" role="alert">${esc(this.view.error || "")}<button type="button" class="ta-retry" data-action="retry">重试</button></div>`;
    }
    if (status === "loading") return `<div class="ta-status ta-loading" aria-live="polite">加载中…</div>`;
    if (status === "empty") return `<div class="ta-status ta-empty" aria-live="polite">${esc(message || this.view.message || "暂无内容")}</div>`;
    if (status === "idle") return `<div class="ta-status ta-hint">${esc(message || this.view.message || "")}</div>`;
    return "";
  }

  cardHtml(card) {
    const heat = card.postCount ? abbreviateCount(card.postCount) : "";
    const meta = [card.reason || card.matchReason, card.source && card.source.length ? card.source.join("+") : ""].filter(Boolean).join(" · ");
    return `<div class="ta-card">
      <button type="button" class="ta-add" data-action="add" data-tag="${esc(card.tag)}" data-section="${esc(card.section || "")}"
        title="加入「${esc(card.tag)}」到当前目标" aria-label="加入 ${esc(card.tag)}">+</button>
      <div class="ta-card-en" title="${esc(card.tag)}">${esc(card.tag)}</div>
      ${card.zh ? `<div class="ta-card-zh">${esc(card.zh)}</div>` : ""}
      ${heat ? `<div class="ta-card-heat" title="热度 ${esc(String(card.postCount))}">${esc(heat)}</div>` : ""}
      ${meta ? `<div class="ta-card-meta">${esc(meta)}</div>` : ""}
    </div>`;
  }

  cardsHtml(cards) {
    if (!cards || !cards.length) return "";
    return `<div class="ta-cards">${cards.map((card) => this.cardHtml(card)).join("")}</div>`;
  }

  groupedHtml(groups) {
    if (!groups || !groups.length) return "";
    return `<div class="ta-groups">${groups.map((group) => `
      <div class="ta-group">
        <div class="ta-group-title">${esc(group.label)}</div>
        ${this.cardsHtml(group.items)}
      </div>`).join("")}</div>`;
  }

  renderRecommend() {
    const v = this.view;
    const contextBits = [];
    if (v.targetLabel) contextBits.push(`目标：${v.targetLabel}`);
    if (v.nodeLabel) contextBits.push(`意图：${v.nodeLabel}`);
    const ctx = contextBits.length ? `<div class="ta-context">${esc(contextBits.join(" · "))}</div>` : "";
    if (v.status === "error") return ctx + this.statusHtml("error");
    if (v.status === "loading") return ctx + this.statusHtml("loading");
    if (v.status === "empty") return ctx + this.statusHtml("empty");
    return ctx + this.groupedHtml(v.groups);
  }

  renderCatalog() {
    const v = this.view;
    if (v.status === "error" && !v.nodes.length) return this.statusHtml("error");
    if (v.status === "loading" && !v.nodes.length) return this.statusHtml("loading");
    if (v.status === "empty" && !v.nodes.length) return this.statusHtml("empty");
    const skeleton = v.nodes.map((group) => `
      <div class="ta-nav-group">
        <div class="ta-nav-group-title">${esc(group.label)}</div>
        <div class="ta-nav-nodes">
          ${group.nodes.map((n) => `
            <button type="button" class="ta-node ${n.id === this.nodeId ? "active" : ""}" data-action="node" data-node="${esc(n.id)}"
              style="padding-left:${10 + n.depth * 12}px" title="${n.zh ? esc(n.zh) : ""}"
              aria-pressed="${n.id === this.nodeId}">
              ${esc(n.label)}${n.seedTags.length ? ` <small class="ta-node-seed-count">${n.seedTags.length}</small>` : ""}
            </button>`).join("")}
        </div>
      </div>`).join("");
    const rec = v.activeNode
      ? `<div class="ta-node-recommend">
          <div class="ta-node-recommend-title">「${esc(v.nodeLabel)}」推荐标签</div>
          ${v.status === "error" ? this.statusHtml("error") : ""}
          ${v.status === "loading" ? this.statusHtml("loading") : ""}
          ${v.status === "empty" ? this.statusHtml("empty") : ""}
          ${v.status === "ok" ? this.groupedHtml(v.groups) : ""}
        </div>`
      : `<div class="ta-status ta-hint">点击上方创作意图节点（如 Indoor → bedroom / cafe），查看该节点的推荐标签，不展开全量标签树。</div>`;
    return skeleton + rec;
  }

  renderSearch() {
    const v = this.view;
    const status = v.status === "error" ? this.statusHtml("error")
      : v.status === "loading" && !v.cards.length ? this.statusHtml("loading")
        : v.status === "empty" ? this.statusHtml("empty")
          : v.status === "idle" ? this.statusHtml("idle")
            : "";
    return `
      <div class="ta-search-bar">
        <input class="ta-search-input" type="search" value="${esc(v.query || "")}"
          placeholder="英文 / 中文 / 拼音 / 别名…" aria-label="搜索标签（支持英文、中文、拼音与别名）" />
        <button type="button" class="ta-search-go" data-action="search" aria-label="立即搜索">搜索</button>
        <button type="button" class="ta-search-clear" data-action="clear" aria-label="清空搜索" title="清空">×</button>
      </div>
      <div data-ta-results>${status}${this.cardsHtml(v.cards)}</div>`;
  }

  renderFavorites() {
    const v = this.view;
    if (v.status === "error") return this.statusHtml("error");
    if (v.status === "loading") return this.statusHtml("loading");
    if (v.status === "empty") return this.statusHtml("empty");
    return this.cardsHtml(v.cards);
  }

  // 搜索/收藏的局部刷新（不重建输入框，避免输入失焦）。
  renderResults() {
    if (!this.root) return;
    const box = this.root.querySelector("[data-ta-results]");
    if (!box) return;
    const v = this.view;
    const status = v.status === "error" ? this.statusHtml("error")
      : v.status === "loading" && !v.cards.length ? this.statusHtml("loading")
        : v.status === "empty" ? this.statusHtml("empty")
          : v.status === "idle" ? this.statusHtml("idle")
            : "";
    box.innerHTML = status + this.cardsHtml(v.cards);
  }
}

export function createTagAssistant(options) {
  return new TagAssistant(options);
}

export default createTagAssistant;