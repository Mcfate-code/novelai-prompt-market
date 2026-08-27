"use strict";

import { getTargetEntries, recommendationContextTags } from "./prompt-document.js";

export const WEIGHT_STEP = 0.05;
export const MIN_WEIGHT = 0.10;
export const MAX_WEIGHT = 2.00;
export const STATUS_SYMBOLS = { filled: "✓", filled_by_auto_preset: "✓", partial: "◐", empty: "○" };
export const NAV_SLOT_MAP = {
  char_appearance: ["char_hair", "char_eyes", "char_face", "char_body"],
  char_clothing: ["char_clothing", "char_clothing_accessory"],
  char_clothing_outfit: ["char_clothing"],
  base_environment: ["env_indoor", "env_outdoor", "base_lighting", "base_time_weather", "base_objects"],
};

const BASE_SYNTHETIC = {
  base_subject_count: { id: "base_subject_count", label: "Subject / Count", zh: "主体/人数", target: "base", section: "character", children: [] },
  quality: { id: "quality", label: "Quality", zh: "画质", target: "base", section: "quality", children: [], displayOnly: true },
};
const BASE_ORDER = ["base_subject_count", "base_environment", "base_composition", "base_lighting", "base_time_weather", "base_objects", "base_style", "quality"];
const CHARACTER_ORDER = ["char_identity", "char_appearance", "char_clothing", "char_expression", "char_pose", "char_action"];
const BASE_SLOT_IDS = new Set(["base_subject_count", "env_indoor", "env_outdoor", "base_composition", "base_lighting", "base_time_weather", "base_objects", "base_style", "quality"]);
const CHARACTER_SLOT_IDS = new Set(["char_identity", "char_hair", "char_eyes", "char_face", "char_body", "char_clothing", "char_clothing_accessory", "char_expression", "char_pose", "char_action"]);
const COMPLETE = new Set(["filled", "filled_by_auto_preset"]);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function normalizeTag(value) { return String(value ?? "").trim().toLocaleLowerCase().replaceAll("_", " ").replace(/\s+/g, " "); }
export function formatWeight(value) { const n = Number(value); return (Number.isFinite(n) ? clampWeight(n) : 1).toFixed(2); }
export function trimWeight(value) { return formatWeight(value); }
export function chipLabel(entry) { const tag = String(entry?.tag ?? "").trim(); return tag ? `${tag} · ${formatWeight(entry?.weight ?? 1)}` : ""; }
export function clampWeight(value) { const n = Number(value); return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Number.isFinite(n) ? Math.round(n * 100) / 100 : 1)); }
export function adjustWeight(weight, delta = 0) { return clampWeight(Number(weight) + Number(delta)); }
export function workspaceForTarget(target) { const value = String(target || ""); if (value === "base") return "base"; const match = value.match(/^char:(\d+)$/); return match ? `char:${match[1]}` : ""; }
export function workspaceTabs(doc) { return [{ key: "base", label: "Base", index: null }, ...(doc?.characters || []).map((character, index) => ({ key: `char:${index}`, label: targetLabel(doc, `char:${index}`), index }))]; }
export function targetLabel(doc, target) { const match = String(target).match(/^char:(\d+)$/); if (!match) return "Base"; const index = Number(match[1]); const identity = String(doc?.characters?.[index]?.name || "").trim(); const generic = `Character ${index + 1}`; return identity && identity !== generic ? `${generic} · ${identity}` : generic; }
export function normalizeSemanticNode(node) { if (!node?.id) return null; return { id: String(node.id), label: String(node.label ?? node.id), zh: String(node.zh ?? ""), section: String(node.section ?? "other"), target: String(node.target ?? ""), displayOnly: !!node.displayOnly, children: Array.isArray(node.children) ? node.children.map(normalizeSemanticNode).filter(Boolean) : [] }; }

export function semanticCards(tree, workspaceKey) {
  const isCharacter = String(workspaceKey).startsWith("char:");
  const children = (isCharacter ? (tree?.character?.children || []) : (tree?.base?.children || [])).map(normalizeSemanticNode).filter(Boolean);
  const clothing = children.find((node) => node.id === "char_clothing");
  if (clothing && !clothing.children.some((node) => node.id === "char_clothing_outfit")) clothing.children.unshift(normalizeSemanticNode({ id: "char_clothing_outfit", label: "Outfit", zh: "服装主体", target: "character", section: "clothing", children: [] }));
  const byId = new Map(children.map((node) => [node.id, node]));
  if (!isCharacter) Object.entries(BASE_SYNTHETIC).forEach(([id, node]) => { if (!byId.has(id)) byId.set(id, normalizeSemanticNode(node)); });
  return (isCharacter ? CHARACTER_ORDER : BASE_ORDER).map((id) => byId.get(id)).filter(Boolean);
}

export function slotsForTarget(state, target) {
  if (target === "base") return (Array.isArray(state?.base_slots) ? state.base_slots : []).filter((slot) => BASE_SLOT_IDS.has(String(slot.node_id)));
  const match = String(target).match(/^char:(\d+)$/);
  return match && Array.isArray(state?.character_slots?.[Number(match[1])]) ? state.character_slots[Number(match[1])].filter((slot) => CHARACTER_SLOT_IDS.has(String(slot.node_id))) : [];
}
export function slotMapForTarget(state, target) { return new Map(slotsForTarget(state, target).map((slot) => [String(slot.node_id), slot])); }
export function mappedSlotIds(node, slotMap) {
  const explicit = NAV_SLOT_MAP[node?.id];
  if (explicit) return explicit.filter((id) => slotMap.has(id));
  if (slotMap.has(node?.id)) return [node.id];
  const descendants = [];
  for (const child of node?.children || []) descendants.push(...mappedSlotIds(child, slotMap));
  return [...new Set(descendants)];
}
export function aggregateStatus(statuses) {
  const values = (statuses || []).filter(Boolean);
  if (!values.length) return "empty";
  if (values.every((status) => COMPLETE.has(status))) return "filled";
  if (values.some((status) => status === "partial" || COMPLETE.has(status))) return "partial";
  return "empty";
}
export function nodeStatus(node, slotMap) { return aggregateStatus(mappedSlotIds(node, slotMap).map((id) => slotMap.get(id)?.status)); }
export function completionForSlots(slots) { return { complete: (slots || []).filter((slot) => COMPLETE.has(slot.status)).length, partial: (slots || []).filter((slot) => slot.status === "partial").length, total: (slots || []).length }; }
export function inspectorSelectedEntries(entries, slot) {
  if (!slot) return [];
  const evidence = new Set((slot.evidence_tags || []).map(normalizeTag).filter(Boolean));
  return (entries || []).filter((entry) => evidence.has(normalizeTag(entry.tag)));
}
export function buildAddTagAction(tag, target, section = "") { const payload = { tag: String(tag || ""), target: String(target || "") }; if (section) payload.section = section; return { type: "ADD_TAG", payload }; }
export function buildRemoveTagAction(target, entryId) { return { type: "REMOVE_TAG", payload: { target: String(target), entryId: String(entryId) } }; }
export function buildSetWeightAction(target, entryId, weight) { return { type: "SET_WEIGHT", payload: { target: String(target), entryId: String(entryId), weight: clampWeight(weight) } }; }
export function dispatchAction(bridge, action) { if (typeof bridge?.dispatch !== "function") return false; try { bridge.dispatch(action); return true; } catch { return false; } }

function recommendationItems(value) { return Array.isArray(value) ? value : Array.isArray(value?.recommendations) ? value.recommendations : []; }
export function recommendationGroups(data, nodeId, selectedEntries = []) {
  const selected = new Set(selectedEntries.map((entry) => normalizeTag(entry.tag)));
  const flat = recommendationItems(data?.recommendations).filter((item) => String(item?.slot || "") === nodeId);
  const exactFallback = recommendationItems(data?.current_node).filter((item) => !item?.slot || String(item.slot) === nodeId);
  const current = (flat.length ? flat : exactFallback).filter((item) => item?.tag && !selected.has(normalizeTag(item.tag)));
  const nextSteps = Array.isArray(data?.next_steps) ? data.next_steps : [];
  return { current, nextSteps };
}

export class VisualBuilder {
  constructor(options = {}) {
    this.root = options.root || null;
    this.apiBase = String(options.apiBase || "");
    this.bridge = options.bridge || globalThis.window?.PromptBridge;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.getGenerationConfig = typeof options.getGenerationConfig === "function" ? options.getGenerationConfig : () => ({ positiveTier: "off" });
    this.getMode = typeof options.getMode === "function" ? options.getMode : () => "general";
    this.view = { status: this.bridge?.getDocument ? "loading" : "empty", message: this.bridge?.getDocument ? "" : "PromptBridge unavailable", error: "", tree: null, semanticState: null, target: this.activeTarget(), path: [], selectedNodeId: "", recommendationStatus: "idle", recommendationError: "", recommendationData: null };
    this._semanticSeq = 0; this._treeSeq = 0; this._recommendationSeq = 0; this._unsubscribe = null; this._lastAddedTag = "";
    this.onClick = (event) => this.handleClick(event); this.onChange = (event) => this.handleChange(event); this.onKeydown = (event) => this.handleKeydown(event);
  }
  mount() {
    if (this.root) { this.root.addEventListener("click", this.onClick); this.root.addEventListener("change", this.onChange); this.root.addEventListener("keydown", this.onKeydown); this.render(); }
    this._unsubscribe = this.bridge?.subscribe?.((_doc, action) => this.onBridgeChange(action));
    void this.reload();
  }
  destroy() { this._semanticSeq += 1; this._treeSeq += 1; this._recommendationSeq += 1; this._unsubscribe?.(); this.root?.removeEventListener("click", this.onClick); this.root?.removeEventListener("change", this.onChange); this.root?.removeEventListener("keydown", this.onKeydown); }
  activeTarget() { const target = this.bridge?.getActiveTarget?.() || "base"; return workspaceForTarget(target) || "base"; }
  async api(path, options = {}) { const response = await this.fetchImpl(`${this.apiBase}${path}`, { headers: { "Content-Type": "application/json" }, ...options }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`); return response.json(); }
  async reload() { await Promise.all([this.reloadTree(), this.refreshSemantic()]); }
  async reloadTree() {
    const seq = ++this._treeSeq; const target = this.activeTarget(); const selectedNodeId = this.view.selectedNodeId;
    try {
      const data = await this.api("/api/catalog/semantic");
      if (seq !== this._treeSeq || target !== this.activeTarget() || selectedNodeId !== this.view.selectedNodeId) return false;
      this.view.tree = data?.tree || data; if (this.view.semanticState) this.view.status = "ok"; this.view.error = ""; this.render(); return true;
    } catch (error) {
      if (seq !== this._treeSeq || target !== this.activeTarget() || selectedNodeId !== this.view.selectedNodeId) return false;
      this.view.status = "error"; this.view.error = String(error?.message || error); this.render(); return false;
    }
  }
  onBridgeChange(action) {
    if (action?.type === "ADD_TAG") this._lastAddedTag = String(action.payload?.tag || "");
    const target = this.activeTarget();
    if (target !== this.view.target) { this.resetForTarget(target); if (!this.view.tree) void this.reloadTree(); }
    void this.refreshSemantic();
  }
  resetForTarget(target) {
    this._semanticSeq += 1; this._treeSeq += 1; this._recommendationSeq += 1;
    this.view = { ...this.view, target, semanticState: null, path: [], selectedNodeId: "", recommendationStatus: "idle", recommendationError: "", recommendationData: null, status: "loading", error: "" };
    this.render();
  }
  async refreshSemantic() {
    const doc = this.bridge?.getDocument?.();
    if (!doc || typeof doc !== "object") { this.view.status = "empty"; this.view.message = "PromptBridge did not provide a PromptDocument"; this.render(); return false; }
    const target = this.activeTarget(); if (target !== this.view.target) this.resetForTarget(target);
    const seq = ++this._semanticSeq; const selectedNodeId = this.view.selectedNodeId; const generationConfig = { ...(this.getGenerationConfig() || {}) };
    if (!this.view.semanticState) this.view.status = "loading"; this.view.error = ""; this.render();
    try {
      const state = await this.api("/api/semantic-state", { method: "POST", body: JSON.stringify({ structured_state: doc, active_target: target, mode: this.getMode() || "general", generation_config: generationConfig, last_added_tag: this._lastAddedTag }) });
      if (seq !== this._semanticSeq || target !== this.activeTarget() || selectedNodeId !== this.view.selectedNodeId) return false;
      this.view.semanticState = state; this.view.status = this.view.tree ? "ok" : (this.view.status === "error" ? "error" : "loading"); if (this.view.tree) this.view.error = "";
      if (this.view.selectedNodeId && !this.concreteSlot(this.view.selectedNodeId)) this.resetInspector();
      const selectedNodeId = this.view.selectedNodeId; this.render(); if (selectedNodeId) void this.selectNode(selectedNodeId); return true;
    } catch (error) {
      if (seq !== this._semanticSeq || target !== this.activeTarget() || selectedNodeId !== this.view.selectedNodeId) return false;
      this.view.status = "error"; this.view.error = String(error?.message || error); this.render(); return false;
    }
  }
  nodeList() { return semanticCards(this.view.tree || {}, this.view.target); }
  findNode(id, nodes = this.nodeList(), path = []) { for (const node of nodes) { const next = [...path, node]; if (node.id === id) return { node, path: next }; const found = this.findNode(id, node.children, next); if (found) return found; } return null; }
  slotMap() { return slotMapForTarget(this.view.semanticState, this.view.target); }
  concreteSlot(id) { const found = this.findNode(id); if (!found || found.node.children.length || found.node.displayOnly) return null; const ids = mappedSlotIds(found.node, this.slotMap()); return ids.length === 1 ? this.slotMap().get(ids[0]) || null : null; }
  resetInspector() { this._recommendationSeq += 1; this.view.selectedNodeId = ""; this.view.recommendationStatus = "idle"; this.view.recommendationError = ""; this.view.recommendationData = null; }
  drillTo(id) { const found = this.findNode(id); if (!found) return false; this.resetInspector(); this.view.path = found.path; this.render(); return true; }
  navigateTo(depth) { this.resetInspector(); this.view.path = this.view.path.slice(0, Math.max(0, Number(depth))); this.render(); }
  async selectNode(id) {
    const found = this.findNode(id); if (!found) return false;
    if (found.node.children.length || found.node.displayOnly || !this.concreteSlot(id)) return this.drillTo(id);
    this.view.path = found.path; this.view.selectedNodeId = id; this.view.recommendationStatus = "loading"; this.view.recommendationError = ""; this.view.recommendationData = null; this.render();
    const seq = ++this._recommendationSeq; const target = this.activeTarget(); const doc = this.bridge.getDocument(); const ctx = doc?.assistant_context || {}; const generationConfig = { ...(this.getGenerationConfig() || {}) };
    const payload = { tags: recommendationContextTags(doc, target), target: target === "base" ? "base" : "character", active_target: target, active_section: found.node.section, node_id: id, semantic_node: id, assistant_context: ctx, participant_count: ctx.participant_count, primary_scene_type: ctx.primary_scene_type ?? "", stage: ctx.stage ?? "", position: ctx.position ?? "", body_focus: ctx.body_focus ?? "", additional_activities: ctx.additional_activities || [], clothing_state: ctx.clothing_state || {}, last_added_tag: this._lastAddedTag, structured_state: doc, generation_config: generationConfig, limit: 20 };
    try {
      const data = await this.api("/api/recommendations", { method: "POST", body: JSON.stringify(payload) });
      if (seq !== this._recommendationSeq || target !== this.activeTarget() || id !== this.view.selectedNodeId) return false;
      this.view.recommendationData = data; this.view.recommendationStatus = "ok"; this.render(); return true;
    } catch (error) {
      if (seq !== this._recommendationSeq || target !== this.activeTarget() || id !== this.view.selectedNodeId) return false;
      this.view.recommendationStatus = "error"; this.view.recommendationError = String(error?.message || error); this.render(); return false;
    }
  }
  addTag(tag, section = "") { return dispatchAction(this.bridge, buildAddTagAction(tag, this.activeTarget(), section)); }
  removeChip(target, entryId) { return dispatchAction(this.bridge, buildRemoveTagAction(target, entryId)); }
  setChipWeight(target, entryId, weight) { return dispatchAction(this.bridge, buildSetWeightAction(target, entryId, weight)); }
  handleClick(event) {
    const element = event.target.closest?.("[data-action]"); if (!element) return;
    const action = element.dataset.action;
    if (action === "node") void this.selectNode(element.dataset.node);
    else if (action === "crumb") this.navigateTo(element.dataset.depth);
    else if (action === "retry-semantic") void this.reload();
    else if (action === "retry-recommendation") void this.selectNode(this.view.selectedNodeId);
    else if (action === "add") this.addTag(element.dataset.tag, element.dataset.section);
    else if (action === "remove") this.removeChip(element.dataset.target, element.dataset.entryId);
    else if (action === "weight-dec" || action === "weight-inc") this.setChipWeight(element.dataset.target, element.dataset.entryId, adjustWeight(element.dataset.weight, action === "weight-dec" ? -WEIGHT_STEP : WEIGHT_STEP));
  }
  handleChange(event) { const input = event.target.closest?.('[data-action="weight-input"]'); if (input) this.commitWeightInput(input); }
  handleKeydown(event) { const input = event.target.closest?.('[data-action="weight-input"]'); if (input && event.key === "Enter") { event.preventDefault?.(); this.commitWeightInput(input); } }
  commitWeightInput(input) { const weight = clampWeight(input.value); input.value = formatWeight(weight); return this.setChipWeight(input.dataset.target, input.dataset.entryId, weight); }
  replaceHtml(html) {
    const active = this.root?.ownerDocument?.activeElement; const entryId = active?.dataset?.entryId; const action = active?.dataset?.action; const start = active?.selectionStart; const end = active?.selectionEnd;
    this.root.innerHTML = html;
    if (!entryId || !action) return;
    const selector = `[data-action="${globalThis.CSS?.escape ? globalThis.CSS.escape(action) : action}"][data-entry-id="${globalThis.CSS?.escape ? globalThis.CSS.escape(entryId) : entryId}"]`;
    const restored = this.root.querySelector?.(selector); restored?.focus?.({ preventScroll: true }); if (Number.isInteger(start) && restored?.setSelectionRange) restored.setSelectionRange(start, end);
  }
  render() {
    if (!this.root) return;
    if (this.view.status === "empty") { this.replaceHtml(`<div class="composer-error"><strong>${esc(this.view.message)}</strong></div>`); return; }
    if (this.view.status === "error") { this.replaceHtml(`<div class="composer-error" role="alert"><strong>语义目录加载失败</strong><span>${esc(this.view.error)}</span><button type="button" data-action="retry-semantic">Retry</button></div>`); return; }
    const doc = this.bridge.getDocument(); const target = this.view.target; const label = targetLabel(doc, target); const slots = slotsForTarget(this.view.semanticState, target); const completion = completionForSlots(slots); const slotMap = this.slotMap();
    const currentNode = this.view.path.at(-1); const currentParent = currentNode?.children?.length ? currentNode : this.view.path.at(-2); const cards = currentParent?.children?.length ? currentParent.children : this.nodeList();
    const cardsHtml = cards.map((node) => { const status = nodeStatus(node, slotMap); const ids = mappedSlotIds(node, slotMap); const evidence = ids.flatMap((id) => slotMap.get(id)?.evidence_tags || []); const auto = ids.some((id) => slotMap.get(id)?.status === "filled_by_auto_preset"); const detail = auto ? `由 ${this.getGenerationConfig()?.positiveTier === "light" ? "Light" : "Standard"} 自动提供` : evidence.slice(0, 3).join(", ") || node.zh || "尚未设置"; return `<button type="button" class="semantic-node status-${esc(status)}" data-action="node" data-node="${esc(node.id)}" aria-label="${esc(node.label)}，${esc(status)}"><span class="status-symbol" aria-hidden="true">${STATUS_SYMBOLS[status]}</span><strong>${esc(node.label)}</strong><small>${esc(detail)}</small>${node.children.length ? '<span class="drill-hint">查看子项 ›</span>' : ""}</button>`; }).join("");
    const crumbs = [`<button type="button" data-action="crumb" data-depth="0">${esc(label)}</button>`, ...this.view.path.map((node, index) => `<span aria-hidden="true">›</span><button type="button" data-action="crumb" data-depth="${index + 1}">${esc(node.label)}</button>`)].join("");
    const next = slots.filter((slot) => slot.status === "empty" || slot.status === "partial").slice(0, 5).map((slot) => `<li><strong>${esc(slot.label)}</strong><span>${esc(slot.reason || "尚未设置")}</span></li>`).join("");
    const inspector = this.renderInspector(doc, label);
    this.replaceHtml(`<section class="semantic-composer" aria-busy="${this.view.status === "loading"}"><header class="completion-header"><div><span>${esc(label)}</span><strong>完成 ${completion.complete} / ${completion.total}</strong>${completion.partial ? `<small>${completion.partial} 项部分完成</small>` : ""}</div><div class="completion-track"><i style="width:${completion.total ? Math.round(completion.complete / completion.total * 100) : 0}%"></i></div></header><nav class="composer-breadcrumb" aria-label="语义路径">${crumbs}</nav><main><div class="semantic-grid">${cardsHtml}</div><section class="next-steps"><h3>建议下一步</h3><ul>${next || "<li>当前目标已完成</li>"}</ul></section></main>${inspector}</section>`);
  }
  renderInspector(doc, label) {
    const slot = this.concreteSlot(this.view.selectedNodeId); if (!slot) return "";
    const node = this.findNode(this.view.selectedNodeId)?.node; const entries = inspectorSelectedEntries(getTargetEntries(doc, this.view.target), slot);
    const selected = entries.map((entry) => `<div class="composer-chip"><span>${esc(entry.tag)}</span><div class="weight-control"><button type="button" data-action="weight-dec" data-target="${esc(this.view.target)}" data-entry-id="${esc(entry.id)}" data-weight="${formatWeight(entry.weight)}" aria-label="降低 ${esc(entry.tag)} 权重">−</button><input type="number" min="0.10" max="2.00" step="0.05" value="${formatWeight(entry.weight)}" data-action="weight-input" data-target="${esc(this.view.target)}" data-entry-id="${esc(entry.id)}" aria-label="${esc(entry.tag)} 权重"/><button type="button" data-action="weight-inc" data-target="${esc(this.view.target)}" data-entry-id="${esc(entry.id)}" data-weight="${formatWeight(entry.weight)}" aria-label="提高 ${esc(entry.tag)} 权重">+</button><button type="button" data-action="remove" data-target="${esc(this.view.target)}" data-entry-id="${esc(entry.id)}" aria-label="删除 ${esc(entry.tag)}">×</button></div></div>`).join("");
    if (this.view.recommendationStatus === "error") return `<aside class="semantic-inspector"><h2>${esc(node?.label || slot.label)}</h2><div class="inspector-error" role="alert"><strong>推荐加载失败</strong><span>${esc(this.view.recommendationError)}</span><button type="button" data-action="retry-recommendation">Retry</button></div></aside>`;
    const groups = recommendationGroups(this.view.recommendationData, String(slot.node_id), entries); const section = node?.section || "other";
    const addButton = (item, fallbackSection = section) => `<button type="button" data-action="add" data-tag="${esc(item.tag)}" data-section="${esc(item.section || fallbackSection)}">+ ${esc(item.tag)} → ${esc(label)}</button>`;
    const current = groups.current.map(addButton).join("");
    const following = groups.nextSteps.map((step) => { const nextSection = this.findNode(step.node_id)?.node?.section || "other"; return `<div class="next-step-recommendation"><strong>${esc(step.label || step.zh || step.node_id)}</strong><span>${esc(step.reason || "")}</span>${recommendationItems(step).filter((item) => item?.tag).map((item) => addButton(item, nextSection)).join("")}</div>`; }).join("");
    return `<aside class="semantic-inspector"><h2>${esc(node?.label || slot.label)}</h2><section><h3>已选</h3><div class="selected-chips">${selected || '<span class="muted">尚未添加证据标签</span>'}</div></section><section><h3>当前节点推荐</h3><div class="recommendations">${this.view.recommendationStatus === "loading" ? '<span class="muted">加载中…</span>' : current || '<span class="muted">暂无新的当前节点推荐</span>'}</div></section><section><h3>下一步建议</h3><div class="recommendations next-recommendations">${following || '<span class="muted">暂无下一步建议</span>'}</div></section></aside>`;
  }
}

export function createVisualBuilder(options) { return new VisualBuilder(options); }
export default createVisualBuilder;
