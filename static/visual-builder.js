"use strict";

import { SECTION_IDS, getTargetEntries, recommendationContextTags } from "./prompt-document.js";

export const SECTION_LABELS = { character: "角色", appearance: "外观", clothing: "服装", expression: "表情", action: "动作", composition: "构图", scene: "场景", style: "风格", quality: "质量", other: "其他" };
export const TARGET_LABELS = { base: "Base", global_uc: "Global UC", character: "Character" };
export const WEIGHT_STEP = 0.05;
export const MIN_WEIGHT = 0.1;
export const QUALITY_FALLBACK_NODE = { id: "base_quality", label: "Quality", zh: "质量", target: "base", section: "quality", seed_tags: ["masterpiece", "best quality", "highres", "absurdres"], children: [] };

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function trimWeight(weight) { const n = Number(weight); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "1"; }
export function chipLabel(entry) { const tag = String(entry?.tag ?? "").trim(); const weight = Number(entry?.weight ?? 1); return !tag ? "" : weight === 1 ? tag : `${tag} · ${trimWeight(weight)}`; }
export function adjustWeight(weight, delta = 0, min = MIN_WEIGHT) { const n = Math.round((Number(weight || 0) + Number(delta || 0)) * 100) / 100; return Math.max(Number(min), Number.isFinite(n) ? n : Number(min)); }
export function workspaceForTarget(target) { const t = String(target || ""); if (t === "base" || t === "global_uc") return "base"; const m = t.match(/^char:(\d+)(:uc)?$/); return m ? `char:${m[1]}` : ""; }
export function workspaceTabs(doc) { return [{ key: "base", label: "Base", index: null }, ...(doc?.characters || []).map((c, i) => ({ key: `char:${i}`, label: String(c?.name || `Character ${i + 1}`), index: i }))]; }
export function groupEntriesBySection(entries, target) { return SECTION_IDS.map((section) => ({ section, label: SECTION_LABELS[section] || section, target, entries: (entries || []).filter((e) => e.section === section && String(e.tag).trim()).map((e) => ({ ...e, target, display: chipLabel(e) })) })).filter((g) => g.entries.length); }
export function buildWorkspaceChips(doc, workspaceKey) { const p = workspaceKey === "base" ? "base" : workspaceKey; const u = workspaceKey === "base" ? "global_uc" : `${workspaceKey}:uc`; if (workspaceKey !== "base" && !doc?.characters?.[Number(workspaceKey.split(":")[1])]) return null; return { prompt: groupEntriesBySection(getTargetEntries(doc, p), p), uc: groupEntriesBySection(getTargetEntries(doc, u), u) }; }
export function normalizeSemanticNode(node) { if (!node?.id) return null; return { id: String(node.id), label: String(node.label ?? node.id), zh: String(node.zh ?? ""), section: String(node.section ?? ""), target: String(node.target ?? ""), seedTags: Array.isArray(node.seed_tags) ? node.seed_tags.map(String) : [], children: Array.isArray(node.children) ? node.children.map(normalizeSemanticNode).filter(Boolean) : [] }; }
export function semanticCards(tree, workspaceKey) { const root = String(workspaceKey).startsWith("char") ? tree?.character : tree?.base; const cards = (root?.children || []).map(normalizeSemanticNode).filter(Boolean); return !String(workspaceKey).startsWith("char") && root && !cards.some((n) => n.section === "quality") ? [...cards, normalizeSemanticNode(QUALITY_FALLBACK_NODE)] : cards; }
export function cardSectionLabel(section) { return SECTION_LABELS[String(section || "")] || ""; }
export function buildAddTagAction(tag, target, section = "", weight) { const payload = { tag: String(tag || ""), target: String(target || "") }; if (section) payload.section = section; if (weight != null) payload.weight = weight; return { type: "ADD_TAG", payload }; }
export function buildRemoveTagAction(target, entryId) { return { type: "REMOVE_TAG", payload: { target: String(target), entryId: String(entryId) } }; }
export function buildSetWeightAction(target, entryId, weight) { return { type: "SET_WEIGHT", payload: { target: String(target), entryId: String(entryId), weight: Number(weight) } }; }
export function buildMoveSectionAction(target, entryId, section) { return { type: "MOVE_SECTION", payload: { target: String(target), entryId: String(entryId), section: String(section) } }; }
export function buildAddCharacterAction(name = "") { return { type: "ADD_CHARACTER", payload: name.trim() ? { name: name.trim() } : {} }; }
export function buildRemoveCharacterAction(index) { return { type: "REMOVE_CHARACTER", payload: { index: Number(index) } }; }
export function buildRenameCharacterAction(index, name) { return { type: "RENAME_CHARACTER", payload: { index: Number(index), name: String(name || "") } }; }
export function dispatchAction(bridge, action) { if (!bridge?.dispatch) return false; try { bridge.dispatch(action); return true; } catch { return false; } }

// Inspector 的「已选」只显示当前节点语义分区（section）内的 tags；
// 未选中节点时返回全部（中性）。点 Eyes(appearance) 不会把 identity/hair/dress 全列出来。
export function inspectorSelectedEntries(entries, node) {
  const scope = node && node.section ? node.section : null;
  return (entries || []).filter((e) => !scope || e.section === scope);
}

export class VisualBuilder {
  constructor(options = {}) { this.root = options.root || null; this.apiBase = String(options.apiBase || ""); this.bridge = options.bridge || globalThis.window?.PromptBridge; this.fetchImpl = options.fetchImpl || globalThis.fetch; this.view = { status: this.bridge?.getDocument ? "ok" : "empty", message: this.bridge?.getDocument ? "" : "PromptBridge unavailable", tree: null, activeNodeId: "", node: null, nodeById: {}, nodeStatus: "", recommendations: [], error: "", cards: [], workspace: workspaceForTarget(this.bridge?.getActiveTarget?.() || "base") }; this._unsubscribe = null; this.onClick = (e) => this.handleClick(e); }
  mount() { if (this.root) { this.root.addEventListener("click", this.onClick); this.render(); } this._unsubscribe = this.bridge?.subscribe?.(() => this.refresh()); this.reloadTree(); }
  destroy() { this._unsubscribe?.(); this.root?.removeEventListener("click", this.onClick); }
  refresh() { const doc = this.bridge?.getDocument?.(); if (!this.bridge?.getDocument || !doc || typeof doc !== "object") { this.view.status = "empty"; this.view.message = "PromptBridge did not provide a PromptDocument"; this.view.cards = []; return; } if (this.view.status !== "error") this.view.status = "ok"; this.view.message = ""; this.view.workspace = workspaceForTarget(this.activeTarget()); this.view.cards = this.nodeList(); if (this.root) this.render(); }
  async api(path, opts = {}) { const res = await this.fetchImpl(`${this.apiBase}${path}`, { headers: { "Content-Type": "application/json" }, ...opts }); if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`); return res.json(); }
  async reloadTree() { try { const data = await this.api("/api/catalog/semantic"); this.view.tree = data?.tree || data; this.view.status = "ok"; this.refresh(); } catch (e) { this.view.status = "error"; this.view.error = String(e.message || e); this.refresh(); } }
  activeTarget() { return this.bridge?.getActiveTarget?.() || "base"; }
  nodeList() { return semanticCards(this.view.tree || {}, this.view.workspace || workspaceForTarget(this.activeTarget())); }
  findNode(id, nodes = this.nodeList()) { for (const node of nodes) { if (node.id === id) return node; const found = this.findNode(id, node.children); if (found) return found; } return null; }
  async selectNode(id) { this.view.activeNodeId = String(id); this.view.nodeStatus = "loading"; this.view.node = this.findNode(id); this.view.recommendations = []; const node = this.view.node; if (!node) return; const doc = this.bridge.getDocument(); const ctx = doc?.assistant_context || {}; const payload = { tags: recommendationContextTags(doc, this.activeTarget()), target: workspaceForTarget(this.activeTarget()) === "base" ? "base" : "character", active_target: this.activeTarget(), active_section: node.section, node_id: node.id, semantic_node: node, assistant_context: ctx, participant_count: ctx.participant_count, primary_scene_type: ctx.primary_scene_type ?? "", stage: ctx.stage ?? "", position: ctx.position ?? "", body_focus: ctx.body_focus ?? "", limit: 20 }; try { const data = await this.api(`/api/catalog/semantic?node_id=${encodeURIComponent(id)}`); const resolved = normalizeSemanticNode(data?.node) || node; const rec = await this.api("/api/recommendations", { method: "POST", body: JSON.stringify({ ...payload, semantic_node: resolved }) }); this.view.nodeById[id] = resolved; this.view.recommendations = Array.isArray(rec?.recommendations) ? rec.recommendations : []; this.view.nodeStatus = "ok"; } catch { this.view.recommendations = []; this.view.nodeStatus = "error"; } if (!this.view.recommendations.length && this.view.nodeStatus !== "error") this.view.recommendations = node.seedTags.map((tag) => ({ tag, section: node.section })); this.refresh(); }
  addTag(tag, section = "") { return dispatchAction(this.bridge, buildAddTagAction(tag, this.activeTarget(), section)); }
  removeChip(target, entryId) { return dispatchAction(this.bridge, buildRemoveTagAction(target, entryId)); }
  setChipWeight(target, entryId, weight) { return dispatchAction(this.bridge, buildSetWeightAction(target, entryId, weight)); }
  moveChipSection(target, entryId, section) { return dispatchAction(this.bridge, buildMoveSectionAction(target, entryId, section)); }
  addCharacter(name = "") { return dispatchAction(this.bridge, buildAddCharacterAction(name)); }
  removeCharacter(index) { return dispatchAction(this.bridge, buildRemoveCharacterAction(index)); }
  renameCharacter(index, name) { return dispatchAction(this.bridge, buildRenameCharacterAction(index, name)); }
  handleClick(event) { const el = event.target.closest?.("[data-action]"); if (!el) return; if (el.dataset.action === "node") this.selectNode(el.dataset.node); else if (el.dataset.action === "add") this.addTag(el.dataset.tag, el.dataset.section); else if (el.dataset.action === "remove") dispatchAction(this.bridge, buildRemoveTagAction(el.dataset.target, el.dataset.entryId)); else if (el.dataset.action === "weight-dec") this.setChipWeight(el.dataset.target, el.dataset.entryId, adjustWeight(Number(el.dataset.weight), -WEIGHT_STEP)); else if (el.dataset.action === "weight-inc") this.setChipWeight(el.dataset.target, el.dataset.entryId, adjustWeight(Number(el.dataset.weight), WEIGHT_STEP)); }
  render() {
    if (!this.root) return;
    const target = this.activeTarget();
    const doc = this.bridge?.getDocument?.();
    const entries = getTargetEntries(doc, target);
    const node = this.view.node;
    const selectedEntries = inspectorSelectedEntries(entries, node);
    const selected = selectedEntries.map((e) => `<span class="composer-chip" data-target="${esc(target)}" data-entry-id="${esc(e.id)}" data-weight="${esc(Number(e.weight ?? 1))}">${esc(chipLabel(e))} <button type="button" data-action="weight-dec" data-target="${esc(target)}" data-entry-id="${esc(e.id)}" data-weight="${esc(Number(e.weight ?? 1))}" aria-label="降低权重">−</button><button type="button" data-action="remove" data-target="${esc(target)}" data-entry-id="${esc(e.id)}" aria-label="删除 ${esc(e.tag)}">×</button></span>`).join("");
    const cards = this.nodeList().map((n) => `<button type="button" class="semantic-node" data-action="node" data-node="${esc(n.id)}"><strong>${esc(n.label)}</strong><small>${entries.filter((e) => e.section === n.section).length} selected</small><span>${entries.filter((e) => e.section === n.section).slice(0, 3).map((e) => esc(e.tag)).join(", ")}</span></button>`).join("");
    const recs = (this.view.recommendations || []).map((r) => `<button type="button" data-action="add" data-tag="${esc(r.tag)}" data-section="${esc(r.section || node?.section || "other")}">+ ${esc(r.tag)}</button>`).join("");
    this.root.innerHTML = `<section class="semantic-composer"><div class="composer-target">${esc(target)}</div><div class="semantic-grid">${cards}</div><aside class="semantic-inspector"><div class="breadcrumb">${esc(node?.label || "Select a semantic node")}</div><div class="selected-chips">${selected || "No selected tags"}</div><div class="recommendations">${recs || "No recommendations"}</div></aside></section>`;
  }
}
export function createVisualBuilder(options) { return new VisualBuilder(options); }
export default createVisualBuilder;
