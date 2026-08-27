"use strict";
import { splitPromptTokens, joinPromptTokens, tokenRangeAtCaret, serializePromptToken } from "./prompt-tokenizer.js";

// ===== 状态 =====
const SECTION_IDS = ["character", "appearance", "clothing", "expression", "action", "composition", "scene", "style", "quality", "other"];
const DEFAULT_OPEN_SECTIONS = new Set(["character", "appearance", "clothing", "action", "composition", "style"]);
const DRAFT_KEY = "novelai_prompt_draft_v2";
const SECTION_LABELS = { character: "角色", appearance: "外观", clothing: "服装", expression: "表情", action: "动作", composition: "构图", scene: "场景", style: "画风", quality: "质量", other: "其他" };

let promptDocument = null;
const promptDocumentReady = import("/static/prompt-document.js").then((module) => { promptDocument = module; return module; });
function emptySections() { return promptDocument.emptySections(); }
function emptyPromptState() { return promptDocument.createEmpty(); }
function normalizeEntry(value, section = "other", extra = {}) { return promptDocument.normalizeEntry(value, section, extra); }
function migratePromptState(raw) { return promptDocument.normalize(raw); }

const state = { model: "v5", target: "base", prompt: null, characters: [], base: [], global_uc: [], free_text: "", categories: [], activeCategory: null, activeDbCat: null, view: "browse", favorites: new Set(), recent: [], models: [], history: [] };
const promptSubscribers = new Set();
function notifyPromptSubscribers(action = null) {
  promptSubscribers.forEach((listener) => { try { listener(state.prompt, action); } catch (error) { console.error("PromptBridge subscriber failed", error); } });
}
function resolveDisplayTarget(target) {
  const value = String(target || "base");
  if (value === "base" || value === "global_uc") return value;
  const match = value.match(/^char:(\d+)(:uc)?$/);
  return match && state.prompt?.characters?.[Number(match[1])] ? value : "base";
}
function resolveMutationTarget(target) {
  const value = String(target || state.target || "base");
  if (value === "base" || value === "global_uc") return value;
  const match = value.match(/^char:(\d+)(:uc)?$/);
  return match && state.prompt?.characters?.[Number(match[1])] ? value : null;
}
const promptBridgeTarget = resolveDisplayTarget;
function dispatchPromptAction(action = {}) {
  if (!promptDocument || !state.prompt) return state.prompt;
  const payload = action.payload || {};
  const target = resolveMutationTarget(payload.target || state.target);
  if (!target) return state.prompt;
  if (action.type === "ADD_TAG" && !String(payload.tag || "").trim()) return state.prompt;
    if (!["ADD_TAG", "REMOVE_TAG", "UPDATE_ENTRY", "SET_WEIGHT", "MOVE_SECTION", "RECONCILE_TEXT", "ADD_CHARACTER", "REMOVE_CHARACTER", "MOVE_CHARACTER", "RENAME_CHARACTER", "SET_CHARACTER_POSITION", "APPLY_AUTO_SPLIT", "SET_ASSISTANT_CONTEXT", "SET_EXCLUSIVE_GROUP", "SCENE_PROPOSAL", "APPLY_INTERACTION", "REMOVE_INTERACTION"].includes(action.type)) return state.prompt;
  // RECONCILE_TEXT 不逐键 pushHistory：一次编辑会话只压一个快照（见 #nai-editor focus/blur 事务）。
  if (action.type !== "RECONCILE_TEXT") pushHistory();
  const remapTarget = (target, type, from, to) => {
    const m = String(target).match(/^char:(\d+)(:uc)?$/); if (!m) return target;
    const n = Number(m[1]); const suffix = m[2] || "";
    if (type === "remove") return n === from ? "base" : n > from ? `char:${n - 1}${suffix}` : target;
    if (type === "move") { if (n === from) return `char:${to}${suffix}`; if (n === to) return `char:${from}${suffix}`; }
    return target;
  };
  switch (action.type) {
    case "ADD_TAG": {
      const tag = String(payload.tag || "").trim();
      if (promptDocument.getTargetEntries(state.prompt, target).some((entry) => entry.tag.toLocaleLowerCase() === tag.toLocaleLowerCase())) { state.history.pop(); return state.prompt; }
      const section = SECTION_IDS.includes(payload.section) ? payload.section : "other";
      state.prompt = promptDocument.addTag(state.prompt, target, {
        tag, section, weight: payload.weight ?? 1, source: payload.source || "tag", custom: !!payload.custom,
        relation: payload.relation ?? null, brackets: payload.brackets ?? 0,
        bundle_id: payload.bundle_id ?? null, bundle_name: payload.bundle_name ?? null,
        provenance: payload.provenance ?? null, interaction_id: payload.interaction_id ?? null,
      }, section);
      break;
    }
    case "REMOVE_TAG": state.prompt = promptDocument.removeTag(state.prompt, target, payload.entryId); break;
    case "UPDATE_ENTRY": state.prompt = promptDocument.updateEntry(state.prompt, target, payload.entryId, payload.patch || {}); break;
    case "SET_WEIGHT": state.prompt = promptDocument.updateEntry(state.prompt, target, payload.entryId, { weight: Number(payload.weight) }); break;
    case "MOVE_SECTION": state.prompt = promptDocument.updateEntry(state.prompt, target, payload.entryId, { section: payload.section }); break;
    case "RECONCILE_TEXT": state.prompt = promptDocument.reconcileTargetText(state.prompt, target, payload.text || "", new Map(knownCatalogTags)); break;
    case "ADD_CHARACTER": {
      if (state.prompt.characters.length >= 3) { state.history.pop(); return state.prompt; }
      state.prompt = promptDocument.addCharacter(state.prompt, payload);
      state.prompt = promptDocument.setAssistantContext(state.prompt, { participant_count: state.prompt.characters.length });
      break;
    }
    case "REMOVE_CHARACTER": {
      const idx = Number(payload.index);
      if (idx !== state.prompt.characters.length - 1 || promptDocument.characterHasContent(state.prompt.characters[idx], idx)) { state.history.pop(); notifyPromptSubscribers({ type: "SCENE_WARNING", payload: { message: `Character ${idx + 1} 仍有内容` } }); return state.prompt; }
      state.prompt = promptDocument.removeCharacter(state.prompt, idx);
      state.prompt = promptDocument.setAssistantContext(state.prompt, { participant_count: state.prompt.characters.length });
      break;
    }
    case "MOVE_CHARACTER": state.prompt = promptDocument.moveCharacter(state.prompt, payload.fromIndex, payload.toIndex); break;
    case "RENAME_CHARACTER": state.prompt = promptDocument.renameCharacter(state.prompt, payload.index, payload.name); break;
    case "SET_CHARACTER_POSITION": state.prompt = promptDocument.setCharacterPosition(state.prompt, payload.index, payload.position); break;
    case "APPLY_AUTO_SPLIT": {
      // 一次 proposal -> PromptDocument 整体替换 -> 单次 notify；不逐 tag dispatch。
      const proposal = payload.proposal || payload;
      if (!proposal || typeof proposal !== "object") { state.history.pop(); return state.prompt; }
      state.prompt = promptDocument.documentFromProposal(proposal);
      break;
    }
    case "SET_ASSISTANT_CONTEXT": state.prompt = promptDocument.setAssistantContext(state.prompt, payload.context || {}); break;
    case "SET_EXCLUSIVE_GROUP": state.prompt = promptDocument.applyExclusiveGroup(state.prompt, payload); break;
    case "SCENE_PROPOSAL": {
      if (payload.kind !== "sync_participants") { state.history.pop(); return state.prompt; }
      const result = promptDocument.syncSceneParticipants(state.prompt, payload.count);
      if (!result.ok) { state.history.pop(); notifyPromptSubscribers({ type: "SCENE_WARNING", payload: { message: result.blockedIndices.map((idx) => `Character ${idx + 1} 仍有内容`).join("；"), blockedIndices: result.blockedIndices } }); return state.prompt; }
      state.prompt = result.document;
      break;
    }
    case "APPLY_INTERACTION": state.prompt = promptDocument.applyInteraction(state.prompt, payload.interaction || payload); break;
    case "REMOVE_INTERACTION": state.prompt = promptDocument.removeInteraction(state.prompt, payload.id); break;
  }
  if (action.type === "REMOVE_CHARACTER") state.target = remapTarget(state.target, "remove", Number(payload.index));
  if (action.type === "MOVE_CHARACTER") state.target = remapTarget(state.target, "move", Number(payload.fromIndex), Number(payload.toIndex));
  // RECONCILE_TEXT 走轻量提交：不重建购物车 DOM、不触发推荐/冲突网络请求（编辑器 UI 由
  // PromptBridge 订阅者 renderWorkbenchEditorFromDocument 更新，且聚焦时跳过）。
  if (action.type === "RECONCILE_TEXT") commitPromptChange({ render: false, refresh: false });
  else commitPromptChange({ refresh: true });
  if (["ADD_CHARACTER", "REMOVE_CHARACTER", "MOVE_CHARACTER", "RENAME_CHARACTER", "SET_CHARACTER_POSITION", "APPLY_AUTO_SPLIT", "SCENE_PROPOSAL"].includes(action.type)) {
    rebuildTargetSelect();
    if (typeof naiRenderCharacters === "function") {
      syncNaiCharactersFromState();
      naiRenderCharacters();
    }
  }
  return state.prompt;
}
window.PromptBridge = {
  getDocument: () => state.prompt,
  getActiveTarget: () => state.target,
  setActiveTarget: (target) => { state.target = resolveDisplayTarget(target); rebuildTargetSelect(); updateCartHeader(); notifyPromptSubscribers({ type: "SET_ACTIVE_TARGET", payload: { target: state.target } }); return state.target; },
  subscribe: (listener) => { if (typeof listener !== "function") return () => {}; promptSubscribers.add(listener); return () => promptSubscribers.delete(listener); },
  dispatch: dispatchPromptAction,
  serializeTarget: (target) => promptDocument?.serializeTarget(state.prompt, promptBridgeTarget(target)) || "",
};
const RELATIONS = ["", "source", "target", "mutual"];
let promptPresets = [];
let promptSections = SECTION_IDS.map((id) => ({ id, label: SECTION_LABELS[id] }));
let recommendations = [];
let promptConflicts = [];
let bundles = [];
let pendingSnapshotId = null;
let cartAdvanced = false;
let openWeightEntryId = null; // 当前打开的权重 popover 对应条目 id；renderCart 重建后据此保持打开
let zhMap = {}; // prompt_tag -> 中文名
let freeTextRawSync = null; // #free-text 输入防抖句柄；translateFreeText 取消 pending 防抖用
const knownCatalogTags = new Map();
let reconciliationBusy = false;
let activeWorkspaceTarget = "base"; // 高级购物车当前 Tab：'base' | 角色索引（number）
let workspaceSectionFilter = "";    // '' = 全部分区，或 SECTION_IDS 之一
let workspaceShowEmpty = false;     // 显示空分区（默认关）
let activeNaiTarget = "base";       // 生图视图角色 Tab：'base' | 角色索引（number）
// Workbench 单一编辑器视图模型：mode ∈ text|visual|scene；pane ∈ prompt|uc；charIndex = null(base) | number。
let workbenchMode = "text";
let workbenchPane = "prompt";
let workbenchCharIndex = null;       // null = Base；number = 角色下标
let editTransactionSnapshot = null;  // 一次编辑会话（focus→blur）只压一个 undo 快照

// 纯函数：把 workbench 视图解析为 PromptDocument 目标槽位。
// 仅 text 模式有目标；base 的 uc 槽位 = global_uc；角色 = char:N / char:N:uc。
function resolveWorkbenchEditorTarget(view = {}) {
  if (view.mode !== "text") return null;
  if (view.charIndex == null) return view.pane === "uc" ? "global_uc" : "base";
  return "char:" + view.charIndex + (view.pane === "uc" ? ":uc" : "");
}
function currentWorkbenchView() {
  return { mode: workbenchMode, pane: workbenchPane, charIndex: workbenchCharIndex };
}
// 编辑事务：聚焦时保存一次 pre-edit 快照；blur/目标切换/模式切换时若内容已变，压入一次 history。
function beginEditTransaction() {
  if (editTransactionSnapshot == null) editTransactionSnapshot = snapshot();
}
function endEditTransaction() {
  if (editTransactionSnapshot == null) return;
  const pre = editTransactionSnapshot;
  editTransactionSnapshot = null;
  if (snapshot() !== pre) {
    state.history.push(pre);
    if (state.history.length > 50) state.history.shift();
  }
}

// ===== 工具 =====
const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};
const debounce = (fn, ms) => {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssEsc = (s) => {
  const v = String(s ?? "");
  if (globalThis.CSS?.escape) return CSS.escape(v);
  return v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
};

function flattenSections(sections) { return SECTION_IDS.flatMap((id) => (sections?.[id] || []).map((e) => ({ ...e, strength: e.weight === 1 ? null : e.weight, brackets: 0, relation: null }))); }
function syncLegacyProjection() {
  state.base = flattenSections(state.prompt.sections);
  state.characters = state.prompt.characters.map((ch) => ({ name: ch.name, prompt: flattenSections(ch.prompt_sections), uc: flattenSections(ch.uc_sections), position: ch.position || null }));
  state.global_uc = flattenSections(state.prompt.global_uc_sections);
  state.free_text = state.prompt.free_text;
}
function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    state.prompt = migratePromptState(draft?.prompt || draft);
    if (draft?.model) state.model = draft.model;
  } catch { state.prompt = emptyPromptState(); }
  syncLegacyProjection();
}
function persistDraft() {
  syncLegacyProjection();
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ schema_version: 2, model: state.model, prompt: state.prompt, saved_at: new Date().toISOString() }));
}
function snapshot() { return JSON.stringify({ prompt: state.prompt, model: state.model }); }
function pushHistory() { state.history.push(snapshot()); if (state.history.length > 50) state.history.shift(); }
function allPromptEntries() {
  const out = [...flattenSections(state.prompt.sections), ...flattenSections(state.prompt.global_uc_sections)];
  state.prompt.characters.forEach((ch) => out.push(...flattenSections(ch.prompt_sections), ...flattenSections(ch.uc_sections)));
  return out;
}
function positivePromptEntries() {
  const out = [...flattenSections(state.prompt.sections)];
  state.prompt.characters.forEach((ch) => out.push(...flattenSections(ch.prompt_sections)));
  return out;
}
function negativePromptEntries() {
  const out = [...flattenSections(state.prompt.global_uc_sections)];
  state.prompt.characters.forEach((ch) => out.push(...flattenSections(ch.uc_sections)));
  return out;
}
function weightText(entry) {
  return serializePromptToken(entry);
}
function abbreviateCount(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return v ? String(v) : "";
}
function promptPreviewText() {
  const tags = positivePromptEntries().map(weightText);
  const freeText = effectiveFreeText();
  if (freeText) tags.push(freeText);
  return tags.join(", ");
}
function effectiveFreeText() {
  return state.prompt.use_free_text_en && state.prompt.free_text_en.trim() ? state.prompt.free_text_en.trim() : state.prompt.free_text.trim();
}
function negativePreviewText() { return negativePromptEntries().map(weightText).join(", "); }
const refreshPromptServices = debounce(() => { loadRecommendations(); loadConflicts(); }, 250);
function commitPromptChange({ render = true, refresh = true } = {}) {
  persistDraft();
  if (render) renderCart();
  if (refresh) refreshPromptServices();
  notifyPromptSubscribers();
}

// ===== 用户设置 =====
let userSettings = {
  adolescent_mode: true,
  cache_limit_mb: 1024,
  cache_usage_mb: 0,
  novelai_example_usage_mb: 0,
  gallery_usage_mb: 0,
  proxy_enabled: true,
  proxy_url: "",
  danbooru_login: "",
  has_danbooru_api_key: false,
  novelai_configured: false,
  novelai_batch_max_count: 6,
  novelai_example_credit_warning: true,
  novelai_example_prompt_template: "{tag}, {rating}, masterpiece, best quality, very aesthetic, absurdres",
  baidu_translate_configured: false,
};

async function loadUserSettings() {
  try {
    userSettings = await api("/api/settings");
  } catch (e) {
    toast("设置加载失败：" + e.message);
  }
}

function openSettings() {
  const s = userSettings;
  $("#setting-adolescent").checked = !!s.adolescent_mode;
  $("#setting-cache-limit").value = s.cache_limit_mb ?? 1024;
  $("#setting-proxy-enabled").checked = s.proxy_enabled !== false;
  $("#setting-proxy-url").value = s.proxy_url || "";
  $("#setting-login").value = s.danbooru_login || "";
  $("#setting-api-key").value = "";
  $("#setting-api-key").placeholder = s.has_danbooru_api_key ? "已配置，留空保持不变" : "输入 API Key";
  $("#setting-novelai-api-key").value = "";
  $("#setting-novelai-api-key").placeholder = s.novelai_configured ? "已配置，留空保持不变" : "输入 NovelAI API Key";
  $("#setting-baidu-appid").value = "";
  $("#setting-baidu-appid").placeholder = s.baidu_translate_configured ? "已配置，留空保持不变" : "输入百度翻译 APP ID";
  $("#setting-baidu-secret").value = "";
  $("#setting-baidu-secret").placeholder = s.baidu_translate_configured ? "已配置，留空保持不变" : "输入百度翻译密钥";
  $("#setting-novelai-batch-max").value = s.novelai_batch_max_count ?? 6;
  $("#setting-novelai-batch-max-value").textContent = `${s.novelai_batch_max_count ?? 6} 张`;
  $("#setting-novelai-example-credit-warning").checked = s.novelai_example_credit_warning !== false;
  $("#setting-novelai-example-prompt").value = s.novelai_example_prompt_template || "";
  $("#storage-web").textContent = `${s.cache_usage_mb ?? 0} MB`;
  $("#storage-novelai-example").textContent = `${s.novelai_example_usage_mb ?? 0} MB`;
  $("#storage-gallery").textContent = `${s.gallery_usage_mb ?? 0} MB`;
  $("#settings-status").textContent = `网上例图缓存上限：${s.cache_limit_mb ?? 1024} MB`;
  loadCustomTags();
  $("#settings-modal").style.display = "flex";
}

function closeSettings() { $("#settings-modal").style.display = "none"; }

async function saveUserSettings() {
  const btn = $("#settings-save");
  btn.disabled = true;
  try {
    const payload = {
      adolescent_mode: $("#setting-adolescent").checked,
      cache_limit_mb: Number($("#setting-cache-limit").value),
      proxy_enabled: $("#setting-proxy-enabled").checked,
      proxy_url: $("#setting-proxy-url").value.trim(),
      danbooru_login: $("#setting-login").value.trim(),
      danbooru_api_key: $("#setting-api-key").value,
      novelai_api_token: $("#setting-novelai-api-key").value,
      baidu_translate_appid: $("#setting-baidu-appid").value.trim(),
      baidu_translate_secret: $("#setting-baidu-secret").value,
      novelai_batch_max_count: Number($("#setting-novelai-batch-max").value),
      novelai_example_credit_warning: $("#setting-novelai-example-credit-warning").checked,
      novelai_example_prompt_template: $("#setting-novelai-example-prompt").value.trim(),
    };
    if (!Number.isFinite(payload.cache_limit_mb) || payload.cache_limit_mb < 0) {
      throw new Error("缓存上限必须是 0 或更大的数字");
    }
    if (!Number.isInteger(payload.novelai_batch_max_count) || payload.novelai_batch_max_count < 1 || payload.novelai_batch_max_count > 6) {
      throw new Error("批处理上限必须是 1-6");
    }
    if (payload.novelai_example_prompt_template && !payload.novelai_example_prompt_template.includes("{tag}")) {
      throw new Error("例图提示词模板必须包含 {tag} 占位符");
    }
    userSettings = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    window.WorkbenchComponents?.nsfwBuilder?.setAdolescentMode(!!userSettings.adolescent_mode);
    window.WorkbenchMode?.set(workbenchMode);
    naiSyncResolutionFromInputs();
    closeSettings();
    await loadNaiApiStatus();
    await loadTaxonomy();
    if (activeCatalogId) await openCatalog(activeCatalogId, currentPage, { noHistory: true });
    toast("设置已保存");
  } catch (e) {
    $("#settings-status").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function clearThumbCache() {
  if (!confirm("确定清理全部例图缓存？不会删除图库导入的图片。")) return;
  try {
    const r = await api("/api/cache/clear", { method: "POST" });
    userSettings.cache_usage_mb = 0;
    $("#settings-status").textContent = `已清理 ${r.removed} 个缓存文件`;
    toast("例图缓存已清理");
  } catch (e) { $("#settings-status").textContent = e.message; }
}

async function clearNovelAIExampleCache() {
  if (!confirm("确定清理全部 NovelAI 标签例图？不会删除 NovelAI 图库。")) return;
  try {
    const r = await api("/api/novelai-examples/clear", { method: "POST" });
    userSettings.novelai_example_usage_mb = 0;
    Object.keys(novelaiExampleMap).forEach((tag) => {
      if (exampleSourceByTag[tag] === "novelai") setExampleSource(tag, "web");
      delete novelaiExampleMap[tag];
      delete novelaiExampleErrors[tag];
    });
    refreshExampleControls();
    applyThumbs();
    $("#storage-novelai-example").textContent = "0 MB";
    $("#settings-status").textContent = `已清理 ${r.removed} 个 NovelAI 标签例图`;
    toast("NovelAI 标签例图已清理");
  } catch (e) { $("#settings-status").textContent = e.message; }
}

// ===== 目标槽位 =====
function targetOptions() {
  const opts = [{ value: "base", label: "Base Prompt" }, { value: "global_uc", label: "Global UC" }];
  // 角色目标必须与 cartAdvanced 无关地派生自权威 PromptDocument（state.prompt.characters），
  // 否则 setActiveTarget('char:N') 后 rebuildTargetSelect() 会把 state.target 重置回 'base'，
  // PromptBridge.getActiveTarget() 永远拿不到角色目标（破坏 Visual/Scene/模板捕获）。
  (state.prompt?.characters || []).forEach((ch, i) => {
    opts.push({ value: `char:${i}`, label: `${ch.name || "Character " + (i + 1)} Prompt` });
    opts.push({ value: `char:${i}:uc`, label: `${ch.name || "Character " + (i + 1)} UC` });
  });
  return opts;
}
function rebuildTargetSelect() {
  const sel = $("#target-select");
  const options = targetOptions();
  if (!options.some((option) => option.value === state.target)) state.target = "base";
  sel.innerHTML = options.map((o) => `<option value="${o.value}" ${o.value === state.target ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  syncNaiTagTargetFromState();
  updateCartHeader();
}
// #target-select 是唯一可见的目标选择器；隐藏的 #nai-tag-target 只负责给 addTagToTarget 读取，
// 因此把 state.target 映射回其正向目标（base / char:N）并保持同步。
function syncNaiTagTargetFromState() {
  const sel = $("#nai-tag-target");
  if (!sel) return;
  let mapped = state.target;
  if (mapped === "global_uc") mapped = "base";
  else if (/^char:\d+:uc$/.test(String(mapped || ""))) mapped = String(mapped).replace(/:uc$/, "");
  if ([...sel.options].some((o) => o.value === mapped)) sel.value = mapped;
  else if ([...sel.options].some((o) => o.value === "base")) sel.value = "base";
}

// ===== 标签目标选择器（超市点击标签写入 Base / 指定角色） =====
function insertTagIntoString(text, tag) {
  const raw = String(tag ?? "").trim();
  if (!raw) return text;
  const tokens = splitPromptTokens(text);
  const existing = new Set(tokens.map((t) => t.toLowerCase()));
  if (existing.has(raw.toLowerCase())) return text;
  tokens.push(raw);
  return joinPromptTokens(tokens);
}

// Reconciliation deliberately understands only catalog identities in plain comma tokens
// and NovelAI's weight::tag:: form. Braces, brackets, prose, and unknown syntax stay raw.
function recognizedTagToken(token, knownTags) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const weighted = raw.match(/^\s*(?:\d+(?:\.\d+)?|\.\d+)::([^,:]+?)::\s*$/);
  const candidate = weighted ? weighted[1].trim() : raw;
  const key = candidate.toLocaleLowerCase();
  return knownTags.has(key) && (weighted || /^[^{}\[\]<>]+$/.test(candidate)) ? { key, tag: knownTags.get(key), weighted, weight: weighted ? Number(weighted[0].split("::", 1)[0]) : 1 } : null;
}
// NOTE：extractRecognizedTagIdentities 仍被 tests/test_app_helpers.mjs 源码提取导入，
// 故保留（不删除）。生产代码仅 recognizedTagToken 被高级工作区复用。
function extractRecognizedTagIdentities(text, knownTags = knownCatalogTags) {
  return splitPromptTokens(text).map((token) => recognizedTagToken(token, knownTags)).filter(Boolean).map((x) => x.key);
}
// 结构化解析 helper 收敛在 static/nai-structured.js（纯模块，供测试复用），
// 仅用于图库/旧快照里遗留的结构化 rawPrompt 的迁移解析，绝不参与正常编辑/生成同步。
function naiStructuredBaseLine(display) {
  return window.NaiStructured.structuredBaseLine(display);
}

// P0 结构化边界：把图库/旧快照里保存的 rawPrompt / rawNegative / characterPrompts 统一拆分为
// 干净的 { basePrompt, globalUc, characters }，供 naiRestoreItem / applyGenerationConfig / 剪贴板
// 失败回退共用（唯一拆分逻辑，绝不把 Base:/Character N:/Global UC: 混合串写回 #nai-prompt）。
//   - 结构化 legacy rawPrompt（含 Base:/Character N:/Global UC:/Free text: 行）：
//     用 parseStructuredRawPrompt 一次性拆解；角色优先用保存的 characterPrompts（保留 position），
//     缺失时退回从 display 行解析（position 置 null）。
//   - 否则视为干净 Base + Global UC + characterPrompts；纯 flat 单角色按普通文本处理。
// 返回值约定：
//   - basePrompt / globalUc 为 null 表示「调用方不要覆盖对应输入框」（仅当入参为 null/undefined）；
//   - characters 为 null 表示「调用方不要改动角色」（仅当无结构化且无 characterPrompts 时）。
function naiResolveRestoredPrompt(rawPrompt, rawNegative, savedCharacters) {
  const charactersSrc = Array.isArray(savedCharacters) ? savedCharacters : [];
  const parsed = window.NaiStructured.parseStructuredRawPrompt(rawPrompt, rawNegative);
  if (parsed) {
    const characters = charactersSrc.length
      ? charactersSrc.map((character) => ({ prompt: character.prompt || "", negative_prompt: character.negative_prompt || "", position: character.position ? { ...character.position } : null }))
      : parsed.characters.map((character) => ({ prompt: character.prompt || "", negative_prompt: character.negative_prompt || "", position: null }));
    return { basePrompt: parsed.basePrompt, globalUc: parsed.globalUc, characters };
  }
  return {
    basePrompt: rawPrompt != null ? rawPrompt : null,
    globalUc: rawNegative != null ? rawNegative : null,
    characters: charactersSrc.length ? charactersSrc.map((character) => ({ prompt: character.prompt || "", negative_prompt: character.negative_prompt || "", position: character.position ? { ...character.position } : null })) : null,
  };
}
// naiCharacters 是 state.prompt.characters 的 view adapter（单一权威来源 = PromptDocument）。
// 仅在权威状态变化后（dispatch / restore / 进入生图视图）单向同步；不引入第二份权威状态。
function syncNaiCharactersFromState() {
  naiCharacters = (state.prompt?.characters || []).map((character, index) => ({
    prompt: promptDocument.serializeTarget(state.prompt, `char:${index}`),
    negative_prompt: promptDocument.serializeTarget(state.prompt, `char:${index}:uc`),
    position: character.position || null,
  }));
}

// ===== Workbench 单一编辑器：PromptDocument -> Text 渲染 =====
// PromptDocument 是唯一权威：#nai-editor 的值永远由 serializeTarget(target) 派生，绝不反向写 DOM。
// GUARD：编辑器聚焦时跳过（除非 force），避免打字时被重写、光标跳动。
function renderWorkbenchFreeText() {
  const collapse = $("#nai-free-text-collapse");
  const raw = $("#nai-free-text");
  const en = $("#nai-free-text-en");
  const useEn = $("#nai-free-text-use-en");
  const isBase = resolveWorkbenchEditorTarget(currentWorkbenchView()) === "base";
  if (collapse) collapse.hidden = !isBase;
  if (!isBase) return;
  const focusEl = document.activeElement;
  if (raw && focusEl !== raw) raw.value = state.prompt.free_text || "";
  if (en && focusEl !== en) en.value = state.prompt.free_text_en || "";
  if (useEn) useEn.checked = !!state.prompt.use_free_text_en;
}
function renderWorkbenchEditorFromDocument(opts = {}) {
  const editor = $("#nai-editor");
  if (!editor) return;
  const target = resolveWorkbenchEditorTarget(currentWorkbenchView());
  if (!target) {
    editor.hidden = true;
    $(".nai-prompt-meta")?.toggleAttribute("hidden", true);
    return;
  }
  editor.hidden = false;
  $(".nai-prompt-meta")?.toggleAttribute("hidden", false);
  if (!opts.force && document.activeElement === editor) return;
  editor.value = window.PromptBridge.serializeTarget(target);
  updateNaiPromptMeta();
  renderWorkbenchFreeText();
}

function promptTokenRange(text, caret) {
  const value = String(text || "");
  const at = Math.max(0, Math.min(Number(caret) || 0, value.length));
  let start = value.lastIndexOf(",", at - 1) + 1;
  let end = value.indexOf(",", at);
  if (end < 0) end = value.length;
  return { start, end, token: value.slice(start, end), query: value.slice(start, at).trim() };
}
function replacePromptToken(text, caret, replacement) {
  const range = promptTokenRange(text, caret);
  const left = text.slice(range.start, caret).match(/^\s*/)?.[0] || "";
  const right = text.slice(caret, range.end).match(/\s*$/)?.[0] || "";
  return text.slice(0, range.start) + left + replacement + right + text.slice(range.end);
}
// 替换 token 并同时可靠返回新的 value 与 caret（caret 落在插入 tag 末尾，绝不落到 tag 内部）。
// 生产代码已改用 prompt-tokenizer 的 tokenRangeAtCaret；此三函数保留仅供
// tests/test_app_helpers.mjs 源码提取回归（逗号切分语义）。
function replacePromptTokenWithCaret(text, caret, replacement) {
  const range = promptTokenRange(text, caret);
  const left = text.slice(range.start, caret).match(/^\s*/)?.[0] || "";
  const right = text.slice(caret, range.end).match(/\s*$/)?.[0] || "";
  const value = text.slice(0, range.start) + left + replacement + right + text.slice(range.end);
  return { value, caret: range.start + left.length + replacement.length };
}
let naiAutocompleteState = { input: null, target: "base", range: null, results: [], selected: 0, request: 0 };
let naiAutocompleteSuppress = null; // 一次性抑制：接受建议后若光标仍停在刚插入的完整 tag 内，抑制搜索，避免弹窗立即重开
// 接受建议后判断：query 是否等于刚接受的 tag（等于则跳过搜索，不重开弹窗）。
function naiAutocompleteSkipSearch(acceptedTag, query) {
  return !!acceptedTag && String(query ?? "").trim().toLocaleLowerCase() === String(acceptedTag).toLocaleLowerCase();
}
const naiAutocompleteSearch = debounce(async (input) => {
  const caret = input.selectionStart;
  const range = tokenRangeAtCaret(input.value, caret); // caret-range 唯一权威
  // tokenRangeAtCaret 对空编辑器返回 null（无任何 token），必须守卫，否则 slice(range.start) 抛错。
  if (!range) { closeNaiAutocomplete(); return; }
  const query = input.value.slice(range.start, caret).trim();
  const acceptedTag = naiAutocompleteSuppress;
  naiAutocompleteSuppress = null;
  if (naiAutocompleteSkipSearch(acceptedTag, query)) return;
  if (query.length < 2 || /[{}\[\]()<>]/.test(query)) { closeNaiAutocomplete(); return; }
  const request = ++naiAutocompleteState.request;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (request !== naiAutocompleteState.request || document.activeElement !== input) return;
    naiAutocompleteState = { ...naiAutocompleteState, input, range, results: (data.results || []).slice(0, 8), selected: 0 };
    renderNaiAutocomplete();
  } catch { closeNaiAutocomplete(); }
}, 180);
function closeNaiAutocomplete() { const box = $("#nai-autocomplete"); if (box) box.hidden = true; naiAutocompleteState.results = []; }
function renderNaiAutocomplete() {
  const box = $("#nai-autocomplete");
  const { results, selected } = naiAutocompleteState;
  if (!box || !results.length) { closeNaiAutocomplete(); return; }
  box.innerHTML = results.map((item, i) => {
    const zh = item.zh || "";
    const count = abbreviateCount(item.post_count);
    const viaAlias = /别名/.test(item.match_reason || "");
    const second = [zh, count, viaAlias ? "via 别名" : ""].filter(Boolean).join(" · ");
    return `<div role="option" data-autocomplete-index="${i}" aria-selected="${i === selected}"><span class="ac-tag">${esc(item.tag)}</span><small>${esc(second)}</small></div>`;
  }).join("");
  const hint = (typeof window !== "undefined" && window.NaiInputKeys) ? window.NaiInputKeys.buildHintHtml() : "";
  box.innerHTML += hint;
  const input = naiAutocompleteState.input;
  const rect = input.getBoundingClientRect();
  box.style.left = `${Math.max(8, rect.left)}px`;
  box.style.top = `${rect.bottom + 4}px`;
  box.style.width = `${Math.min(Math.max(rect.width, 260), 520)}px`;
  box.hidden = false;
  box.querySelectorAll("[data-autocomplete-index]").forEach((node) => node.addEventListener("mousedown", (event) => { event.preventDefault(); acceptNaiAutocomplete(Number(node.dataset.autocompleteIndex)); }));
}
function acceptNaiAutocomplete(index = naiAutocompleteState.selected) {
  const { input, results } = naiAutocompleteState;
  const item = results[index]; if (!input || !item) return;
  knownCatalogTags.set(String(item.tag).toLocaleLowerCase(), item.tag);
  const caret = input.selectionStart;
  // caret-range 唯一权威：tokenRangeAtCaret 尊重 weight::tag:: 包裹，避免拆进加权 token 内部。
  const range = tokenRangeAtCaret(input.value, caret);
  const left = input.value.slice(range.start, caret).match(/^\s*/)?.[0] || "";
  const right = input.value.slice(caret, range.end).match(/\s*$/)?.[0] || "";
  const value = input.value.slice(0, range.start) + left + item.tag + right + input.value.slice(range.end);
  const nextCaret = range.start + left.length + item.tag.length;
  // Tab / 鼠标接受：追加分隔符 `, `（若光标后已有分隔符则不再追加）。
  const delimiter = (typeof window !== "undefined" && window.NaiInputKeys)
    ? window.NaiInputKeys.delimiterToAppend(value.slice(nextCaret))
    : ", ";
  input.value = value + delimiter;
  input.setSelectionRange(nextCaret + delimiter.length, nextCaret + delimiter.length);
  closeNaiAutocomplete();
  naiAutocompleteSuppress = item.tag; // 抑制合成 input 触发的搜索，避免弹窗立即重开
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function bindNaiAutocomplete(input, target, opts = {}) {
  let keys = null; // 惰性初始化：首次 keydown 时读取 window.NaiInputKeys（模块脚本已加载）
  const ensureKeys = () => {
    if (keys === null) {
      const NaiKeys = (typeof window !== "undefined") ? window.NaiInputKeys : null;
      if (NaiKeys) {
        keys = NaiKeys.createNaiInputKeys();
        input.addEventListener("compositionstart", () => keys.setComposing(true));
        input.addEventListener("compositionend", () => keys.setComposing(false));
      } else {
        keys = false;
      }
    }
    return keys || null;
  };
  input.addEventListener("input", () => { naiAutocompleteState.target = target; naiAutocompleteSearch(input); });
  input.addEventListener("keydown", (event) => {
    const controller = ensureKeys();
    if (controller) {
      const popupOpen = !!($("#nai-autocomplete") && !$("#nai-autocomplete").hidden);
      const action = controller.handleKeydown(event, { popup: { open: popupOpen, results: naiAutocompleteState.results, selected: naiAutocompleteState.selected } });
      switch (action.action) {
        case "navigate": event.preventDefault(); naiAutocompleteState.selected = action.index; renderNaiAutocomplete(); return;
        case "accept": event.preventDefault(); acceptNaiAutocomplete(action.index); return;
        case "close": event.preventDefault(); closeNaiAutocomplete(); return;
        case "generate": event.preventDefault(); if (opts.generateOnDoubleEnter) naiGenerate(); return;
        default: return; // newline（单 Enter 换行）/ none：交还默认行为
      }
    }
    // 模块未加载的兜底：保留旧方向键/Tab/Esc 行为
    if (!$("#nai-autocomplete") || $("#nai-autocomplete").hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); naiAutocompleteState.selected = (naiAutocompleteState.selected + (event.key === "ArrowDown" ? 1 : -1) + naiAutocompleteState.results.length) % naiAutocompleteState.results.length; renderNaiAutocomplete(); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); acceptNaiAutocomplete(); }
    else if (event.key === "Escape") { event.preventDefault(); closeNaiAutocomplete(); }
  });
  input.addEventListener("blur", () => setTimeout(closeNaiAutocomplete, 120));
}

function remapNaiTagTarget(target, op, a, b) {
  if (typeof target !== "string" || !target.startsWith("char:")) return target;
  const m = target.match(/^char:(\d+)$/);
  if (!m) return target; // char:N:uc 等非正向目标不改
  const n = Number(m[1]);
  if (op === "remove") {
    const i = a;
    if (n === i) return "base";
    if (n > i) return `char:${n - 1}`;
    return target;
  }
  if (op === "move") {
    const from = a, to = b;
    if (n === from) return `char:${to}`;   // 被移动的角色跟随
    if (n === to)   return `char:${from}`; // 被挤占（交换）的角色也跟随
    return target;
  }
  return target;
}

function rebuildNaiTagTarget() {
  const sel = $("#nai-tag-target");
  if (!sel) return;
  // 权威来源 = PromptDocument（state.prompt.characters），绝不依赖 view adapter naiCharacters，
  // 否则页面加载时 naiCharacters 尚未同步（undefined）会让 init() 抛错中断。
  const characters = (state.prompt?.characters || []);
  const options = [`<option value="base">Base / Scene</option>`];
  characters.forEach((_, i) => options.push(`<option value="char:${i}">Character ${i + 1}</option>`));
  sel.innerHTML = options.join("");
  const m = String(state.target || "").match(/^char:(\d+)$/);
  if (m && characters[Number(m[1])]) {
    sel.value = state.target;
  } else {
    sel.value = "base";
    if (m) window.PromptBridge.setActiveTarget("base");
  }
}

async function addTagToTarget(tag) {
  const sel = document.getElementById("nai-tag-target");
  window.PromptBridge.setActiveTarget(sel?.value || "base");
  const label = targetLabel(state.target);
  // PromptDocument 是唯一权威：加标签只走 addEntry -> dispatch ADD_TAG，不再写任何 textarea。
  const added = await addEntry(tag);
  if (added) toast(`已加入「${tag}」→ ${label}`);
}

// ===== 初始化 =====
async function init() {
  await promptDocumentReady;
  loadDraft();
  await loadUserSettings();
  await mountWorkbenchComponents();
  const m = await api("/api/models");
  state.models = m.models;
  if (!state.model || !m.models.some((x) => x.id === state.model)) state.model = m.default;
  $("#model-select").innerHTML = m.models.map((x) => `<option value="${x.id}" ${x.id === state.model ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  rebuildTargetSelect();
  rebuildNaiTagTarget();
  await Promise.all([loadTaxonomy(), loadFavorites(), loadRecent(), loadPromptSections(), loadSectionOverrides()]);
  await loadZh();
  await loadPromptPresets();
  renderCart();
  refreshPromptServices();
}

async function mountWorkbenchComponents() {
  const [assistantModule, builderModule, nsfwModule] = await Promise.all([import("/static/tag-assistant.js"), import("/static/visual-builder.js"), import("/static/nsfw-builder.js")]);
  const assistant = assistantModule.createTagAssistant({ root: $("#tag-assistant-root"), bridge: window.PromptBridge });
  const builder = builderModule.createVisualBuilder({
    root: $("#visual-prompt-root"),
    bridge: window.PromptBridge,
    getGenerationConfig: () => ({ positiveTier: naiPositiveTier }),
    getMode: () => userSettings.adolescent_mode ? "general" : (workbenchMode === "scene" ? "adult" : "general"),
  });
  assistant.mount();
  builder.mount();
  let nsfwBuilder = null;
  try {
    const options = await api("/api/nsfw-builder/options");
    nsfwBuilder = nsfwModule.createNsfwBuilder({
      root: $("#nsfw-builder-root"),
      bridge: window.PromptBridge,
      adolescentMode: !!userSettings.adolescent_mode,
      mode: "adult",
      participants: options.participants || [],
      primaryActs: options.primaryActs || [],
      scenarios: options.scenarios || [],
      environments: options.environments || [],
      stages: options.stages || [],
      positions: options.positions || [],
      clothingStates: options.clothingStates || [],
      characterStates: options.characterStates || [],
      expressions: options.expressions || [],
      additionalActivities: options.additionalActivities || [],
      interactionActions: options.interactionActions || [],
      bodyFocus: options.bodyFocus || [],
      compositions: options.compositions || [],
      getGenerationConfig: () => ({ positiveTier: naiPositiveTier }),
    });
    nsfwBuilder.mount();
  } catch (e) {
    // 候选加载失败仍挂载（仅内置 participants/stage + 推荐），不影响其它组件
    nsfwBuilder = nsfwModule.createNsfwBuilder({ root: $("#nsfw-builder-root"), bridge: window.PromptBridge, adolescentMode: !!userSettings.adolescent_mode, mode: "adult" });
    nsfwBuilder.mount();
  }
  window.WorkbenchComponents = { assistant, builder, nsfwBuilder };
  const switcher = $("#prompt-mode-switch");
  const setMode = (mode) => {
    if (mode === "scene" && userSettings.adolescent_mode) mode = "text"; // 青少年模式隐藏 Scene
    endEditTransaction(); // 模式切换结束上一次编辑会话
    workbenchMode = mode;
    switcher?.querySelectorAll("[data-prompt-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.promptMode === mode);
      if (button.dataset.promptMode === "scene") button.hidden = !!userSettings.adolescent_mode;
    });
    const isText = mode === "text";
    const isVisual = mode === "visual";
    const isScene = mode === "scene";
    // Base / C1 / C2 是 Generate 工作台的持久正面目标栏；UC 仍仅由 Text Prompt/UC pane 控制。
    $("#nai-editor").hidden = !isText;
    $(".nai-prompt-meta")?.toggleAttribute("hidden", !isText);
    $("#nai-free-text-collapse")?.toggleAttribute("hidden", !isText);
    document.querySelector(".nai-tabs")?.toggleAttribute("hidden", !isText);
    $("#nai-character-tabs")?.removeAttribute("hidden");
    $("#nai-character-list")?.toggleAttribute("hidden", !isText);
    $("#tag-assistant-root").hidden = !isText;
    // Visual / Scene 独占
    $("#visual-prompt-root").hidden = !isVisual;
    $("#nsfw-builder-root").hidden = !isScene;
    if (isText) renderWorkbenchEditorFromDocument({ force: true });
  };
  switcher?.addEventListener("click", (event) => { const button = event.target.closest("[data-prompt-mode]"); if (button) setMode(button.dataset.promptMode); });
  setMode("text");
  window.WorkbenchMode = { set: setMode };
  // PromptDocument 变化 → 单一编辑器回流：编辑器聚焦时由 GUARD 跳过，避免打字被重写。
  window.PromptBridge.subscribe(() => renderWorkbenchEditorFromDocument());
}

async function loadPromptSections() {
  try {
    const data = await api("/api/prompt/sections");
    if (Array.isArray(data.sections) && data.sections.length) {
      promptSections = data.sections.filter((s) => SECTION_IDS.includes(s.id)).map((s) => ({ id: s.id, label: s.label || SECTION_LABELS[s.id] }));
    }
  } catch { /* 后端升级期间使用内置分类 */ }
}

// 加载时从后端 tag_section_override 回填购物车条目分区：用户显式选择过的分区以覆盖表为准，
// 即使本地草稿缺失/过期（如旧版草稿、清过站点数据、跨浏览器），刷新后仍归到所选分区。
async function loadSectionOverrides() {
  try {
    const data = await api("/api/prompt/section-overrides");
    const raw = data.overrides || {};
    const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([tag, section]) => ({ tag, section }));
    const byTag = new Map();
    list.forEach((o) => { if (SECTION_IDS.includes(o.section)) byTag.set(String(o.tag).toLowerCase(), o.section); });
    if (!byTag.size) return;
    // 覆盖与草稿冲突时以覆盖为准：把条目从草稿分区物理移入覆盖分区（只移动，不改写其它字段）
    const apply = (sections) => {
      const moves = [];
      SECTION_IDS.forEach((sid) => (sections[sid] || []).forEach((e) => {
        const s = byTag.get(String(e.tag).toLowerCase());
        if (s && s !== sid) moves.push({ entry: e, from: sid, to: s });
      }));
      moves.forEach((m) => {
        sections[m.from] = sections[m.from].filter((e) => e !== m.entry);
        m.entry.section = m.to;
        sections[m.to].push(m.entry);
      });
    };
    apply(state.prompt.sections);
    apply(state.prompt.global_uc_sections);
    state.prompt.characters.forEach((ch) => { apply(ch.prompt_sections); apply(ch.uc_sections); });
  } catch { /* 后端不可用时保持草稿分区 */ }
}

async function loadZh() {
  const data = await api("/api/zh");
  zhMap = data.zh || {};
}

async function loadTaxonomy() {
  const data = await api("/api/catalog");
  catalogGroups = data.groups;
  collapsedGroups.clear();
  catalogGroups.forEach((g) => { if (g.collapsed) collapsedGroups.add(g.id); });
  renderTree();
  // 默认进入普通标签目录，收藏和最近通过标签超市二级导航进入。
  const first = catalogGroups.flatMap((group) => group.children || []).find((item) => {
    const label = String(item.label || "");
    return !label.includes("收藏") && !label.includes("最近");
  }) || catalogGroups[0]?.children?.[0];
  if (first) openCatalog(first.id);
}

async function loadFavorites() {
  const data = await api("/api/favorites");
  state.favorites = new Set(data.favorites.map((f) => f.tag));
}

async function loadRecent() {
  const data = await api("/api/recent");
  state.recent = data.recent.map((r) => r.tag);
}

// ===== 目录树 =====
let catalogGroups = [];   // 从 /api/catalog 加载
let activeCatalogId = null;
let currentPage = 1;
let sortMode = "hot";     // hot | preference
const collapsedGroups = new Set();  // 折叠的一级目录（初始取后端 collapsed 标记）

// ===== 浏览位置记忆（切标签回来时回到原来看的地方） =====
const viewScrolls = { browse: 0, favorites: 0, recent: 0, gallery: 0 };  // 各视图滚动位置
let browseSnapshot = null;  // 离开「分类浏览」时保存 {catalogId, page, sort, query, scrollTop}
const navHistory = [];      // 浏览历史栈：{catalogId, page, query, scrollTop}
const NAV_MAX = 30;
let pendingScroll = null;   // 异步渲染完成后要恢复的滚动位置
let reviewSavedGridScrollTop = 0;  // 进入图库审阅前保存的网格滚动位置（退出审阅后恢复）
let contentRequestSeq = 0;  // 丢弃过期的分类/搜索响应
let showingSearchResults = false;  // 主标签列表当前展示的是搜索结果（可能出现在 favorites/recent 视图内）

function renderTree() {
  const el = $("#category-tree");
  let html = "";
  for (const g of catalogGroups) {
    const collapsed = collapsedGroups.has(g.id);
    html += `<div class="tree-group ${collapsed ? "collapsed" : ""}" data-group="${esc(g.id)}">` +
      `<span class="tree-group-label">${esc(g.icon)} ${esc(g.label)}</span>` +
      `<span class="tree-toggle">${collapsed ? "▸" : "▾"}</span></div>`;
    if (!collapsed) {
      html += `<div class="tree-children">` + g.children.map((c) =>
        `<div class="cat-item ${activeCatalogId === c.id ? "active" : ""}" data-cid="${esc(c.id)}">` +
        `<span>${esc(c.label)}</span></div>`
      ).join("") + `</div>`;
    }
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-group]").forEach((n) =>
    n.addEventListener("click", () => {
      const gid = n.dataset.group;
      if (collapsedGroups.has(gid)) collapsedGroups.delete(gid);
      else collapsedGroups.add(gid);
      renderTree();
    })
  );
  el.querySelectorAll("[data-cid]").forEach((n) =>
    n.addEventListener("click", () => openCatalog(n.dataset.cid))
  );
}

async function openCatalog(cid, page = 1, opts = {}) {
  const requestId = ++contentRequestSeq;
  state.view = "browse";
  setViewTab("browse");
  const data = await api(`/api/catalog/${encodeURIComponent(cid)}/tags?page=${page}&page_size=40&sort=${sortMode}`);
  if (requestId !== contentRequestSeq) return;
  activeCatalogId = cid;
  currentPage = page;
  renderTree();
  state.currentCatalog = data;
  $("#browse-title").textContent = `${data.label}（${data.total.toLocaleString()} 个）`;
  renderCatalogTags(data);
  renderPagination(data);
  if (!opts.noHistory) pushNav(cid, page, "");
  if (opts.scrollTop != null) pendingScroll = opts.scrollTop;
  if (pendingScroll != null) {
    const st = pendingScroll; pendingScroll = null;
    requestAnimationFrame(() => { $("#tag-list").scrollTop = st; });
  }
}

function tagCardHtml(t) {
  const fav = state.favorites.has(t.tag);
  const meta = t.post_count ? `Danbooru posts: ${t.post_count.toLocaleString()}` : (t.is_deprecated ? "deprecated" : "");
  const abbrev = t.post_count ? abbreviateCount(t.post_count) : "";
  return `<div class="tag-card ${t.is_deprecated ? "tag-deprecated" : ""}" data-tag="${esc(t.tag)}">` +
    `<div class="tag-thumb-wrap" data-thumb-wrap="${esc(t.tag)}"><img class="tag-thumb" data-thumb="${esc(t.tag)}" alt="" loading="lazy" decoding="async" /></div>` +
    `<div class="tag-example-controls" data-example-controls="${esc(t.tag)}"></div>` +
    `<button class="fav-toggle ${fav ? "on" : ""}" data-fav="${esc(t.tag)}" title="${fav ? "取消收藏" : "收藏"}">${fav ? "★" : "☆"}</button>` +
    `<div class="tag-en">${esc(t.tag)}</div>` +
    (t.zh ? `<div class="tag-zh">${esc(t.zh)}</div>` : "") +
    (abbrev ? `<div class="tag-count" title="Danbooru posts: ${esc(String(t.post_count.toLocaleString()))}">${esc(abbrev)}</div>` : "") +
    `<div class="tag-meta">${esc(meta || "General")}</div>` +
    `<span class="tag-add-hint" aria-hidden="true">+</span>` +
    (t.match_reason ? `<div class="match-reason">${esc(t.match_reason)}</div>` : "") +
    `</div>`;
}

function renderPagination(data) {
  const el = $("#pagination");
  if (!data || data.pages <= 1) { el.innerHTML = ""; return; }
  let html = `<button data-pg="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? "disabled" : ""}>上一页</button>`;
  for (let p = 1; p <= data.pages; p++) {
    if (p === data.page || p === 1 || p === data.pages || Math.abs(p - data.page) <= 2) {
      html += `<button class="${p === data.page ? "active" : ""}" data-pg="${p}">${p}</button>`;
    } else if (p === 2 || p === data.pages - 1) {
      html += `<span class="pg-ellipsis">…</span>`;
    }
  }
  html += `<button data-pg="${Math.min(data.pages, data.page + 1)}" ${data.page >= data.pages ? "disabled" : ""}>下一页</button>`;
  el.innerHTML = html;
  el.querySelectorAll("button[data-pg]:not([disabled])").forEach((n) =>
    n.addEventListener("click", () => openCatalog(activeCatalogId, +n.dataset.pg))
  );
}

// ===== 浏览历史栈与返回键 =====
function rememberCurrentScroll() {
  const last = navHistory[navHistory.length - 1];
  if (last) last.scrollTop = $("#tag-list").scrollTop;
}

function pushNav(cid, page, query, noHistory) {
  if (noHistory) { updateBackBtn(); return; }
  rememberCurrentScroll();
  const last = navHistory[navHistory.length - 1];
  const same = last && last.catalogId === cid && last.page === page && (last.query || "") === (query || "");
  if (!same) {
    navHistory.push({ catalogId: cid, page, query: query || "", scrollTop: 0 });
    if (navHistory.length > NAV_MAX) navHistory.shift();
  }
  updateBackBtn();
}

function updateBackBtn() {
  const btn = $("#back-btn");
  if (!btn) return;
  const canReturnToBrowse = state.view !== "browse" && browseSnapshot;
  btn.style.display = navHistory.length > 1 || canReturnToBrowse ? "inline-block" : "none";
}

function goBack() {
  if (state.view !== "browse" && browseSnapshot) {
    showView("browse");
    return;
  }
  if (navHistory.length <= 1) return;
  navHistory.pop();  // 当前位置出栈
  const pos = navHistory[navHistory.length - 1];
  const q = pos.query || "";
  $("#search-input").value = q;
  if (q.trim()) {
    pendingScroll = pos.scrollTop || 0;
    runSearch(q, { noHistory: true });
  } else if (pos.catalogId) {
    pendingScroll = pos.scrollTop || 0;
    openCatalog(pos.catalogId, pos.page, { noHistory: true });
  }
  updateBackBtn();
}

function renderTagCards(tags) {
  const el = $("#tag-list");
  tags.forEach((t) => { if (t?.tag) knownCatalogTags.set(String(t.tag).toLocaleLowerCase(), String(t.tag)); });
  if (!tags.length) { el.innerHTML = `<div class="empty">暂无标签</div>`; return; }
  el.innerHTML = tags.map(tagCardHtml).join("");
  el.querySelectorAll(".tag-card").forEach((n) =>
    n.addEventListener("click", () => addTagToTarget(n.dataset.tag))
  );
  el.querySelectorAll(".fav-toggle").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(b.dataset.fav); })
  );
  refreshExampleControls(tags.map((t) => t.tag));
  observeVisibleThumbs();
  loadNovelAIExamples(tags.map((t) => t.tag));
}

// ===== 例图懒加载 =====
const thumbMap = {};   // tag -> 网上缩略图本地 URL
const largeMap = {};   // tag -> 网上大图本地 URL
const novelaiExampleMap = {}; // tag -> NovelAI 标签例图记录
const EXAMPLE_SOURCE_KEY = "tag_example_source_v1";
let exampleSourceByTag = {};
let novelaiExamplePending = new Set();
let novelaiExampleErrors = {};
let thumbLoadSeq = 0;
let thumbLoadState = null;
let thumbObserver = null;
let thumbObserveTimer = null;
let thumbObserveQueue = new Set();

try {
  const savedSources = JSON.parse(localStorage.getItem(EXAMPLE_SOURCE_KEY) || "{}");
  if (savedSources && typeof savedSources === "object") {
    exampleSourceByTag = Object.fromEntries(Object.entries(savedSources).filter(([, source]) => source === "web" || source === "novelai"));
  }
} catch {
  exampleSourceByTag = {};
}

function persistExampleSources() {
  try { localStorage.setItem(EXAMPLE_SOURCE_KEY, JSON.stringify(exampleSourceByTag)); } catch { /* 隐私模式下忽略本地持久化失败 */ }
}

function exampleSource(tag) {
  const selected = exampleSourceByTag[tag];
  if (selected === "web" || selected === "novelai") return selected;
  return novelaiExampleMap[tag]?.file_url ? "novelai" : "web";
}

function exampleHasNovelAI(tag) {
  return !!novelaiExampleMap[tag]?.file_url;
}

function legacyExamplePrompt(tag) {
  // 兼容仍在运行的旧版 Python 服务：新版服务会忽略该字段，改由后端
  // 根据 taxonomy 强制决定 safe/nsfw；旧服务则至少能收到同等的默认提示词。
  const catalog = state.currentCatalog || {};
  const isNsfw = catalog.kind === "restricted_taxonomy" || /nsfw|成人/i.test(String(catalog.label || ""));
  return `{{${tag}}}, ${isNsfw ? "nsfw" : "safe"}, masterpiece, best quality, very aesthetic, absurdres`;
}

function exampleErrorText(error) {
  const raw = String(error?.message || error || "生成失败");
  const describe = (value) => {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(describe).filter(Boolean).join("；");
    if (typeof value === "object") {
      for (const key of ["message", "error", "detail", "reason", "code"]) {
        const text = describe(value[key]);
        if (text) return text;
      }
      try { return JSON.stringify(value); } catch { return "未提供可读错误详情"; }
    }
    return String(value);
  };
  try {
    const parsed = JSON.parse(raw);
    return describe(parsed.detail ?? parsed.error ?? parsed.message ?? parsed).slice(0, 180);
  } catch {
    return raw.replace(/^Error:\s*/i, "").slice(0, 180);
  }
}

function renderExampleControls(tag) {
  const box = document.querySelector(`[data-example-controls="${cssEsc(tag)}"]`);
  if (!box) return;
  const pending = novelaiExamplePending.has(tag);
  const hasNovelAI = exampleHasNovelAI(tag);
  const error = novelaiExampleErrors[tag];
  if (pending) {
    box.innerHTML = `<span class="example-status generating">NovelAI 生成中…</span>`;
    return;
  }
  if (!hasNovelAI) {
    box.innerHTML = `<button type="button" class="example-generate-btn" title="会调用官方生图接口并消耗 Anlas" data-example-action="generate" data-example-tag="${esc(tag)}">${error ? "重试 NovelAI 例图" : "生成 NovelAI 例图"}</button>` +
      (error ? `<span class="example-status error" title="${esc(error)}">${esc(error)}</span>` : "");
    return;
  }
  const source = exampleSource(tag);
  box.innerHTML = `<div class="example-source-row" role="group" aria-label="${esc(tag)} 例图来源">` +
    `<button type="button" class="example-source-btn ${source === "web" ? "active" : ""}" data-example-action="source" data-example-source="web" data-example-tag="${esc(tag)}">网上</button>` +
    `<button type="button" class="example-source-btn ${source === "novelai" ? "active" : ""}" data-example-action="source" data-example-source="novelai" data-example-tag="${esc(tag)}">NovelAI</button>` +
    `<button type="button" class="example-generate-btn" title="覆盖当前 NovelAI 例图并消耗 Anlas" data-example-action="regenerate" data-example-tag="${esc(tag)}">重新生成</button>` +
    `<span class="example-status cached">已缓存</span></div>`;
}

function refreshExampleControls(tags = null) {
  const names = tags || [...document.querySelectorAll("[data-example-controls]")].map((el) => el.dataset.exampleControls);
  [...new Set(names.filter(Boolean))].forEach((tag) => {
    renderExampleControls(tag);
    const box = document.querySelector(`[data-example-controls="${cssEsc(tag)}"]`);
    if (box) bindExampleControls(box);
  });
}

function setExampleSource(tag, source, { persist = true } = {}) {
  if (source !== "web" && source !== "novelai") return;
  if (source === "novelai" && !exampleHasNovelAI(tag)) return;
  exampleSourceByTag[tag] = source;
  if (persist) persistExampleSources();
  refreshExampleControls([tag]);
  applyThumbs();
  if (source === "web" && !thumbMap[tag] && !largeMap[tag]) loadThumbs([tag]);
}

async function generateNovelAIExample(tag, { force = false } = {}) {
  if (novelaiExamplePending.has(tag) || (!force && exampleHasNovelAI(tag))) return;
  if (userSettings.novelai_example_credit_warning !== false
    && !confirm(`${force ? "重新生成会覆盖当前 NovelAI 标签例图" : "生成 NovelAI 标签例图"}，并可能调用官方生图接口、使用 Anlas。确定继续吗？`)) return;
  novelaiExamplePending.add(tag);
  delete novelaiExampleErrors[tag];
  refreshExampleControls([tag]);
  try {
    const data = await api(`/api/novelai-examples/${encodeURIComponent(tag)}`, {
      method: "POST",
      body: JSON.stringify({ prompt: legacyExamplePrompt(tag), confirm_anlas: true, force }),
    });
    if (!data.example?.file_url) throw new Error("服务未返回标签例图地址");
    novelaiExampleMap[tag] = data.example;
    setExampleSource(tag, "novelai");
    toast(data.cached ? "已命中 NovelAI 标签例图缓存" : force ? "NovelAI 标签例图已重新生成" : "NovelAI 标签例图已生成");
  } catch (error) {
    novelaiExampleErrors[tag] = exampleErrorText(error);
    toast(`NovelAI 例图生成失败：${novelaiExampleErrors[tag]}`);
  } finally {
    novelaiExamplePending.delete(tag);
    refreshExampleControls([tag]);
    applyThumbs();
  }
}

function bindExampleControls(root) {
  root.querySelectorAll("[data-example-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const tag = button.dataset.exampleTag;
      if (button.dataset.exampleAction === "generate") generateNovelAIExample(tag);
      else if (button.dataset.exampleAction === "regenerate") generateNovelAIExample(tag, { force: true });
      else if (button.dataset.exampleAction === "source") setExampleSource(tag, button.dataset.exampleSource);
    });
  });
}

async function loadNovelAIExamples(tags) {
  const unique = [...new Set(tags.filter(Boolean))];
  if (!unique.length) return;
  try {
    const data = await api(`/api/novelai-examples?tags=${encodeURIComponent(unique.join(","))}`);
    Object.assign(novelaiExampleMap, data.examples || {});
    Object.keys(data.examples || {}).forEach((tag) => delete novelaiExampleErrors[tag]);
    refreshExampleControls(unique);
    applyThumbs();
  } catch {
    // NovelAI 缓存查询失败不影响网上例图加载和浏览。
  }
}

// 卡片默认显示缩略图（小、加载快）；悬停预览时才用大图（清晰）
function cardImgUrl(tag) {
  if (exampleSource(tag) === "novelai" && novelaiExampleMap[tag]?.file_url) return novelaiExampleMap[tag].file_url;
  return thumbMap[tag] || largeMap[tag] || "";
}

function cardLargeUrl(tag) {
  if (exampleSource(tag) === "novelai" && novelaiExampleMap[tag]?.file_url) return novelaiExampleMap[tag].file_url;
  return largeMap[tag] || thumbMap[tag] || "";
}

function updateThumbProgress() {
  const s = thumbLoadState;
  const box = $("#thumb-load-status");
  if (!s || !box) return;
  const done = s.loaded.size + s.failed.size;
  const pct = s.total ? Math.round(done / s.total * 100) : 100;
  box.hidden = false;
  $("#thumb-load-count").textContent = `${s.loaded.size} / ${s.total}`;
  $("#thumb-load-bar").style.width = pct + "%";
  if (done >= s.total) {
    $("#thumb-load-text").textContent = s.failed.size ? `例图加载完成（${s.failed.size} 个暂无图片）` : "例图加载完成";
    setTimeout(() => { if (thumbLoadState === s) box.hidden = true; }, 1800);
  } else {
    $("#thumb-load-text").textContent = `正在加载例图…${pct}%`;
  }
}

function observeVisibleThumbs() {
  thumbObserver?.disconnect();
  thumbObserver = null;
  clearTimeout(thumbObserveTimer);
  thumbObserveQueue.clear();
  const list = $("#tag-list");
  const images = [...document.querySelectorAll("img[data-thumb]")];
  if (!images.length) return;
  const queue = (tags) => {
    tags.forEach((tag) => {
      if (tag && !cardImgUrl(tag)) thumbObserveQueue.add(tag);
    });
    clearTimeout(thumbObserveTimer);
    thumbObserveTimer = setTimeout(() => {
      const tagsToLoad = [...thumbObserveQueue];
      thumbObserveQueue.clear();
      if (tagsToLoad.length) loadThumbs(tagsToLoad);
    }, 40);
  };
  if (!("IntersectionObserver" in window)) {
    queue(images.map((image) => image.dataset.thumb));
    return;
  }
  thumbObserver = new IntersectionObserver((entries) => {
    const tags = [];
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      thumbObserver?.unobserve(entry.target);
      tags.push(entry.target.dataset.thumb);
    });
    queue(tags);
  }, { root: list, rootMargin: "280px 0px" });
  images.forEach((image) => thumbObserver.observe(image));
}

async function loadThumbs(tags, attempt = 0, seq = null) {
  const unique = [...new Set(tags)];
  if (seq == null) {
    seq = ++thumbLoadSeq;
    thumbLoadState = { seq, total: unique.length, loaded: new Set(), failed: new Set() };
    updateThumbProgress();
  }
  if (seq !== thumbLoadSeq) return;
  const missing = unique.filter((t) => !cardImgUrl(t));
  if (!missing.length) { applyThumbs(seq); return; }
  const batches = [];
  for (let i = 0; i < missing.length; i += 40) batches.push(missing.slice(i, i + 40));
  for (let i = 0; i < batches.length; i += 4) {
    if (seq !== thumbLoadSeq) return;
    await Promise.all(batches.slice(i, i + 4).map(async (batch) => {
      try {
        const data = await api(`/api/thumbs?tags=${encodeURIComponent(batch.join(","))}`);
        Object.assign(thumbMap, data.thumbs || {});
        Object.assign(largeMap, data.large || {});
      } catch { /* 忽略短时网络错误，下一轮继续 */ }
    }));
    applyThumbs(seq);
  }
  const stillMissing = unique.filter((t) => !cardImgUrl(t));
  if (stillMissing.length && attempt < 5 && seq === thumbLoadSeq) {
    const delay = [900, 1400, 2200, 3200, 4500][attempt] || 4500;
    setTimeout(() => loadThumbs(unique, attempt + 1, seq), delay);
  } else if (stillMissing.length && seq === thumbLoadSeq) {
    stillMissing.forEach((tag) => {
      thumbLoadState.failed.add(tag);
      document.querySelector(`[data-thumb-wrap="${cssEsc(tag)}"]`)?.classList.add("failed");
    });
    updateThumbProgress();
  }
}

function applyThumbs(seq = thumbLoadSeq) {
  if (seq !== thumbLoadSeq) return;
  document.querySelectorAll("img[data-thumb]").forEach((img) => {
    const tag = img.dataset.thumb;
    const url = cardImgUrl(tag);
    if (!url) {
      img.removeAttribute("src");
      delete img.dataset.srcApplied;
      img.classList.remove("loaded");
      img.closest(".tag-thumb-wrap")?.classList.remove("loaded");
      return;
    }
    if (img.dataset.srcApplied === url) return;
    img.dataset.srcApplied = url;
    // 网图片加载失败会收起缩略图容器；切换到 NovelAI（或重试）时，
    // 必须立即解除该状态，否则新图即使加载成功也会被 height: 0 隐藏。
    const wrap = img.closest(".tag-thumb-wrap");
    img.classList.remove("loaded");
    wrap?.classList.remove("loaded", "failed");
    img.onload = () => {
      if (seq !== thumbLoadSeq) return;
      img.classList.add("loaded");
      wrap?.classList.remove("failed");
      wrap?.classList.add("loaded");
      thumbLoadState?.loaded.add(tag);
      thumbLoadState?.failed.delete(tag);
      updateThumbProgress();
    };
    img.onerror = () => {
      if (seq !== thumbLoadSeq) return;
      // 失效缩略图不能把容器永久折叠：清除坏 URL，优先回退到 large，
      // 并只允许一次 fallback，之后交给 loadThumbs 的有限轮询重新获取。
      const fallback = largeMap[tag] && largeMap[tag] !== url ? largeMap[tag] : "";
      if (fallback && !img.dataset.thumbFallback) {
        img.dataset.thumbFallback = "1";
        delete img.dataset.srcApplied;
        img.classList.remove("loaded");
        wrap?.classList.remove("failed");
        img.src = fallback;
        return;
      }
      delete img.dataset.srcApplied;
      delete img.dataset.thumbFallback;
      if (thumbMap[tag] === url) delete thumbMap[tag];
      if (largeMap[tag] === url) delete largeMap[tag];
      thumbLoadState?.failed.add(tag);
      wrap?.classList.remove("failed");
      updateThumbProgress();
      // 让后端清理失效行并重新抓取一次；attempt=5 到达现有重试上限，
      // 避免损坏远端资源造成无限请求循环。
      if (tag && seq === thumbLoadSeq) setTimeout(() => loadThumbs([tag], 5, seq), 250);
    };
    delete img.dataset.thumbFallback;
    img.src = url;
  });
}

// ===== hover 大图浮层 =====
let previewTimer = null;

function showThumbPreview(tag, anchor, delayed = false) {
  const url = cardLargeUrl(tag);
  if (!url) return;
  clearTimeout(previewTimer);
  const delay = cartAdvanced ? 130 : 0;
  if (delay && !delayed) { previewTimer = setTimeout(() => showThumbPreview(tag, anchor, true), delay); return; }
  const box = $("#thumb-preview");
  const img = $("#thumb-preview-img");
  const label = $("#thumb-preview-tag");
  img.src = url;
  label.textContent = tag;
  box.style.display = "block";
  // 定位到卡片附近：默认出现在卡片右侧，视口不够则左侧
  const r = anchor.getBoundingClientRect();
  const boxW = Math.min(420, window.innerWidth - 24);
  let left = r.right + 12;
  if (left + boxW > window.innerWidth - 8) left = Math.max(8, r.left - boxW - 12);
  let top = r.top - 10;
  if (top < 8) top = 8;
  if (top + 300 > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 308);
  box.style.left = left + "px";
  box.style.top = top + "px";
  box.style.width = boxW + "px";
}

function hideThumbPreview() {
  // 延迟隐藏，允许鼠标移入浮层本身查看
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const box = $("#thumb-preview");
    if (!box.matches(":hover")) box.style.display = "none";
  }, 120);
}

function bindThumbPreview() {
  const list = $("#tag-list");
  list.addEventListener("mouseover", (e) => {
    const card = e.target.closest(".tag-card");
    const img = e.target.closest("img[data-thumb]");
    if (card && (cartAdvanced || img)) showThumbPreview(card.dataset.tag || img?.dataset.thumb, card);
  });
  list.addEventListener("mouseout", (e) => {
    const card = e.target.closest(".tag-card");
    if (card) hideThumbPreview();
  });
  const box = $("#thumb-preview");
  box.addEventListener("mouseenter", () => clearTimeout(previewTimer));
  box.addEventListener("mouseleave", () => hideThumbPreview());
}
bindThumbPreview();

function renderCatalogTags(data) {
  showingSearchResults = false;
  renderTagCards(data.tags.map((t) => ({ tag: t.tag, zh: t.zh, post_count: t.post_count, is_deprecated: t.is_deprecated })));
}

function renderSearchResults(results) {
  showingSearchResults = true;
  $("#browse-title").textContent = `搜索结果`;
  renderTagCards(results.map((r) => ({ tag: r.tag, zh: r.zh, post_count: r.post_count, favorite: r.favorite, match_reason: r.match_reason || r.match_type, section: r.section, is_deprecated: r.is_deprecated })));
}

// ===== PromptState V2 渲染 =====
function getSectionMap(key) {
  return promptDocument.getTargetSections(state.prompt, key);
}
function getSlot(key) { return promptDocument.getTargetEntries(state.prompt, key).map((e) => ({ ...e, strength: e.weight === 1 ? null : e.weight, brackets: 0, relation: null })); }
function findEntry(slotKey, entryId) {
  const sections = getSectionMap(slotKey);
  if (!sections) return null;
  for (const section of SECTION_IDS) {
    const index = sections[section].findIndex((e) => e.id === entryId);
    if (index >= 0) return { entry: sections[section][index], sections, section, index };
  }
  return null;
}
function sectionOptions(selected) { return promptSections.map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${esc(s.label)}</option>`).join(""); }
function entryHtml(e, slotKey) {
  const zh = zhMap[e.tag] || "";
  return `<div class="entry tag-chip" data-slot="${esc(slotKey)}" data-entry-id="${esc(e.id)}">` +
    `<span class="tag" title="${esc(zh)}">${esc(e.tag)}</span>` +
    (zh ? `<span class="zh">${esc(zh)}</span>` : "") +
    `<button class="weight-toggle" title="调整权重">${Number(e.weight || 1).toFixed(1)}</button>` +
    `<div class="weight-popover" hidden><button data-weight="0.8">弱 0.8</button><button data-weight="1">普通 1.0</button><button data-weight="1.2">强 1.2</button><span></span><button data-step="-0.05">−</button><input type="number" data-weight-input step="0.05" min="0.1" max="2" value="${Number(e.weight || 1).toFixed(2)}" aria-label="输入权重" /><strong>${Number(e.weight || 1).toFixed(2)}</strong><button data-step="0.05">+</button></div>` +
    `<select class="section-select" title="移到分类">${sectionOptions(e.section)}</select>` +
    `<button title="删除" class="del">×</button></div>`;
}
function sectionDetailsHtml(sections, slotKey) {
  return promptSections.map(({ id, label }) => {
    const entries = sections[id] || [];
    const groups = new Map();
    entries.forEach((e) => { if (e.bundle_id) groups.set(String(e.bundle_id), { name: e.bundle_name || "标签模板", count: entries.filter((x) => String(x.bundle_id) === String(e.bundle_id)).length }); });
    let lastBundle = null;
    const chips = entries.map((e) => {
      const group = e.bundle_id && String(e.bundle_id) !== lastBundle ? `<div class="bundle-marker">[${esc(e.bundle_name || "标签模板")} · ${groups.get(String(e.bundle_id))?.count || 1} tags]</div>` : "";
      lastBundle = e.bundle_id ? String(e.bundle_id) : null;
      return group + entryHtml(e, slotKey);
    }).join("");
    return `<details class="prompt-section" data-section="${id}" ${DEFAULT_OPEN_SECTIONS.has(id) ? "open" : ""}><summary><span>${esc(label)}</span><span>${entries.length}</span></summary><div class="prompt-section-body">${chips || `<div class="section-empty">暂无 Tag</div>`}</div></details>`;
  }).join("");
}

function compactEntryHtml(entry, slotKey, prefix = "") {
  const zh = zhMap[entry.tag] || "";
  return `<span class="compact-tag" title="${esc(`${prefix}${entry.tag}${zh ? ` · ${zh}` : ""}`)}">` +
    (prefix ? `<small class="compact-origin">${esc(prefix)}</small>` : "") +
    `<span class="compact-tag-copy"><b>${esc(entry.tag)}</b>${zh ? `<small class="compact-zh">${esc(zh)}</small>` : ""}</span>` +
    `<button type="button" data-compact-remove="${esc(entry.id)}" data-compact-slot="${esc(slotKey)}" aria-label="删除 ${esc(entry.tag)}">×</button></span>`;
}

function compactEntriesHtml() {
  const groups = [{ slot: "base", label: "", entries: flattenSections(state.prompt.sections) }];
  state.prompt.characters.forEach((character, index) => groups.push({
    slot: `char:${index}`, label: character.name || `角色 ${index + 1}`, entries: flattenSections(character.prompt_sections),
  }));
  const entries = groups.flatMap((group) => group.entries.map((entry) => compactEntryHtml(entry, group.slot, group.label)));
  return entries.length ? entries.join("") : `<div class="compact-empty">从左侧点选标签，即可加入 Prompt</div>`;
}

function compactUcHtml() {
  const groups = [{ slot: "global_uc", label: "", entries: flattenSections(state.prompt.global_uc_sections) }];
  state.prompt.characters.forEach((character, index) => groups.push({
    slot: `char:${index}:uc`, label: character.name || `角色 ${index + 1}`, entries: flattenSections(character.uc_sections),
  }));
  const entries = groups.flatMap((group) => group.entries.map((entry) => compactEntryHtml(entry, group.slot, group.label)));
  return entries.length ? entries.join("") : `<div class="compact-empty">暂无 UC 标签</div>`;
}

// ===== Prompt Workspace（高级购物车：Tab + 单一目标编辑器） =====
function targetLabel(target) {
  if (target === "base") return "Base";
  if (target === "global_uc") return "Global UC";
  const m = String(target || "").match(/^char:(\d+)(:uc)?$/);
  if (m) {
    const ch = state.prompt.characters[+m[1]];
    return (ch?.name || `Character ${+m[1] + 1}`) + (m[2] ? " UC" : "");
  }
  return "Base";
}
function workspaceTargetKey() {
  return activeWorkspaceTarget === "base" ? "base" : `char:${activeWorkspaceTarget}`;
}
// 高级工作区 Tab 值（"base" 或角色数字下标字符串）-> state.target 目标字符串。
// 纯函数：Tab 切换必须同步 state.target，否则 addTagToTarget 读取的隐藏 #nai-tag-target
// 仍是旧目标，会把标签加错目标。
function workspaceTabToTarget(tabValue) {
  return String(tabValue) === "base" ? "base" : `char:${Number(tabValue)}`;
}
function workspaceTargetName() {
  if (activeWorkspaceTarget === "base") return "Base";
  const ch = state.prompt.characters[activeWorkspaceTarget];
  return ch?.name || `Character ${Number(activeWorkspaceTarget) + 1}`;
}
function workspacePromptTagsText(key) {
  if (key === "base") return flattenSections(state.prompt.sections).map(weightText).join(", ");
  const m = key.match(/^char:(\d+)$/);
  if (m && state.prompt.characters[+m[1]]) return flattenSections(state.prompt.characters[+m[1]].prompt_sections).map(weightText).join(", ");
  return "";
}
function workspaceFullText(key) {
  const tags = workspacePromptTagsText(key);
  if (key === "base") {
    const ft = effectiveFreeText();
    return ft ? (tags ? `${tags}, ${ft}` : ft) : tags;
  }
  return tags;
}
function workspaceSectionCounts(key) {
  const counts = {};
  SECTION_IDS.forEach((id) => { counts[id] = (getSectionMap(key)?.[id] || []).length; });
  return counts;
}
function workspaceUcKey(key) { return key === "base" ? "global_uc" : `${key}:uc`; }
function workspaceUcCount(key) { return flattenSections(getSectionMap(workspaceUcKey(key)) || {}).length; }
// 把文本中「非标签、非权重、非强调括号」的自由文本提取出来，作为 base 的自然语言补充。
// 绝不丢失自由文本：仅当文本里确实有这类 token 时更新 free_text，且永远不覆盖为更短的内容。
function workspaceFreeTextFromText(text, known) {
  return String(text || "").split(",").map((t) => t.trim()).filter((token) => {
    if (!token) return false;
    if (recognizedTagToken(token, known)) return false;
    if (/^\s*(?:\d+(?:\.\d+)?|\.\d+)::.+::\s*$/.test(token)) return false;
    if (/[{}[\]()<>]/.test(token)) return false;
    return true;
  }).join(", ");
}
function workspaceChipsHtml(key) {
  const sections = getSectionMap(key);
  if (!sections) return `<div class="ws-empty">无可编辑的目标</div>`;
  const ids = workspaceSectionFilter ? [workspaceSectionFilter] : SECTION_IDS;
  let html = "", any = false;
  ids.forEach((id) => {
    const entries = sections[id] || [];
    if (!entries.length && !workspaceShowEmpty && !workspaceSectionFilter) return;
    any = true;
    html += `<div class="ws-section" data-section="${id}"><div class="ws-section-head"><span>${esc(SECTION_LABELS[id])}</span><span>${entries.length}</span></div>` +
      `<div class="ws-section-chips">${entries.map((e) => entryHtml(e, key)).join("") || `<span class="ws-section-empty">暂无 Tag</span>`}</div></div>`;
  });
  return any ? html : `<div class="ws-empty">该目标暂无标签，从左侧标签库点击加入</div>`;
}
function ucChipsHtml(key) {
  const sections = getSectionMap(key);
  const entries = sections ? flattenSections(sections) : [];
  return entries.length ? entries.map((e) => entryHtml(e, key)).join("") : `<span class="ws-section-empty">暂无 UC 标签</span>`;
}
function workspaceFilterHtml(key) {
  const counts = workspaceSectionCounts(key);
  let html = `<button class="ws-filter-chip ${workspaceSectionFilter === "" ? "active" : ""}" data-ws-filter="">全部 ${SECTION_IDS.reduce((s, id) => s + counts[id], 0)}</button>`;
  SECTION_IDS.forEach((id) => {
    if (counts[id]) html += `<button class="ws-filter-chip ${workspaceSectionFilter === id ? "active" : ""}" data-ws-filter="${id}">${esc(SECTION_LABELS[id])} ${counts[id]}</button>`;
  });
  html += `<label class="ws-show-empty"><input type="checkbox" id="ws-show-empty" ${workspaceShowEmpty ? "checked" : ""} /> 显示空分区</label>`;
  return html;
}
function renderWorkspace() {
  const el = $("#cart");
  const key = workspaceTargetKey();
  const isBase = activeWorkspaceTarget === "base";
  let tabs = `<button class="workspace-tab ${activeWorkspaceTarget === "base" ? "active" : ""}" data-ws-tab="base">Base</button>`;
  state.prompt.characters.forEach((ch, i) => {
    tabs += `<button class="workspace-tab ${activeWorkspaceTarget === i ? "active" : ""}" data-ws-tab="${i}">${esc(ch.name || `Character ${i + 1}`)}<span class="workspace-tab-remove" data-ws-rm="${i}" title="移除角色">×</span></button>`;
  });
  tabs += `<button class="workspace-tab workspace-tab-add" data-ws-add title="添加角色">+</button>`;
  const ucCount = workspaceUcCount(key);
  const effectiveText = isBase ? promptPreviewText() : workspacePromptTagsText(key);
  const html =
    `<div class="workspace-tabs">${tabs}</div>` +
    `<div class="workspace-editor">` +
      `<textarea id="ws-prompt" class="ws-prompt" placeholder="${isBase ? "Base prompt：标签 + 自然语言补充…" : "角色提示词…"}">${esc(workspaceFullText(key))}</textarea>` +
      `<div class="ws-section-filter">${workspaceFilterHtml(key)}</div>` +
      `<div class="ws-sections" id="ws-sections">${workspaceChipsHtml(key)}</div>` +
      `<details class="ws-collapse"><summary><span>▸ UC（${ucCount}）</span></summary><div class="ws-collapse-body"><div class="ws-section-chips" id="ws-uc-chips">${ucChipsHtml(workspaceUcKey(key))}</div></div></details>` +
      `<details class="ws-collapse"><summary><span>▸ Effective Prompt</span></summary><div class="ws-collapse-body"><pre id="ws-effective">${esc(effectiveText || "(空)")}</pre></div></details>` +
      (isBase ? `<details class="ws-collapse"><summary><span>▸ 自然语言补充 / 翻译</span></summary><div class="ws-collapse-body"><div class="ws-free-text"><textarea class="free-text-box" id="free-text" placeholder="复杂空间关系 / 连续动作 / 画面意图…">${esc(state.prompt.free_text)}</textarea><div class="free-text-actions"><button type="button" id="free-text-translate">翻译为英语</button><label><input type="checkbox" id="free-text-use-en" ${state.prompt.use_free_text_en ? "checked" : ""} /> 使用英文译文</label></div><textarea class="free-text-box free-text-translation" id="free-text-en" placeholder="英文译文（可编辑）">${esc(state.prompt.free_text_en)}</textarea></div></div></details>` : "") +
    `</div>`;
  el.innerHTML = html;
  bindEntryControls(el);
  if (openWeightEntryId) {
    const openPop = el.querySelector(`.entry[data-entry-id="${cssEsc(openWeightEntryId)}"] .weight-popover`);
    if (openPop) openPop.hidden = false; else openWeightEntryId = null;
  }
  // Prompt 文本域：自动补全 + 识别标签回写（不重建 DOM，避免打字中断）
  const promptEl = $("#ws-prompt");
  bindNaiAutocomplete(promptEl, key);
  promptEl.addEventListener("input", (event) => workspaceSyncDebounced(key, event.target.value));
  // 自由文本（Base 专用）
  if (isBase) {
    freeTextRawSync = debounce((ev) => { state.prompt.free_text = ev.target.value; state.prompt.use_free_text_en = false; commitPromptChange({ render: false }); workspaceRefreshDerived(); }, 180);
    $("#free-text").addEventListener("input", freeTextRawSync);
    $("#free-text-en").addEventListener("input", debounce((ev) => { state.prompt.free_text_en = ev.target.value; commitPromptChange({ render: false }); workspaceRefreshDerived(); }, 180));
    $("#free-text-use-en").addEventListener("change", (ev) => { state.prompt.use_free_text_en = ev.target.checked && !!state.prompt.free_text_en.trim(); commitPromptChange({ render: false }); workspaceRefreshDerived(); });
    $("#free-text-translate").addEventListener("click", translateFreeText);
  }
  // Tab 切换
  el.querySelectorAll("[data-ws-tab]").forEach((b) => b.addEventListener("click", () => {
    activeWorkspaceTarget = b.dataset.wsTab === "base" ? "base" : Number(b.dataset.wsTab);
    state.target = workspaceTabToTarget(b.dataset.wsTab);
    syncNaiTagTargetFromState();
    workspaceSectionFilter = "";
    renderWorkspace();
  }));
  el.querySelectorAll("[data-ws-rm]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); removeCharacter(+b.dataset.wsRm); }));
  el.querySelector("[data-ws-add]")?.addEventListener("click", () => { addCharacter(); activeWorkspaceTarget = state.prompt.characters.length - 1; workspaceSectionFilter = ""; renderWorkspace(); });
  // 分区过滤 / 显示空分区
  bindWorkspaceFilterControls(el);
  updateCartHeader();
}
// 分区过滤 / 显示空分区：workspaceRefreshChips() 会重建这些节点，刷新后必须重新绑定
function bindWorkspaceFilterControls(el) {
  el.querySelectorAll("[data-ws-filter]").forEach((b) => b.addEventListener("click", () => { workspaceSectionFilter = b.dataset.wsFilter; workspaceRefreshChips(); }));
  el.querySelector("#ws-show-empty")?.addEventListener("change", (e) => { workspaceShowEmpty = e.target.checked; workspaceRefreshChips(); });
}
// 打字时的轻量刷新：不重建 textarea，只更新 chips / filter / UC / effective
function workspaceRefreshChips() {
  const el = $("#cart");
  const key = workspaceTargetKey();
  const filterBox = el.querySelector(".ws-section-filter");
  if (filterBox) filterBox.innerHTML = workspaceFilterHtml(key);
  const sectionsBox = el.querySelector("#ws-sections");
  if (sectionsBox) sectionsBox.innerHTML = workspaceChipsHtml(key);
  const ucBox = el.querySelector("#ws-uc-chips");
  if (ucBox) ucBox.innerHTML = ucChipsHtml(workspaceUcKey(key));
  const eff = el.querySelector("#ws-effective");
  if (eff) eff.textContent = ((activeWorkspaceTarget === "base" ? promptPreviewText() : workspacePromptTagsText(key)) || "(空)");
  bindEntryControls(el);
  bindWorkspaceFilterControls(el);
  if (openWeightEntryId) {
    const openPop = el.querySelector(`.entry[data-entry-id="${cssEsc(openWeightEntryId)}"] .weight-popover`);
    if (openPop) openPop.hidden = false; else openWeightEntryId = null;
  }
}
// 自由文本变化后：同步主 textarea 中 free_text 后缀 + effective
function workspaceRefreshDerived() {
  const el = $("#cart");
  if (activeWorkspaceTarget !== "base") return;
  const promptEl = el.querySelector("#ws-prompt");
  if (promptEl && document.activeElement !== promptEl) {
    const tags = workspacePromptTagsText("base");
    const ft = effectiveFreeText();
    promptEl.value = ft ? (tags ? `${tags}, ${ft}` : ft) : tags;
  }
  const eff = el.querySelector("#ws-effective");
  if (eff) eff.textContent = promptPreviewText() || "(空)";
  updatePromptPreview();
}
const workspaceSyncDebounced = debounce((key, text) => workspaceDoSync(key, text), 250);
function workspaceFlushSync() {
  workspaceSyncDebounced.cancel();
  const promptEl = $("#ws-prompt");
  if (promptEl && cartAdvanced) workspaceDoSync(workspaceTargetKey(), promptEl.value);
}
function workspaceDoSync(key, text) {
  if (reconciliationBusy) return;
  const known = new Map(knownCatalogTags);
  (getSlot(key) || []).filter((e) => e.source !== "custom" && !e.custom).forEach((e) => known.set(String(e.tag).toLocaleLowerCase(), e.tag));
  const desired = new Map(String(text || "").split(",").map((token) => recognizedTagToken(token, known)).filter(Boolean).map((item) => [item.key, item]));
  const recognizedText = [...desired.values()].map((item) => item.weight === 1 ? item.tag : `${item.weight}::${item.tag}::`).join(", ");
  const prevText = promptDocument.serializeTarget(state.prompt, key);
  // 单一写路径：只经 PromptBridge.dispatch(RECONCILE_TEXT) 写入 PromptDocument —— dispatch 内
  // 完成 reconcile + commitPromptChange → notifyPromptSubscribers，Visual/Tag Assistant/NSFW 订阅者随通知刷新。
  window.PromptBridge.dispatch({ type: "RECONCILE_TEXT", payload: { target: key, text: key === "base" ? recognizedText : text } });
  const tagsChanged = promptDocument.serializeTarget(state.prompt, key) !== prevText;
  if (key === "base") {
    const ft = workspaceFreeTextFromText(text, known);
    if (ft !== state.prompt.free_text) {
      state.prompt.free_text = ft;
      state.prompt.use_free_text_en = false;
    }
  }
  if (!tagsChanged && key !== "base") return;
  persistDraft();
  syncLegacyProjection();
  // PromptDocument 权威：生图编辑器由订阅者 renderWorkbenchEditorFromDocument 回流，无需旧 sync 链。
  renderWorkbenchEditorFromDocument();
  workspaceRefreshChips();
  refreshPromptServices();
}
function updateCartHeader() {
  const nameEl = $("#cart-target-name");
  if (nameEl) nameEl.textContent = cartAdvanced ? workspaceTargetName() : targetLabel(state.target);
  const preview = $(".prompt-preview-bar");
  if (preview) preview.style.display = cartAdvanced ? "none" : "";
  const legacy = $(".legacy-preset-box");
  if (legacy) legacy.style.display = cartAdvanced ? "none" : "";
  const wsActions = $("#workspace-actions");
  if (wsActions) wsActions.hidden = !cartAdvanced;
}
function renderCompactCart() {
  const el = $("#cart");
  const html = `<section class="compact-cart"><label class="cart-tag-input"><span>添加标签</span><div><input id="cart-tag-input" autocomplete="off" placeholder="输入中文或英文，回车直接加入" /><button id="cart-tag-submit" type="button">添加</button></div><small>输入时会在中间自动查找；回车会加入完全匹配的标签。</small></label><button id="cart-custom-tag" type="button" class="ghost add-custom-btn">＋ 自定义标签</button><div class="compact-cart-head"><strong>Prompt</strong><span>${positivePromptEntries().length} 个标签</span></div><div class="compact-tags">${compactEntriesHtml()}</div>` +
    `<details class="compact-uc"><summary>Undesired Content（${negativePromptEntries().length}）</summary><div class="compact-tags">${compactUcHtml()}</div></details>` +
     `<label class="compact-free-text"><span>自然语言补充</span><textarea class="free-text-box" id="free-text" placeholder="复杂空间关系 / 连续动作 / 画面意图…">${esc(state.prompt.free_text)}</textarea><div class="free-text-actions"><button type="button" id="free-text-translate">翻译为英语</button><label><input type="checkbox" id="free-text-use-en" ${state.prompt.use_free_text_en ? "checked" : ""} /> 使用英文译文</label></div><small class="setting-help">Raw 中文始终保留；英文译文仅在勾选后作为 Effective Prompt。</small><textarea class="free-text-box free-text-translation" id="free-text-en" placeholder="英文译文（可编辑）">${esc(state.prompt.free_text_en)}</textarea></label></section>`;
  el.innerHTML = html;
  bindEntryControls(el);
  if (openWeightEntryId) {
    const openPop = el.querySelector(`.entry[data-entry-id="${cssEsc(openWeightEntryId)}"] .weight-popover`);
    if (openPop) openPop.hidden = false; else openWeightEntryId = null;
  }
  freeTextRawSync = debounce((ev) => { state.prompt.free_text = ev.target.value; state.prompt.use_free_text_en = false; commitPromptChange({ render: false }); updatePromptPreview(); }, 180);
  $("#free-text").addEventListener("input", freeTextRawSync);
  $("#free-text-en").addEventListener("input", debounce((ev) => { state.prompt.free_text_en = ev.target.value; commitPromptChange({ render: false }); updatePromptPreview(); }, 180));
  $("#free-text-use-en").addEventListener("change", (ev) => { state.prompt.use_free_text_en = ev.target.checked && !!state.prompt.free_text_en.trim(); commitPromptChange({ render: false }); updatePromptPreview(); });
  $("#free-text-translate").addEventListener("click", translateFreeText);
  el.querySelectorAll("[data-compact-remove]").forEach((button) => button.addEventListener("click", () => removeEntryById(button.dataset.compactSlot, button.dataset.compactRemove)));
  const cartInput = $("#cart-tag-input");
  const syncMiddleSearch = debounce((value) => {
    $("#search-input").value = value;
    doSearch(value);
  }, 120);
  cartInput.addEventListener("input", () => syncMiddleSearch(cartInput.value.trim()));
  cartInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCartInputTag();
  });
  $("#cart-tag-submit").addEventListener("click", addCartInputTag);
  $("#cart-custom-tag")?.addEventListener("click", openCustomTagModal);
  updatePromptPreview();
}

function renderCart() {
  syncLegacyProjection();
  document.querySelector("main.layout")?.classList.toggle("cart-advanced-layout", cartAdvanced);
  updateCartHeader();
  if (cartAdvanced) { renderWorkspace(); return; }
  renderCompactCart();
}

async function addCartInputTag() {
  const input = $("#cart-tag-input");
  const query = input?.value.trim() || "";
  if (!query) return;
  try {
    const category = $("#cat-filter").value;
    const data = await api(`/api/search?q=${encodeURIComponent(query)}${category ? `&category=${category}` : ""}`);
    renderSearchResults(data.results || []);
    $("#pagination").innerHTML = "";
    const normalized = query.toLocaleLowerCase();
    const exact = (data.results || []).find((item) => String(item.tag || "").toLocaleLowerCase() === normalized || String(item.zh || "") === query);
    if (!exact) {
      toast("已在中间显示匹配标签；请选择要加入的项");
      return;
    }
    await addEntry(exact.tag);
    input.value = "";
    $("#search-input").value = "";
  } catch (error) {
    toast(`查找标签失败：${error.message || error}`);
  }
}
function bindEntryControls(root) {
  root.querySelectorAll(".entry").forEach((node) => {
    const slot = node.dataset.slot, id = node.dataset.entryId;
    const toggle = node.querySelector(".weight-toggle"), pop = node.querySelector(".weight-popover");
    toggle.addEventListener("click", () => {
      if (openWeightEntryId === id) {
        openWeightEntryId = null; pop.hidden = true;
      } else {
        root.querySelectorAll(".weight-popover:not([hidden])").forEach((p) => { if (p !== pop) p.hidden = true; });
        openWeightEntryId = id; pop.hidden = false;
      }
    });
    pop.querySelectorAll("[data-weight]").forEach((b) => b.addEventListener("click", () => setEntryWeight(slot, id, Number(b.dataset.weight))));
    pop.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { const found = findEntry(slot, id); if (found) setEntryWeight(slot, id, Math.max(0.1, Math.min(2, found.entry.weight + Number(b.dataset.step)))); }));
    const weightInput = pop.querySelector("[data-weight-input]");
    weightInput.addEventListener("input", () => {
      // 轻量实时预览：只更新内存权重与面板显示值，不重建 DOM，保证连续键入不失焦
      const found = findEntry(slot, id); if (!found) return;
      const v = Number(weightInput.value);
      if (Number.isFinite(v)) {
        found.entry.weight = Math.max(0.1, Math.min(2, v));
        pop.querySelector("strong").textContent = found.entry.weight.toFixed(2);
      }
    });
    weightInput.addEventListener("change", () => {
      // 回车/失焦提交：clamp[0.1,2]，无效则回退当前值；commit 后 renderCart 由 openWeightEntryId 保持面板打开
      const found = findEntry(slot, id); if (!found) return;
      const v = Number(weightInput.value);
      setEntryWeight(slot, id, Number.isFinite(v) ? Math.max(0.1, Math.min(2, v)) : found.entry.weight);
    });
    node.querySelector(".section-select").addEventListener("change", (e) => moveEntrySection(slot, id, e.target.value));
    node.querySelector(".del").addEventListener("click", () => removeEntryById(slot, id));
  });
}

// ===== 自定义标签（本地词库） =====
function openCustomTagModal() {
  $("#custom-tag-name").value = "";
  $("#custom-tag-note").value = "";
  $("#custom-tag-zh").value = "";
  $("#custom-tag-status").textContent = "";
  $("#custom-tag-modal").style.display = "flex";
  $("#custom-tag-name").focus();
}
function closeCustomTagModal() { $("#custom-tag-modal").style.display = "none"; }

// 纯函数：请求返回时仅当当前文本仍等于请求原文才接受译文（防抖窗口/请求期间原文变化则丢弃）
function shouldAcceptTranslation(requestedRaw, currentRaw) {
  return (currentRaw ?? "").trim() === (requestedRaw ?? "").trim();
}

async function translateFreeText() {
  const btn = $("#free-text-translate");
  const el = $("#free-text");
  const raw = (el?.value ?? state.prompt.free_text).trim();
  if (!raw) { toast("请先填写中文自然语言补充"); return; }
  // 读取当前 DOM 并同步 state，避免防抖窗口内翻译旧文本；改 Raw 即失效旧译文
  if (el && el.value !== state.prompt.free_text) {
    state.prompt.free_text = el.value;
    state.prompt.use_free_text_en = false;
  }
  freeTextRawSync?.cancel(); // 取消 pending 防抖，避免稍后回调把 state/use 标志覆盖回旧值
  btn.disabled = true;
  try {
    const r = await api("/api/translate", { method: "POST", body: JSON.stringify({ text: raw, from: "zh", to: "en" }) });
    // 请求返回时原文已变化：丢弃结果，不覆盖用户更新后的 Raw、不启用旧译文
    if (!shouldAcceptTranslation(raw, $("#free-text")?.value ?? state.prompt.free_text)) {
      toast("原文已变化，翻译结果已丢弃，请重试");
      return;
    }
    state.prompt.free_text_en = r.translated || "";
    state.prompt.use_free_text_en = !!state.prompt.free_text_en;
    commitPromptChange();
    toast("已翻译为英语；Raw 中文仍保留");
  } catch (e) { toast(`翻译失败：${e.message || e}`); }
  finally { btn.disabled = false; }
}

async function translateCustomTag() {
  const btn = $("#custom-tag-translate");
  const tag = $("#custom-tag-name").value.trim();
  if (!tag) { $("#custom-tag-status").textContent = "请先填写英文标签名"; return; }
  btn.disabled = true;
  try {
    const r = await api("/api/translate", { method: "POST", body: JSON.stringify({ text: tag, from: "en", to: "zh" }) });
    $("#custom-tag-zh").value = r.translated || "";
  } catch (e) { $("#custom-tag-status").textContent = `自动翻译失败：${e.message || e}`; }
  finally { btn.disabled = false; }
}

async function submitCustomTag() {
  const nameEl = $("#custom-tag-name");
  const noteEl = $("#custom-tag-note");
  const zhEl = $("#custom-tag-zh");
  const status = $("#custom-tag-status");
  const tag = nameEl.value.trim();
  const note = noteEl.value.trim();
  const zh = zhEl.value.trim();
  if (!tag) { status.textContent = "标签名不能为空"; nameEl.focus(); return; }
  const btn = $("#custom-tag-save");
  btn.disabled = true;
  try {
    await api("/api/user-tags", { method: "POST", body: JSON.stringify({ tag, note, zh }) });
    await addEntry(tag, { custom: true, source: "custom" });
    closeCustomTagModal();
    toast(`已添加自定义标签「${tag}」`);
  } catch (e) {
    status.textContent = e.message || "保存失败";
  } finally {
    btn.disabled = false;
  }
}

async function loadCustomTags() {
  const box = $("#custom-tag-list");
  if (!box) return;
  try {
    const data = await api("/api/user-tags");
    const tags = data.tags || [];
    if (!tags.length) {
      box.innerHTML = `<div class="empty">暂无自定义标签。可在购物车点「＋ 自定义标签」添加。</div>`;
      return;
    }
    box.innerHTML = tags.map((t) =>
      `<div class="custom-tag-row"><span class="ct-tag">${esc(t.tag)}</span>${t.zh ? `<small class="ct-zh">${esc(t.zh)}</small>` : ""}${t.note ? `<small class="ct-note">${esc(t.note)}</small>` : ""}<button class="ghost ct-del" data-tag="${esc(t.tag)}" type="button">删除</button></div>`
    ).join("");
    box.querySelectorAll(".ct-del").forEach((b) => b.addEventListener("click", () => deleteCustomTag(b.dataset.tag)));
  } catch {
    box.innerHTML = `<div class="empty">自定义标签加载失败</div>`;
  }
}

async function deleteCustomTag(tag) {
  if (!confirm(`删除自定义标签「${tag}」？该标签仅从本地词库移除，已加入 Prompt 的条目不受影响。`)) return;
  try {
    await api(`/api/user-tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
    toast(`已删除「${tag}」`);
    loadCustomTags();
  } catch (e) {
    toast(`删除失败：${e.message || e}`);
  }
}

async function editNote(tag) {
  const cur = zhMap[tag] || "";
  const zh = prompt(`给「${tag}」备注中文（留空清除）：`, cur);
  if (zh === null) return;  // 取消
  const val = zh.trim();
  await api("/api/zh-notes", { method: "POST", body: JSON.stringify({ tag, zh: val }) });
  if (val) zhMap[tag] = val; else delete zhMap[tag];
  renderCart();
  refreshCurrentView();
}

// ===== 购物车操作 =====
async function classifyTag(tag) {
  try { const data = await api("/api/prompt/classify", { method: "POST", body: JSON.stringify({ tags: [tag] }) }); return SECTION_IDS.includes(data.items?.[0]?.section) ? data.items[0].section : "other"; }
  catch { return "other"; }
}
async function addEntry(tag, options = {}) {
  const target = options.target || state.target;
  if (!getSectionMap(target)) return false;
  if (getSlot(target).some((e) => e.tag === tag)) { toast(`「${tag}」已在当前位置`); return false; }
  pushHistory();
  const section = options.section || await classifyTag(tag);
  state.prompt = promptDocument.addTag(state.prompt, target, { tag, section, custom: !!options.custom, source: options.source || "tag" }, section);
  api("/api/recent", { method: "POST", body: JSON.stringify({ tag }) }).catch(() => {});
  commitPromptChange();
  return true;
}
function removeEntryById(slot, id) {
  const found = findEntry(slot, id); if (!found) return;
  pushHistory(); state.prompt = promptDocument.removeTag(state.prompt, slot, id); commitPromptChange();
}
function setEntryWeight(slot, id, value) {
  const found = findEntry(slot, id); if (!found) return;
  pushHistory(); found.entry.weight = Number(Number(value).toFixed(2)); commitPromptChange();
}
async function moveEntrySection(slot, id, section) {
  const found = findEntry(slot, id); if (!found || !SECTION_IDS.includes(section) || found.section === section) return;
  pushHistory(); const [entry] = found.sections[found.section].splice(found.index, 1); entry.section = section; found.sections[section].push(entry);
  api("/api/prompt/section-override", { method: "POST", body: JSON.stringify({ tag: entry.tag, section }) }).catch(() => {});
  commitPromptChange();
}
function addCharacter() {
  cartAdvanced = true;
  pushHistory(); state.prompt = promptDocument.addCharacter(state.prompt);
  commitPromptChange(); rebuildTargetSelect();
}
function removeCharacter(i) {
  pushHistory();
  state.target = remapNaiTagTarget(state.target, "remove", i);
  state.prompt = promptDocument.removeCharacter(state.prompt, i);
  if (state.target.startsWith("char:")) { const m = state.target.match(/^char:(\d+)/); if (m && +m[1] >= state.prompt.characters.length) state.target = "base"; }
  // 高级工作区当前 Tab 跟随角色删除
  if (activeWorkspaceTarget !== "base") {
    if (activeWorkspaceTarget === i) activeWorkspaceTarget = "base";
    else if (activeWorkspaceTarget > i) activeWorkspaceTarget -= 1;
    if (activeWorkspaceTarget >= state.prompt.characters.length) activeWorkspaceTarget = "base";
  }
  rebuildTargetSelect(); commitPromptChange();
}

const favoritePending = new Set();  // 正在请求中的 tag，防止同一 tag 快速连点造成并发重复 POST/DELETE

async function toggleFavorite(tag) {
  if (favoritePending.has(tag)) return;  // 该 tag 的收藏请求进行中，忽略本次点击
  favoritePending.add(tag);
  try {
    if (state.favorites.has(tag)) {
      await api(`/api/favorites/${encodeURIComponent(tag)}`, { method: "DELETE" });
      state.favorites.delete(tag);
    } else {
      await api("/api/favorites", { method: "POST", body: JSON.stringify({ tag }) });
      state.favorites.add(tag);
    }
  } finally {
    favoritePending.delete(tag);  // 成功或失败都清除，失败后仍可重试
  }
  if (state.view === "favorites" && !showingSearchResults) {
    // 真正的收藏视图（不含收藏视图内发起的搜索结果）：仅局部重渲染，让取消收藏的卡片从列表消失，不离开当前视图
    const st = $("#tag-list").scrollTop;
    renderFavoritesView();
    $("#tag-list").scrollTop = st;
  } else {
    // 目录浏览 / 搜索结果 / 最近视图：原地更新星标，不重新请求、不清空搜索上下文、不改变 state.view
    updateFavoriteButtons(tag);
  }
}

// 原地更新当前可见的 .fav-toggle 状态（.on class、星标、标题）；页面中有多个相同 tag 卡片时同步
function updateFavoriteButtons(tag) {
  const fav = state.favorites.has(tag);
  document.querySelectorAll(".fav-toggle").forEach((b) => {
    if (b.dataset.fav === tag) {
      b.classList.toggle("on", fav);
      b.textContent = fav ? "★" : "☆";
      b.title = fav ? "取消收藏" : "收藏";
    }
  });
}

function refreshCurrentView() {
  if (state.view === "favorites") {
    const st = $("#tag-list").scrollTop;
    renderFavoritesView();
    $("#tag-list").scrollTop = st;
  } else if (state.view === "recent") {
    const st = $("#tag-list").scrollTop;
    renderRecentView();
    $("#tag-list").scrollTop = st;
  } else if (activeCatalogId) {
    openCatalog(activeCatalogId, currentPage, { noHistory: true, scrollTop: $("#tag-list").scrollTop });
  }
}

function clearAll() {
  if (!confirm("清空整个购物车？")) return;
  pushHistory(); state.prompt = emptyPromptState(); state.target = "base"; rebuildTargetSelect(); commitPromptChange();
}
function undo() {
  const last = state.history.pop(); if (last == null) return;
  const saved = JSON.parse(last); state.prompt = migratePromptState(saved.prompt || saved); if (saved.model) state.model = saved.model;
  rebuildTargetSelect(); commitPromptChange(); renderWorkbenchEditorFromDocument({ force: true });
}
function exportPayload() {
  syncLegacyProjection();
  return { model: state.model, structured_state: state.prompt, base_prompt: state.base, characters: state.characters, global_uc: state.global_uc, free_text: state.free_text };
}
function updatePromptPreview() {
  const text = promptPreviewText();
  $("#prompt-preview-text").textContent = text || "当前 Prompt 为空";
  $("#prompt-preview-meta").textContent = `${positivePromptEntries().length} tags`;
}
// ===== 导出 =====
async function doExport() {
  let text = promptPreviewText();
  try {
    const r = await api("/api/export", { method: "POST", body: JSON.stringify(exportPayload()) });
    text = r.multi_character ? r.structured : (r.flat || text);
    $("#export-text").textContent = text || "(空)";
    const warns = [...(r.conflicts || []).map((x) => `可能冲突：${x}`), ...(r.warnings || [])];
    $("#export-warnings").innerHTML = warns.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
    $("#export-output").style.display = "block";
  } catch { /* 后端升级期间仍可复制本地预览 */ }
  try { await navigator.clipboard.writeText(text); flash("已复制到剪贴板"); } catch { toast("复制失败，请手动选择"); }
}

function flash(msg) {
  toast(msg);
}

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ===== 推荐、冲突、标签模板与快照 =====
async function loadRecommendations() {
  const tags = positivePromptEntries().map((e) => e.tag), box = $("#recommendations"), list = $("#recommendation-list");
  if (!tags.length) { recommendations = []; box.hidden = true; return; }
  try {
    const data = await api("/api/recommendations", { method: "POST", body: JSON.stringify({ tags, limit: 8 }) });
    recommendations = (data.recommendations || []).filter((r) => !tags.includes(r.tag)); box.hidden = !recommendations.length;
    list.innerHTML = recommendations.map((r) => `<button class="recommendation-item" data-tag="${esc(r.tag)}"><span>${esc(r.tag)}</span>${r.zh ? `<small>${esc(r.zh)}</small>` : ""}<b>+</b></button>`).join("");
    list.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", () => { const r = recommendations.find((x) => x.tag === b.dataset.tag); addEntry(b.dataset.tag, { section: r?.section }); }));
  } catch { box.hidden = true; }
}
async function loadConflicts() {
  const tags = allPromptEntries().map((e) => e.tag), panel = $("#conflict-panel");
  if (tags.length < 2) { panel.hidden = true; return; }
  try {
    const data = await api(`/api/conflicts?tags=${encodeURIComponent(tags.join(","))}`); promptConflicts = data.conflicts || []; panel.hidden = !promptConflicts.length;
    // Warning-only：冲突面板只提示，绝不跨目标自动删除同名 tag；删除只由用户在购物车中按具体条目执行。
    panel.innerHTML = promptConflicts.map((c, i) => `<div class="conflict-row"><span>${esc(c.tag_a)} 与 ${esc(c.tag_b)} 可能冲突</span><button data-keep="${i}">知道了</button></div>`).join("");
    panel.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", () => b.closest(".conflict-row").remove()));
  } catch { panel.hidden = true; }
}
// 当前「活动目标」：生图视图取 workbench 编辑器目标，其余视图取购物车 state.target。
// TagBundle 与生成/恢复共用此判定，保证只在当前目标内读写。
function currentActivePromptTarget() {
  if (state.view === "generate") {
    const workbench = resolveWorkbenchEditorTarget(currentWorkbenchView());
    if (workbench) return workbench;
  }
  return resolveMutationTarget(state.target) || "base";
}
function bundleItemsFromPrompt() {
  const target = currentActivePromptTarget();
  if (!target || !promptDocument) return [];
  // 只捕获当前目标的分区条目（含 section），绝不 flatten 全部角色。
  return promptDocument.getTargetEntries(state.prompt, target).map((e, i) => ({ tag: e.tag, weight: e.weight, section: e.section, sort_order: i }));
}
async function openBundlesModal() { $("#bundles-modal").style.display = "flex"; await loadBundles(); }
function closeBundlesModal() { $("#bundles-modal").style.display = "none"; }
async function loadBundles() {
  const list = $("#bundles-list"); list.innerHTML = `<div class="empty">正在加载标签模板…</div>`;
  try { const data = await api("/api/bundles"); bundles = data.bundles || data.items || []; renderBundles(); }
  catch (e) { list.innerHTML = `<div class="empty">标签模板加载失败：${esc(e.message)}</div>`; }
}
function renderBundles() {
  const list = $("#bundles-list"); if (!bundles.length) { list.innerHTML = `<div class="empty">暂无标签模板</div>`; return; }
  list.innerHTML = bundles.map((b) => `<article class="workspace-item"><div class="workspace-item-head"><strong>${esc(b.name)}</strong><span>${(b.items || []).length} tags</span></div><div class="bundle-tags">${(b.items || []).map((e) => `<span>${esc(e.tag)}</span>`).join("")}</div><div class="workspace-item-actions"><button data-add="${esc(b.id)}" class="primary">添加</button><button data-delete="${esc(b.id)}">删除</button></div></article>`).join("");
  list.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addBundle(b.dataset.add)));
  list.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => deleteBundle(b.dataset.delete)));
}
async function createBundle(name = "") {
  const value = (name || $("#bundle-name").value).trim(); if (!value) { toast("请填写标签模板名称"); return null; }
  const items = bundleItemsFromPrompt(); if (!items.length) { toast("当前 Prompt 为空"); return null; }
  const data = await api("/api/bundles", { method: "POST", body: JSON.stringify({ name: value, items }) }); $("#bundle-name").value = ""; toast("标签模板已保存");
  closeBundlesModal(); return data.bundle || data;
}
async function addBundle(id) {
  let bundle = bundles.find((b) => String(b.id) === String(id)); if (!bundle?.items) { const data = await api(`/api/bundles/${encodeURIComponent(id)}`); bundle = data.bundle || data; }
  if (!bundle) return;
  const target = currentActivePromptTarget();
  if (!target || !promptDocument) { toast("当前目标不可用"); return; }
  pushHistory();
  const currentText = promptDocument.serializeTarget(state.prompt, target);
  const existing = new Set(splitPromptTokens(currentText).map((t) => t.toLocaleLowerCase()));
  const additions = (bundle.items || []).map((item) => String(item.tag || "").trim()).filter((tag) => tag && !existing.has(tag.toLocaleLowerCase()));
  if (additions.length) {
    const merged = [currentText, ...additions].filter((part) => part && part.trim()).join(", ");
    // 仅 reconcile 当前目标：base / char:N 互不影响，无绝对角色下标。
    state.prompt = promptDocument.reconcileTargetText(state.prompt, target, merged, new Map(knownCatalogTags));
  }
  commitPromptChange(); closeBundlesModal(); toast(`已添加标签模板「${bundle.name}」`);
}
async function deleteBundle(id) { if (!confirm("确定删除该标签模板？")) return; await api(`/api/bundles/${encodeURIComponent(id)}`, { method: "DELETE" }); await loadBundles(); toast("标签模板已删除"); }
function generationSnapshot() { return typeof naiCollectParameters === "function" && $("#nai-model") ? naiCollectParameters() : {}; }
async function saveSnapshot(options = {}) {
  const body = { positive_prompt: options.positive_prompt ?? promptPreviewText(), negative_prompt: options.negative_prompt ?? negativePreviewText(), structured_state: options.structured_state ?? state.prompt, generation: options.generation ?? generationSnapshot() };
  pendingSnapshotId = null;
  try {
    const data = await api("/api/snapshots", { method: "POST", body: JSON.stringify(body) });
    const snapshotId = data.id ?? data.snapshot?.id ?? null;
    if (!snapshotId) throw new Error("服务未返回快照 ID");
    pendingSnapshotId = snapshotId;
    if (!options.quiet) toast("快照已保存");
    return data.snapshot || data;
  } catch (e) {
    if (!options.quiet) toast("快照保存失败：" + e.message);
    return null;
  }
}
async function openSnapshotModal() { $("#snapshot-modal").style.display = "flex"; await loadSnapshots(); }
function closeSnapshotModal() { $("#snapshot-modal").style.display = "none"; }
async function loadSnapshots() {
  const list = $("#snapshot-list"); list.innerHTML = `<div class="empty">正在加载历史…</div>`;
  try { const data = await api("/api/snapshots"); renderSnapshots(data.snapshots || data.items || []); }
  catch (e) { list.innerHTML = `<div class="empty">历史加载失败：${esc(e.message)}</div>`; }
}
function renderSnapshots(items) {
  const list = $("#snapshot-list"); if (!items.length) { list.innerHTML = `<div class="empty">暂无 Prompt 历史</div>`; return; }
  list.innerHTML = items.map((s) => `<article class="workspace-item"><div class="workspace-item-head"><strong>${esc(new Date(s.created_at || Date.now()).toLocaleString())}</strong><span>${esc(String(s.positive_prompt || "").split(",").slice(0, 3).join(", "))}</span></div><div class="workspace-item-actions"><button data-restore="${esc(s.id)}" class="primary">恢复</button><button data-copy="${esc(s.id)}">复制</button><button data-bundle="${esc(s.id)}">另存为标签模板</button></div></article>`).join("");
  list.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => restoreSnapshot(b.dataset.restore)));
  list.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => { const s = await getSnapshot(b.dataset.copy); await navigator.clipboard.writeText(s.positive_prompt || ""); toast("已复制"); }));
  list.querySelectorAll("[data-bundle]").forEach((b) => b.addEventListener("click", async () => { const s = await getSnapshot(b.dataset.bundle), old = state.prompt; state.prompt = migratePromptState(s.structured_state); await createBundle(`历史-${new Date(s.created_at || Date.now()).toLocaleDateString()}`); state.prompt = old; syncLegacyProjection(); }));
}
async function getSnapshot(id) { const data = await api(`/api/snapshots/${encodeURIComponent(id)}`); return data.snapshot || data; }
async function restoreSnapshot(id, sections = "") {
  pushHistory(); const suffix = sections ? `?sections=${encodeURIComponent(sections)}` : ""; const data = await api(`/api/snapshots/${encodeURIComponent(id)}/restore${suffix}`, { method: "POST" });
  const restored = data.structured_state || data.snapshot?.structured_state || data.prompt;
  if (restored) {
    const incoming = migratePromptState(restored);
    if (!sections) state.prompt = incoming;
    else sections.split(",").filter((id) => SECTION_IDS.includes(id)).forEach((id) => {
      state.prompt.sections[id] = incoming.sections[id]; state.prompt.global_uc_sections[id] = incoming.global_uc_sections[id];
      incoming.characters.forEach((ch, i) => { if (!state.prompt.characters[i]) state.prompt.characters[i] = { name: ch.name, prompt_sections: emptySections(), uc_sections: emptySections() }; state.prompt.characters[i].prompt_sections[id] = ch.prompt_sections[id]; state.prompt.characters[i].uc_sections[id] = ch.uc_sections[id]; });
    });
  }
  // 恢复后让 view adapter 镜像权威状态，保证后续生图视图不残留旧角色；UI 由 render 回流。
  syncNaiCharactersFromState();
  commitPromptChange(); renderWorkbenchEditorFromDocument({ force: true }); closeSnapshotModal(); await showView("browse"); toast("Prompt 已恢复");
}

// ===== Prompt 导入 =====
let inboxSeq = 0;

function countEntries(parsed) {
  let n = (parsed.base || []).length + (parsed.global_uc || []).length;
  (parsed.characters || []).forEach((c) => { n += (c.prompt || []).length + (c.uc || []).length; });
  return n;
}

// 纯函数：合并导入的 free_text（replace 直接替换；append 追加换行拼接）
function mergeImportedFreeText(current, incoming, mode) {
  if (!incoming) return current;
  if (mode === "replace") return incoming;
  return [current, incoming].filter(Boolean).join("\n");
}

function applyImported(parsed, mode, target = "base") {
  pushHistory(); const incoming = migratePromptState(parsed);
  if (target === "base" && mode === "replace") state.prompt = incoming;
  else {
    const targetSections = getSectionMap(target); if (!targetSections) return;
    if (mode === "replace") SECTION_IDS.forEach((id) => { targetSections[id] = []; });
    SECTION_IDS.forEach((id) => incoming.sections[id].forEach((entry) => { if (!targetSections[id].some((e) => e.tag === entry.tag)) targetSections[id].push(entry); }));
    if (incoming.free_text) {
      const merged = mergeImportedFreeText(state.prompt.free_text, incoming.free_text, mode);
      if (merged !== state.prompt.free_text) {
        state.prompt.free_text = merged;
        // 追加/非替换路径实际改变 free_text 后，旧译文不得继续作为 effective
        if (mode !== "replace") state.prompt.use_free_text_en = false;
      }
    }
  }
  rebuildTargetSelect(); commitPromptChange(); toast(`已导入 ${countEntries(parsed)} 个标签`);
}

async function pollInbox(initial) {
  try {
    const r = await api("/api/inbox?since=" + inboxSeq);
    if (initial) { inboxSeq = r.seq; return; }
    if (r.state) {
      inboxSeq = r.seq;
      applyImported(r.state.parsed, r.state.mode || "replace");
    }
  } catch { /* 忽略轮询错误 */ }
}

function openImportModal() {
  $("#import-modal").style.display = "flex";
  $("#import-text").value = "";
  $("#import-preview-box").style.display = "none";
  $("#import-preview-box").innerHTML = "";
  $("#import-auto-split-box").style.display = "none";
  $("#import-auto-split-box").innerHTML = "";
  $("#import-auto-split-actions").style.display = "none";
  autoSplitProposal = null;
  importPreviewData = null;
  $("#import-text").focus();
  rebuildImportTargetSelect();
}
function closeImportModal() { $("#import-modal").style.display = "none"; }

// ===== Auto-Split（非破坏性）=====
// 「自动整理角色」只做 analyze → preview，绝不修改当前 PromptDocument；
// 只有「应用拆分」才 dispatch APPLY_AUTO_SPLIT（一次 proposal -> documentFromProposal 整体替换）。
let autoSplitProposal = null; // 最近一次 /api/prompt/auto-split 的 proposal（未应用）

async function doAutoSplitFromImport() {
  const text = $("#import-text").value.trim();
  if (!text) { toast("请先粘贴提示词"); return; }
  const btn = $("#import-auto-split");
  btn.disabled = true;
  btn.textContent = "分析中…";
  try {
    const r = await api("/api/prompt/auto-split", { method: "POST", body: JSON.stringify({ text }) });
    const proposal = r.proposal || r;
    autoSplitProposal = proposal;
    renderAutoSplitPreview(proposal, r.summary || proposal.summary || "");
  } catch (e) {
    toast("自动整理失败：" + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "自动整理角色";
  }
}

// 用 proposal 真实字段渲染预览：base / characters[].{name,prompt,uc} / unassigned。
// 计数只来自 proposal（free_text 条目无 tag，不计入 Base 标签数）。
function renderAutoSplitPreview(proposal, summary) {
  const box = $("#import-auto-split-box");
  const actions = $("#import-auto-split-actions");
  const baseCount = (proposal.base || []).filter((e) => e && e.tag).length;
  const characters = proposal.characters || [];
  const unassignedCount = (proposal.unassigned || []).length;
  let html = `<div class="import-seg import-guide">${esc(summary || "")} 仅预览归属，点击「应用拆分」才会写入 Prompt；当前文档不会被改动。</div>`;
  html += `<div class="import-seg"><div class="imp-seg-head"><span class="imp-seg-label">Base</span><span>· ${baseCount} 个标签</span></div></div>`;
  characters.forEach((c, i) => {
    const count = ((c?.prompt || []).length + (c?.uc || []).length);
    html += `<div class="import-seg"><div class="imp-seg-head"><span class="imp-seg-label">Character ${i + 1} ${esc(c?.name || "")}</span><span>· ${count} 个标签</span></div></div>`;
  });
  html += `<div class="import-seg"><div class="imp-seg-head"><span class="imp-seg-label">无法确定</span><span>· ${unassignedCount} 个标签</span></div></div>`;
  box.innerHTML = html;
  box.style.display = "block";
  actions.style.display = "flex";
  // 与普通导入预览互斥：显示 Auto-Split 预览时收起普通解析预览。
  $("#import-preview-box").style.display = "none";
  importPreviewData = null;
}

// 应用拆分：dispatch 单个 APPLY_AUTO_SPLIT（documentFromProposal 整体替换 -> 单次 notify）。
function applyAutoSplitFromImport() {
  if (!autoSplitProposal) return;
  const proposal = autoSplitProposal;
  autoSplitProposal = null;
  window.PromptBridge.dispatch({ type: "APPLY_AUTO_SPLIT", payload: { proposal } });
  closeImportModal();
  toast(`已应用角色整理：${proposal.summary || "完成"}`);
}

// 取消：关闭预览，ZERO 状态变更。
function cancelAutoSplitPreview() {
  autoSplitProposal = null;
  $("#import-auto-split-box").style.display = "none";
  $("#import-auto-split-box").innerHTML = "";
  $("#import-auto-split-actions").style.display = "none";
}

function rebuildImportTargetSelect() {
  const sel = $("#import-target");
  if (!sel) return;
  sel.innerHTML = targetOptions().map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join("");
}

// ===== 导入预览（解析 + 校验 + 分类） =====
let importPreviewData = null;  // 最近一次 preview 结果

function targetPickerHtml(selected, name) {
  const opts = targetOptions();
  opts.push({ value: "__ignore__", label: "忽略此段（不导入）" });
  return `<select class="seg-target" data-name="${esc(name)}">` +
    opts.map((o) => `<option value="${o.value}" ${o.value === selected ? "selected" : ""}>${esc(o.label)}</option>`).join("") +
    `</select>`;
}

function entryChipHtml(e) {
  const raw = esc(e.raw);
  const entry = e.entry || {};
  const strength = entry.strength != null ? ` <span class="imp-seg-w">${esc(String(entry.strength))}::</span>` : "";
  const bc = entry.brackets ? (entry.brackets > 0 ? " {" : " [") : "";
  const bcEnd = entry.brackets ? (entry.brackets > 0 ? "}" : "]") : "";
  const rel = entry.relation ? `<span class="imp-seg-w">${esc(entry.relation)}#</span>` : "";
  const ucMark = e.uc ? '<span class="imp-seg-uc">UC</span>' : "";
  return `<span class="imp-chip" data-raw="${raw}">${ucMark}${rel}${bc}${raw}${bcEnd}${strength}</span>`;
}

async function doImportPreview() {
  const text = $("#import-text").value.trim();
  if (!text) { toast("请先粘贴提示词"); return; }
  const btn = $("#import-preview");
  btn.disabled = true; btn.textContent = "解析中…";
  try {
    const r = await api("/api/import/preview", { method: "POST", body: JSON.stringify({ text }) });
    importPreviewData = r;
    renderImportPreview(r);
  } catch (e) {
    toast("解析失败：" + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "解析预览";
  }
}

function renderImportPreview(data) {
  // 普通解析预览与 Auto-Split 预览互斥：显示普通预览时收起 Auto-Split 预览。
  $("#import-auto-split-box").style.display = "none";
  $("#import-auto-split-actions").style.display = "none";
  autoSplitProposal = null;
  const box = $("#import-preview-box"); box.style.display = "block";
  if (!data.segments && Array.isArray(data.entries)) data.segments = [{ kind: "base", label: "Prompt", entries: data.entries }];
  if (!data.stats) { const entries = (data.segments || []).flatMap((s) => s.entries || []); data.stats = { total: entries.length, unmatched: entries.filter((e) => !e.match).length }; }
  if (!data.segments || !data.segments.length) { box.innerHTML = `<div class="import-seg"><div class="imp-seg-head">无可解析的标签分段</div>${data.free_text ? `<div class="imp-free">自然语言：${esc(data.free_text)}</div>` : ""}</div>`; return; }
  let html = `<div class="import-seg import-guide">共 ${data.stats.total} 个标签。建议匹配默认不导入，请选择候选或保留原文。</div>`;
  data.segments.forEach((seg, si) => {
    // 每段默认目标：base→当前 target 选择器值；char→对应 char 槽；global_uc→global_uc
    let defTarget = $("#import-target").value || "base";
    if (seg.kind === "char") defTarget = `char:${seg.index}`;
    else if (seg.kind === "global_uc") defTarget = "global_uc";
    html += `<div class="import-seg" data-si="${si}">`;
    html += `<div class="imp-seg-head"><span class="imp-seg-label">${esc(seg.label)}</span>` +
      `导入到：${targetPickerHtml(defTarget, "seg_" + si)}</div>`;
    html += `<div class="imp-seg-tags">`;
    seg.entries.forEach((e, ei) => {
      html += `<div class="imp-entry" data-si="${si}" data-ei="${ei}">`;
      html += `<div class="imp-entry-line">${entryChipHtml(e)}<button type="button" class="imp-remove" title="不导入此条">删除</button>`;
      const status = e.status || (e.match ? "exact" : (e.candidates?.length ? "candidate" : "custom"));
      const statusText = { exact: "精确匹配", normalized: "已规范化", candidate: "建议匹配", custom: "自定义" }[status] || "自定义";
      html += `<span class="imp-status imp-status-${status}">${statusText}</span>`;
      if (e.match && status !== "candidate") html += `<span class="imp-ok">${esc(e.match.tag || e.match)}</span>`;
      if (status === "candidate" || !e.match) html += `<button type="button" class="imp-keep" data-si="${si}" data-ei="${ei}">保留原文</button>`;
      html += `</div>`;
      if ((e.status || (e.match ? "exact" : "candidate")) === "candidate" || !e.match) {
        html += `<div class="imp-cands">`;
        if (e.candidates && e.candidates.length) {
          html += `建议替换：<select class="imp-cand" data-si="${si}" data-ei="${ei}">` +
            `<option value="">（不替换）</option>` +
            e.candidates.map((c) => `<option value="${esc(c.tag)}">${esc(c.tag)}</option>`).join("") +
            `</select>`;
        } else {
          html += `<span class="imp-nocand">暂无相似候选</span>`;
        }
        html += `备注存库：<input class="imp-note" data-si="${si}" data-ei="${ei}" placeholder="选填，输入备注后存为自定义标签" />`;
        html += `</div>`;
      }
      html += `</div>`;
    });
    html += `</div></div>`;
  });
  if (data.free_text) {
    html += `<div class="import-seg"><div class="imp-seg-head">自然语言自由文本</div>` +
      `<div class="imp-free">${esc(data.free_text)}</div></div>`;
  }
  box.innerHTML = html;
  // 候选替换即时生效（更新 chip 显示）
  box.querySelectorAll("select.imp-cand").forEach((sel) => {
    sel.addEventListener("change", () => {
      const si = +sel.dataset.si, ei = +sel.dataset.ei, row = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"]`), chip = row.querySelector(".imp-chip");
      row.dataset.choice = sel.value ? "candidate" : "";
      if (sel.value) { chip.textContent = sel.value; chip.dataset.replaced = sel.value; }
      else { chip.textContent = importPreviewData.segments[si].entries[ei].raw; delete chip.dataset.replaced; }
    });
  });
  box.querySelectorAll(".imp-keep").forEach((btn) => btn.addEventListener("click", () => {
    const row = btn.closest(".imp-entry"), e = importPreviewData.segments[+btn.dataset.si].entries[+btn.dataset.ei];
    row.dataset.choice = "custom"; row.querySelector(".imp-chip").textContent = e.raw; btn.classList.add("selected");
    const sel = row.querySelector(".imp-cand"); if (sel) sel.value = "";
  }));
  box.querySelectorAll(".imp-remove").forEach((btn) => btn.addEventListener("click", () => { const row = btn.closest(".imp-entry"); row.dataset.removed = "true"; row.hidden = true; }));
}

function importEntryTarget(target, isUc) {
  if (!isUc) return target;
  if (target === "base") return "global_uc";
  if (/^char:\d+$/.test(target)) return `${target}:uc`;
  return target;
}

async function applyImportedPreview() {
  if (!importPreviewData) return;
  const box = $("#import-preview-box"), mode = document.querySelector('input[name="import-mode"]:checked').value; pushHistory();
  const touched = new Set(); let imported = 0;
  importPreviewData.segments.forEach((seg, si) => {
    const target = box.querySelector(`select.seg-target[data-name="seg_${si}"]`)?.value || "base";
    if (target === "__ignore__") return;
    const segmentTargets = new Set([target, ...(seg.entries || []).filter((e) => e.uc).map(() => importEntryTarget(target, true))]);
    if (mode === "replace") segmentTargets.forEach((slot) => {
      const slotSections = getSectionMap(slot);
      if (slotSections && !touched.has(slot)) { SECTION_IDS.forEach((id) => { slotSections[id] = []; }); touched.add(slot); }
    });
    (seg.entries || []).forEach((e, ei) => {
      const row = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"]`), status = e.status || (e.match ? "exact" : (e.candidates?.length ? "candidate" : "custom"));
      if (row?.dataset.removed === "true") return;
      const candidate = row?.querySelector(".imp-cand")?.value || "", keep = row?.dataset.choice === "custom";
      if ((status === "candidate" || !e.match) && !candidate && !keep) return;
      const canonical = typeof e.match === "string" ? e.match : e.match?.tag;
      const tag = candidate || (keep ? e.raw : canonical || e.entry?.tag || e.raw), section = SECTION_IDS.includes(e.section || e.entry?.section) ? (e.section || e.entry.section) : "other";
      const entrySections = getSectionMap(importEntryTarget(target, e.uc));
      if (!entrySections) return;
      if (!entrySections[section].some((x) => x.tag === tag)) { entrySections[section].push(normalizeEntry({ ...(e.entry || {}), tag, section, custom: keep, source: "import" }, section)); imported += 1; }
      if (keep) api("/api/user-tags", { method: "POST", body: JSON.stringify({ tag, note: row?.querySelector(".imp-note")?.value || "" }) }).catch(() => {});
    });
  });
  if (importPreviewData.free_text) {
    const merged = mergeImportedFreeText(state.prompt.free_text, importPreviewData.free_text, mode);
    if (merged !== state.prompt.free_text) {
      state.prompt.free_text = merged;
      if (mode !== "replace") state.prompt.use_free_text_en = false;
    }
  }
  rebuildTargetSelect(); commitPromptChange(); importPreviewData = null; closeImportModal(); toast(`已导入 ${imported} 个标签`);
}

async function doImportFromModal() {
  const text = $("#import-text").value.trim();
  if (!text) { toast("请先粘贴提示词"); return; }
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  const target = $("#import-target").value || "base";
  const r = await api("/api/import", { method: "POST", body: JSON.stringify({ text, mode }) });
  applyImported(r.parsed, mode, target);
  // 立即应用后推进收件箱游标，避免下一轮 pollInbox 再次应用同一份导入（默认 base 目标）。
  if (r.seq != null) inboxSeq = r.seq;
  closeImportModal();
}

function normalizeCharacterSlot(v, idx = 0) {
  if (!v || typeof v !== "object") return { name: `角色 ${idx + 1}`, prompt: [], uc: [] };
  return {
    name: v.name || `角色 ${idx + 1}`,
    prompt: Array.isArray(v.prompt) ? v.prompt : [],
    uc: Array.isArray(v.uc) ? v.uc : [],
  };
}

function normalizePromptPresetPayload(payload = {}) {
  return {
    model: typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : state.model,
    base_prompt: Array.isArray(payload.base_prompt) ? payload.base_prompt : [],
    characters: Array.isArray(payload.characters) && payload.characters.length ? payload.characters.map((c, i) => normalizeCharacterSlot(c, i)) : [{ name: "Character 1", prompt: [], uc: [] }],
    global_uc: Array.isArray(payload.global_uc) ? payload.global_uc : [],
    free_text: typeof payload.free_text === "string" ? payload.free_text : "",
  };
}

async function loadPromptPresets() {
  const sel = $("#prompt-preset-select");
  if (!sel) return;
  try {
    const r = await api("/api/presets");
    const rows = Array.isArray(r.presets) ? r.presets : [];
    const normalized = rows
      .filter((p) => !p.kind || p.kind === "prompt")
      .map((p) => {
        let payload = p.payload;
        if (payload == null && p.payload_json) {
          try { payload = JSON.parse(p.payload_json); } catch { payload = {}; }
        }
        return { ...p, payload: payload || {} };
      });
    promptPresets = normalized.sort((a, b) => {
      const ta = String(a.updated_at || "");
      const tb = String(b.updated_at || "");
      if (ta === tb) return 0;
      return ta > tb ? -1 : 1;
    });
    sel.innerHTML = `<option value="">选择已保存提示词</option>` + promptPresets.map((p) =>
      `<option value="${String(p.id)}">${esc(p.name || `未命名-${p.id}`)}</option>`
    ).join("");
  } catch (e) {
    toast("提示词仓库加载失败：" + e.message);
  }
}

function applyPromptPresetById() {
  const sel = $("#prompt-preset-select");
  if (!sel || !sel.value) { toast("请选择要加载的提示词仓库项"); return; }
  const preset = promptPresets.find((p) => String(p.id) === String(sel.value));
  if (!preset) { toast("未找到该预设"); return; }
  const payload = normalizePromptPresetPayload(preset.payload || {});
  state.model = payload.model;
  state.prompt = migratePromptState({ base_prompt: payload.base_prompt, characters: payload.characters, global_uc: payload.global_uc, free_text: payload.free_text });
  state.target = "base";
  if (state.model && $("#model-select").querySelector(`option[value="${cssEsc(state.model)}"]`)) {
    $("#model-select").value = state.model;
  }
  rebuildTargetSelect();
  commitPromptChange();
  toast(`已加载提示词仓库「${preset.name || "未命名"}」`);
}

async function deletePromptPreset() {
  const sel = $("#prompt-preset-select");
  if (!sel || !sel.value) { toast("请选择要删除的提示词仓库项"); return; }
  const preset = promptPresets.find((p) => String(p.id) === String(sel.value));
  if (!preset) { toast("未找到该预设"); return; }
  if (!confirm(`确定删除提示词仓库「${preset.name || "未命名"}」？`)) return;
  try {
    await api(`/api/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
    sel.value = "";
    await loadPromptPresets();
    toast("提示词仓库已删除");
  } catch (e) { toast("删除失败：" + e.message); }
}

async function savePromptPreset() {
  const rawName = prompt("Preset 名称：", `preset-${Date.now()}`);
  const name = rawName?.trim() || "";
  if (!name) { toast("名称不能为空"); return; }
  const payload = {
    model: state.model,
    base_prompt: state.base,
    characters: state.characters,
    global_uc: state.global_uc,
    free_text: state.free_text,
  };
  try {
    await api("/api/presets", { method: "POST", body: JSON.stringify({ name, kind: "prompt", payload }) });
    await loadPromptPresets();
    flash("提示词仓库已保存");
  } catch (e) { toast("保存失败：" + e.message); }
}

// ===== 搜索 / 视图切换 =====
const semanticStatusLabels = { canonical: "本地已收录", alias: "本地别名", candidate: "外部候选", unresolved: "未解析" };
let semanticResults = [];

function semanticCardHtml(item, index) {
  const status = item.local_status || "unresolved";
  const score = Number.isFinite(Number(item.score)) ? `${(Number(item.score) * 100).toFixed(1)}%` : "-";
  const category = item.category_name || item.category || "General";
  const meta = [
    `匹配层：${item.layer || "语义"}`,
    `分数：${score}`,
    `类别：${category}`,
    item.post_count ? `热度：${Number(item.post_count).toLocaleString()}` : "",
  ].filter(Boolean).join(" · ");
  const section = SECTION_LABELS[item.section] || "自动分类";
  const addDisabled = status === "unresolved" ? "disabled" : "";
  return `<article class="semantic-card">` +
    `<div class="semantic-card-main"><div class="semantic-card-copy">` +
    `<div class="semantic-tag">${esc(item.tag)}</div>` +
    (item.cn_name ? `<div class="semantic-zh">${esc(item.cn_name)}</div>` : "") +
    `<div class="semantic-meta">${esc(meta)}</div>` +
    (item.wiki ? `<div class="semantic-wiki">${esc(item.wiki)}</div>` : "") +
    `</div><span class="semantic-status ${esc(status)}">${esc(semanticStatusLabels[status] || status)}</span></div>` +
    `<button class="semantic-add" type="button" data-semantic-add="${index}" ${addDisabled}>加入 Prompt · ${esc(section)}</button>` +
    `</article>`;
}

function renderSemanticResults(results, query = "") {
  semanticResults = Array.isArray(results) ? results : [];
  const box = $("#semantic-results");
  const list = $("#semantic-list");
  const status = $("#semantic-status");
  if (!box || !list || !status) return;
  box.hidden = false;
  status.textContent = semanticResults.length ? `${semanticResults.length} 个候选${query ? ` · ${query}` : ""}` : "暂无候选";
  list.innerHTML = semanticResults.length ? semanticResults.map(semanticCardHtml).join("") : `<div class="empty">没有找到可用候选</div>`;
  list.querySelectorAll("[data-semantic-add]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = semanticResults[Number(button.dataset.semanticAdd)];
      if (!item || button.disabled) return;
      button.disabled = true;
      try {
        await addEntry(item.tag, { section: SECTION_IDS.includes(item.section) ? item.section : undefined, source: "semantic" });
        button.textContent = "已加入 Prompt";
      } catch (e) {
        button.disabled = false;
        toast("加入失败：" + e.message);
      }
    });
  });
}

async function runSemanticSearch() {
  const query = $("#search-input").value.trim();
  if (!query) { toast("请先输入中文描述或自然语言查询"); return; }
  const button = $("#semantic-search-btn");
  const box = $("#semantic-results");
  const status = $("#semantic-status");
  button.disabled = true;
  button.textContent = "语义搜索中…";
  box.hidden = false;
  status.textContent = "正在连接语义服务，首次访问可能需要等待…";
  $("#semantic-list").innerHTML = `<div class="empty">正在召回候选…</div>`;
  try {
    const catFilter = $("#cat-filter").value;
    const payload = { query, ...(catFilter ? { category: Number(catFilter) } : {}) };
    const data = await api("/api/semantic-search", { method: "POST", body: JSON.stringify(payload) });
    renderSemanticResults(data.results, data.query);
  } catch (e) {
    status.textContent = "搜索失败";
    $("#semantic-list").innerHTML = `<div class="empty">${esc(e.message || "语义搜索失败")}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "语义找词";
  }
}

async function runSearch(q, opts = {}) {
  const requestId = ++contentRequestSeq;
  if (!q.trim()) {
    if (activeCatalogId) await openCatalog(activeCatalogId, currentPage, { noHistory: opts.noHistory });
    return;
  }
  const catFilter = $("#cat-filter").value;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}${catFilter ? `&category=${catFilter}` : ""}`);
  if (requestId !== contentRequestSeq) return;
  renderSearchResults(data.results);
  $("#pagination").innerHTML = "";  // 搜索结果无分页
  pushNav(activeCatalogId, currentPage, q, opts.noHistory);
  if (pendingScroll != null) {
    const st = pendingScroll; pendingScroll = null;
    requestAnimationFrame(() => { $("#tag-list").scrollTop = st; });
  }
}
const doSearch = debounce(runSearch, 200);

function setViewTab(view) {
  const module = { generate: "generate", gallery: "gallery", browse: "market", favorites: "market", recent: "market" }[view] || "market";
  document.querySelectorAll(".module-nav [data-module]").forEach((button) => button.classList.toggle("active", button.dataset.module === module));
  document.querySelectorAll(".context-nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const title = { generate: "生图", gallery: "图库", browse: "标签超市", favorites: "标签超市", recent: "标签超市" }[view] || "标签超市";
  const titleEl = $("#module-context-title");
  if (titleEl) titleEl.textContent = title;
  const subbar = $(".subbar");
  if (subbar) subbar.dataset.module = module;
}

function renderFavoritesView() {
  showingSearchResults = false;
  $("#browse-title").textContent = "我的收藏";
  renderTagCards([...state.favorites].map((t) => ({ tag: t, zh: zhMap[t] || "", post_count: 0 })));
}

function renderRecentView() {
  showingSearchResults = false;
  $("#browse-title").textContent = "最近使用的标签";
  renderTagCards(state.recent.map((t) => ({ tag: t, zh: zhMap[t] || "", post_count: 0 })));
}

async function showView(view) {
  if (view === state.view) return;
  // 离开图库视图时退出审阅模式，恢复普通图库布局
  if (view !== "gallery" && galleryReviewMode) setGalleryReviewMode(false);
  // 保存当前视图位置：滚动 + 分类浏览的完整浏览状态
  if (state.view === "browse") {
    viewScrolls.browse = $("#tag-list").scrollTop;
    browseSnapshot = {
      catalogId: activeCatalogId,
      page: currentPage,
      sort: sortMode,
      query: $("#search-input").value,
      scrollTop: $("#tag-list").scrollTop,
    };
  } else if (state.view === "favorites") {
    viewScrolls.favorites = $("#tag-list").scrollTop;
  } else if (state.view === "recent") {
    viewScrolls.recent = $("#tag-list").scrollTop;
  } else if (state.view === "gallery") {
    viewScrolls.gallery = $("#gallery-grid").scrollTop;
  }

  state.view = view;
  setViewTab(view);
  const isGallery = view === "gallery";
  const isGenerate = view === "generate";
  $("#gallery-view").style.display = isGallery ? "grid" : "none";
  $("#generate-view").style.display = isGenerate ? "grid" : "none";
  const layout = document.querySelector("main.layout");
  if (layout) layout.style.display = (isGallery || isGenerate) ? "none" : "grid";
  const subbar = $(".subbar");
  if (subbar) subbar.style.display = isGenerate || isGallery ? "none" : "flex";

  if (isGallery) {
    pendingScroll = viewScrolls.gallery || 0;
    loadGalleryList();
    return;
  }
  if (isGenerate) {
    initGenerateView();
    return;
  }
  if (view === "favorites") {
    renderFavoritesView();
    $("#tag-list").scrollTop = viewScrolls.favorites || 0;
    setTimeout(() => { $("#tag-list").scrollTop = viewScrolls.favorites || 0; }, 60);
  } else if (view === "recent") {
    renderRecentView();
    $("#tag-list").scrollTop = viewScrolls.recent || 0;
    setTimeout(() => { $("#tag-list").scrollTop = viewScrolls.recent || 0; }, 60);
  } else if (view === "browse") {
    // 回到上次浏览的位置：搜索词或分类+页码
    const snap = browseSnapshot;
    browseSnapshot = null;
    if (snap) {
      sortMode = snap.sort || "hot";
      $("#sort-select").value = sortMode;
      $("#search-input").value = snap.query || "";
      pendingScroll = snap.scrollTop || 0;
      if (snap.query && snap.query.trim()) {
        await runSearch(snap.query, { noHistory: true });
      } else if (snap.catalogId) {
        await openCatalog(snap.catalogId, snap.page, { noHistory: true });
      }
    } else if (activeCatalogId) {
      pendingScroll = viewScrolls.browse || 0;
      await openCatalog(activeCatalogId, currentPage, { noHistory: true });
    }
  }
}

async function runSync() {
  $("#sync-btn").disabled = true;
  $("#sync-btn").textContent = "更新中…";
  try {
    const r = await api("/api/sync", { method: "POST" });
    alert(JSON.stringify(r, null, 2));
  } catch (e) {
    alert("更新失败：" + e.message);
  } finally {
    $("#sync-btn").disabled = false;
    $("#sync-btn").textContent = "更新标签库";
  }
}

// ===== 事件绑定 =====
const bind = (id, event, handler) => {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
};

$("#model-select").addEventListener("change", (e) => { state.model = e.target.value; persistDraft(); });
$("#target-select").addEventListener("change", (e) => { window.PromptBridge.setActiveTarget(e.target.value); syncNaiTagTargetFromState(); });
$("#nai-tag-target")?.addEventListener("change", (e) => {
  const v = e.target.value;
  const m = v.match(/^char:(\d+)$/);
  window.PromptBridge.setActiveTarget(v === "base" || (m && naiCharacters[Number(m[1])]) ? v : "base");
});
$("#search-input").addEventListener("input", (e) => doSearch(e.target.value));
// 聚焦搜索框时自动回到超市（browse）视图，使搜索结果可见；不清空已有内容。
// focus 与 input 是独立事件，不会干扰后续 input→runSearch 流程。
$("#search-input").addEventListener("focus", () => {
  if (state.view !== "browse") showView("browse");
});
$("#cat-filter").addEventListener("change", () => doSearch($("#search-input").value));
bind("#semantic-search-btn", "click", runSemanticSearch);
const semanticCloseBtn = $("#semantic-close");
if (semanticCloseBtn) semanticCloseBtn.addEventListener("click", () => { const box = $("#semantic-results"); if (box) box.hidden = true; });
const recommendationsCloseBtn = $("#recommendations-close");
if (recommendationsCloseBtn) recommendationsCloseBtn.addEventListener("click", () => { const box = $("#recommendations"); if (box) box.hidden = true; });
$("#sort-select").addEventListener("change", (e) => { sortMode = e.target.value; if (activeCatalogId) openCatalog(activeCatalogId, 1); });
$("#back-btn").addEventListener("click", goBack);
$("#cart-advanced-toggle").addEventListener("click", () => { cartAdvanced = !cartAdvanced; if (cartAdvanced) activeWorkspaceTarget = "base"; workspaceSectionFilter = ""; rebuildTargetSelect(); renderCart(); });
$("#clear-btn").addEventListener("click", clearAll);
$("#undo-btn").addEventListener("click", undo);
$("#export-btn").addEventListener("click", doExport);
bind("#save-preset", "click", savePromptPreset);
bind("#prompt-preset-load", "click", applyPromptPresetById);
bind("#prompt-preset-delete", "click", deletePromptPreset);
$("#sync-btn").addEventListener("click", runSync);
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-cancel").addEventListener("click", closeSettings);
$("#settings-save").addEventListener("click", saveUserSettings);
$("#setting-novelai-batch-max").addEventListener("input", (event) => {
  $("#setting-novelai-batch-max-value").textContent = `${event.target.value} 张`;
});
$("#clear-thumb-cache").addEventListener("click", clearThumbCache);
bind("#clear-novelai-example-cache", "click", clearNovelAIExampleCache);
$("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettings(); });
$("#import-btn").addEventListener("click", openImportModal);
$("#import-preview").addEventListener("click", doImportPreview);
$("#import-auto-split").addEventListener("click", doAutoSplitFromImport);
$("#auto-split-apply").addEventListener("click", applyAutoSplitFromImport);
$("#auto-split-cancel").addEventListener("click", cancelAutoSplitPreview);
$("#import-ok").addEventListener("click", async () => {
  if (importPreviewData) await applyImportedPreview();
  else await doImportFromModal();
});
$("#import-cancel").addEventListener("click", closeImportModal);
$("#import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") closeImportModal(); });
$("#custom-tag-cancel").addEventListener("click", closeCustomTagModal);
$("#custom-tag-save").addEventListener("click", submitCustomTag);
$("#custom-tag-translate").addEventListener("click", translateCustomTag);
$("#custom-tag-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitCustomTag(); } });
$("#custom-tag-modal").addEventListener("click", (e) => { if (e.target.id === "custom-tag-modal") closeCustomTagModal(); });
bind("#top-import-btn", "click", openImportModal);
bind("#bundles-btn", "click", openBundlesModal);
bind("#prompt-history-btn", "click", openSnapshotModal);
bind("#bundles-close", "click", closeBundlesModal); bind("#bundle-create", "click", () => createBundle());
bind("#snapshot-close", "click", closeSnapshotModal); bind("#save-snapshot-btn", "click", () => saveSnapshot());
bind("#save-bundle-btn", "click", () => openBundlesModal());
bind("#send-generate-btn", "click", async () => { const text = promptPreviewText(); if (!text) { toast("当前 Prompt 为空"); return; } await switchToGenerateView(); });
// More 菜单（头部 More ▾ 与高级工作区 More… 共用同一个菜单）
function toggleCartMore(force) {
  const menu = $("#cart-more-menu");
  if (!menu) return;
  menu.hidden = typeof force === "boolean" ? !force : !menu.hidden;
}
function closeCartMore() { toggleCartMore(false); }
$("#cart-more-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleCartMore(); });
$("#ws-more-btn")?.addEventListener("click", (e) => { e.stopPropagation(); toggleCartMore(); });
$("#cart-history-btn")?.addEventListener("click", openSnapshotModal);
document.addEventListener("click", (e) => { if (!e.target.closest(".cart-more")) closeCartMore(); });
$("#cart-more-menu")?.addEventListener("click", (e) => { if (e.target.closest("button")) closeCartMore(); });
// 高级工作区底部动作条
$("#ws-copy")?.addEventListener("click", async () => { workspaceFlushSync(); doExport(); });
$("#ws-continue")?.addEventListener("click", async () => {
  workspaceFlushSync();
  const text = promptPreviewText();
  if (!text) { toast("当前 Prompt 为空"); return; }
  await switchToGenerateView();
});
$("#bundles-modal").addEventListener("click", (e) => { if (e.target.id === "bundles-modal") closeBundlesModal(); });
$("#snapshot-modal").addEventListener("click", (e) => { if (e.target.id === "snapshot-modal") closeSnapshotModal(); });
document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (!viewButton) return;
  showView(viewButton.dataset.view).catch((error) => {
    console.error("视图切换失败", error);
    toast(`视图切换失败：${error.message}`);
  });
});
// 图库
$("#gallery-import-btn").addEventListener("click", () => $("#gallery-file").click());
$("#gallery-file").addEventListener("change", handleGalleryUpload);
$("#gallery-refresh").addEventListener("click", loadGalleryList);
$("#gallery-del-btn").addEventListener("click", deleteGalleryDir);
$("#gallery-zoom-out").addEventListener("click", () => changeGalleryZoom(-1));
$("#gallery-zoom-in").addEventListener("click", () => changeGalleryZoom(1));
$("#gallery-select-all").addEventListener("click", toggleGallerySelectAll);
$("#gallery-cleanup-btn").addEventListener("click", cleanupSelectedGalleryItems);
$("#gallery-open-cleanup").addEventListener("click", openGalleryCleanupFolder);


// ===== 图库 =====
let activeGalleryDir = null;
let activeGalleryCollection = null; // {kind, value} 或 null（null 表示按目录浏览）
let galleryItems = [];
let selectedGalleryFiles = new Set();
let galleryReviewMode = false;
let galleryReviewIndex = -1;
let galleryReviewZoomMode = "fit"; // "fit" 完整 contain | "1:1" 原生 CSS 像素尺寸，滚动查看
let lastGalleryCardIndex = -1; // 最近点击/预览的卡片索引，进入审阅时作为起点（无则 0）
let galleryPreviewSeq = 0; // showGalleryPreview 请求序列号，防止异步回退乱序覆盖较新的选中项
const GALLERY_ZOOM_KEY = "tags-market-gallery-zoom";
const GALLERY_ZOOM_LEVELS = ["small", "medium", "large"];
let galleryZoom = GALLERY_ZOOM_LEVELS.includes(localStorage.getItem(GALLERY_ZOOM_KEY)) ? localStorage.getItem(GALLERY_ZOOM_KEY) : "medium";

function galleryFileKey(dirName, fileName) { return `${dirName}\u0000${fileName}`; }
// 当前条目所在目录：优先条目自带 dir_name（合集模式跨目录），否则当前目录。
function galleryDirOf(item) { return (item && item.dir_name) || activeGalleryDir; }
// 显式动作事件：收藏/取消在服务端由 favorite 端点写；continue/restore 由前端显式上报一次。
async function sendGalleryEvent(item, type) {
  if (!item) return;
  try {
    await api("/api/gallery/events", { method: "POST", body: JSON.stringify({ dir_name: galleryDirOf(item), file_name: item.file_name, source_asset_id: item.source_asset_id ?? null, event_type: type }) });
  } catch { /* 事件上报失败不阻断主流程 */ }
}
// 设置生成血缘父级：继续生成 / 恢复时写入，随下一次生成进入 meta.parent。
function setGenerationParent(item) {
  if (!item) { naiGenerationParent = null; return; }
  naiGenerationParent = { dir_name: galleryDirOf(item), file_name: item.file_name, source_asset_id: item.source_asset_id ?? null };
}
function applyGalleryZoom() {
  const grid = $("#gallery-grid");
  if (!grid) return;
  grid.classList.remove(...GALLERY_ZOOM_LEVELS.map((x) => `gallery-grid-${x}`));
  grid.classList.add(`gallery-grid-${galleryZoom}`);
  const labels = { small: "小", medium: "中", large: "大" };
  $("#gallery-zoom-label").textContent = labels[galleryZoom];
  localStorage.setItem(GALLERY_ZOOM_KEY, galleryZoom);
}
function changeGalleryZoom(step) {
  const next = Math.max(0, Math.min(GALLERY_ZOOM_LEVELS.length - 1, GALLERY_ZOOM_LEVELS.indexOf(galleryZoom) + step));
  galleryZoom = GALLERY_ZOOM_LEVELS[next];
  applyGalleryZoom();
}
function updateGallerySelectionUi() {
  const count = selectedGalleryFiles.size;
  $("#gallery-selection-status").textContent = count ? `已选择 ${count} 张图片，可批量移入待清理` : "";
  $("#gallery-cleanup-btn").disabled = !count;
  const total = galleryItems.length;
  const selected = galleryItems.filter((it) => selectedGalleryFiles.has(galleryFileKey(galleryDirOf(it), it.file_name))).length;
  $("#gallery-select-all").textContent = total && selected === total ? "取消全选" : "全选";
}
function setGalleryReviewMode(enabled) {
  galleryReviewMode = enabled;
  const layout = $("#gallery-view");
  const button = $("#gallery-review-btn");
  const review = $("#gallery-review");
  layout.classList.toggle("review-mode", enabled);
  document.body.classList.toggle("review-active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? "退出审阅" : "审阅模式";
  if (review) review.hidden = !enabled;
  if (!enabled) {
    stopReviewIdle();
    galleryReviewIndex = -1;
    setGalleryReviewZoom("fit");
    document.querySelectorAll(".gallery-card.review-selected").forEach((el) => el.classList.remove("review-selected"));
    // 退出审阅后恢复图库网格滚动位置，不重载网格，不影响当前选中卡片
    const grid = $("#gallery-grid");
    const saved = reviewSavedGridScrollTop;
    requestAnimationFrame(() => { if (grid) grid.scrollTop = saved; });
    return;
  }
  // 进入审阅前保存网格滚动位置，退出后恢复
  const grid = $("#gallery-grid");
  if (grid) reviewSavedGridScrollTop = grid.scrollTop;
  if (galleryItems.length && galleryReviewIndex < 0) galleryReviewIndex = 0;
  renderGalleryReview();
  resetReviewIdle();
}
// ---- 审阅工具栏闲置淡出（约 1.5s 无鼠标/键盘活动后淡出，活动即恢复） ----
let reviewIdleTimer = null;
function resetReviewIdle() {
  const review = $("#gallery-review");
  if (review) review.classList.remove("toolbars-hidden");
  clearTimeout(reviewIdleTimer);
  reviewIdleTimer = setTimeout(() => {
    if (galleryReviewMode) $("#gallery-review")?.classList.add("toolbars-hidden");
  }, 1500);
}
function stopReviewIdle() {
  clearTimeout(reviewIdleTimer);
  reviewIdleTimer = null;
  $("#gallery-review")?.classList.remove("toolbars-hidden");
}
// 统一进入审阅入口：索引 clamp，选中并渲染；可被双击卡片 / 审阅按钮 / 删除后恢复调用
function openReview(index) {
  if (!galleryItems.length) return;
  if (!galleryReviewMode) setGalleryReviewMode(true);
  selectGalleryReviewItem(Math.max(0, Math.min(galleryItems.length - 1, index)));
}
// 统一退出审阅入口：Esc、左上返回、右上 × 共用；恢复图库布局且不重载网格（滚动与当前卡片保持不变）
function exitReview() {
  setGalleryReviewMode(false);
}
function setGalleryReviewZoom(mode) {
  galleryReviewZoomMode = mode === "1:1" ? "1:1" : "fit";
  const canvas = $("#gallery-review-canvas");
  if (canvas) canvas.classList.toggle("zoom-100", galleryReviewZoomMode === "1:1");
  const fitBtn = $("#gallery-review-zoom-fit");
  const oneBtn = $("#gallery-review-zoom-100");
  if (fitBtn) fitBtn.setAttribute("aria-pressed", String(galleryReviewZoomMode === "fit"));
  if (oneBtn) oneBtn.setAttribute("aria-pressed", String(galleryReviewZoomMode === "1:1"));
}
function selectGalleryReviewItem(index) {
  if (!galleryItems.length) { galleryReviewIndex = -1; renderGalleryReview(); return; }
  galleryReviewIndex = Math.max(0, Math.min(galleryItems.length - 1, index));
  const item = galleryItems[galleryReviewIndex];
  document.querySelectorAll(".gallery-card").forEach((card) =>
    card.classList.toggle("review-selected", card.dataset.file === item.file_name && card.dataset.dir === galleryDirOf(item))
  );
  renderGalleryReview();
}
function renderGalleryReview() {
  const canvas = $("#gallery-review-canvas");
  if (!canvas) return;
  canvas.classList.toggle("zoom-100", galleryReviewZoomMode === "1:1");
  const total = galleryItems.length;
  const item = galleryItems[galleryReviewIndex] ?? null;
  const prevBtn = $("#gallery-review-prev");
  const nextBtn = $("#gallery-review-next");
  const favBtn = $("#gallery-review-fav");
  const delBtn = $("#gallery-review-del");
  const countEl = $("#gallery-review-count");
  if (!item) {
    canvas.innerHTML = `<div class="empty">暂无图片</div>`;
    if (countEl) countEl.textContent = "";
    [prevBtn, nextBtn, favBtn, delBtn].forEach((b) => b && (b.disabled = true));
    return;
  }
  const imgPath = `/gallery/${encodeURIComponent(galleryDirOf(item))}/${encodeURIComponent(item.file_path.split("/").pop())}`;
  const img = document.createElement("img");
  img.className = "gallery-review-img";
  img.alt = "";
  img.src = imgPath;
  img.addEventListener("error", () => {
    // 只有当该 img 仍是当前渲染的图片时才显示失败占位，旧图的 error 不得清空新图
    if (canvas.firstChild !== img) return;
    canvas.innerHTML = `<div class="empty">图片加载失败</div>`;
  });
  canvas.innerHTML = "";
  canvas.appendChild(img);
  if (countEl) countEl.textContent = `${galleryReviewIndex + 1} / ${total}`;
  if (prevBtn) prevBtn.disabled = galleryReviewIndex <= 0;
  if (nextBtn) nextBtn.disabled = galleryReviewIndex >= total - 1;
  if (favBtn) favBtn.disabled = false;
  if (delBtn) delBtn.disabled = false;
  updateReviewFavButton(item);
}
function updateReviewFavButton(item) {
  const favBtn = $("#gallery-review-fav");
  if (!favBtn || !item) return;
  favBtn.classList.toggle("on", !!item.favorite);
  favBtn.textContent = item.favorite ? "★" : "☆";
  favBtn.title = item.favorite ? "取消收藏" : "收藏";
  favBtn.setAttribute("aria-label", item.favorite ? "取消收藏当前图片" : "收藏当前图片");
  favBtn.setAttribute("aria-pressed", String(!!item.favorite));
}
function toggleGalleryFile(dirName, fileName, checked) {
  const key = galleryFileKey(dirName, fileName);
  if (checked) selectedGalleryFiles.add(key); else selectedGalleryFiles.delete(key);
  const card = document.querySelector(`.gallery-card[data-file="${CSS.escape(fileName)}"]`);
  if (card) card.classList.toggle("selected", checked);
  updateGallerySelectionUi();
}
function toggleGallerySelectAll() {
  if (!activeGalleryDir || !galleryItems.length) return;
  const allSelected = galleryItems.every((it) => selectedGalleryFiles.has(galleryFileKey(activeGalleryDir, it.file_name)));
  galleryItems.forEach((it) => toggleGalleryFile(activeGalleryDir, it.file_name, !allSelected));
}
async function cleanupSelectedGalleryItems() {
  if (!selectedGalleryFiles.size) return;
  const items = [...selectedGalleryFiles].map((key) => {
    const [dir_name, file_name] = key.split("\u0000");
    return { dir_name, file_name };
  });
  if (!confirm(`确定把选中的 ${items.length} 张图片移入「待清理/图库」文件夹？索引会从图库中移除，文件不会直接删除。`)) return;
  try {
    const data = await api("/api/gallery/cleanup", { method: "POST", body: JSON.stringify({ items }) });
    selectedGalleryFiles.clear();
    toast(`已移入待清理：${data.count} 张`);
    await loadGalleryList();
  } catch (e) { toast("移入待清理失败：" + e.message); }
}
async function openGalleryCleanupFolder() {
  try {
    const data = await api("/api/gallery/cleanup/open", { method: "POST" });
    toast(data.created ? "已创建并打开待清理文件夹" : "已打开待清理文件夹");
  } catch (e) { toast("打开待清理文件夹失败：" + e.message); }
}

async function loadGalleryList() {
  try {
    const data = await api("/api/gallery");
    const el = $("#gallery-dir-list");
    if (!data.dirs.length) {
      activeGalleryDir = null;
      galleryItems = [];
      selectedGalleryFiles.clear();
      el.innerHTML = `<div class="empty">暂无图包目录</div>`;
      $("#gallery-title").textContent = "图库";
      $("#gallery-grid").innerHTML = `<div class="empty">点击左上「导入图包」上传 zip，或选择左侧目录查看。</div>`;
      updateGallerySelectionUi();
      pendingScroll = null;
      renderSmartCollections();
      return;
    }
    el.innerHTML = data.dirs.map((d) =>
      `<div class="tree-item gallery-dir ${d.dir_name === activeGalleryDir ? "active" : ""}" data-dir="${esc(d.dir_name)}">` +
      `${esc(d.dir_name)} <span class="gallery-dir-meta">${d.n} 图${d.favs ? ` · ★${d.favs}` : ""}</span></div>`
    ).join("");
    el.querySelectorAll(".gallery-dir").forEach((n) =>
      n.addEventListener("click", () => openGalleryDir(n.dataset.dir))
    );
    if (activeGalleryDir && !data.dirs.some((d) => d.dir_name === activeGalleryDir)) {
      activeGalleryDir = null;
      galleryItems = [];
      selectedGalleryFiles.clear();
      $("#gallery-title").textContent = "图库";
      $("#gallery-grid").innerHTML = `<div class="empty">请选择左侧目录查看图片。</div>`;
      updateGallerySelectionUi();
    }
    if (activeGalleryDir) openGalleryDir(activeGalleryDir);
    else if (activeGalleryCollection) openGalleryCollection(activeGalleryCollection.kind, activeGalleryCollection.value);
    else pendingScroll = null;
    renderSmartCollections();
  } catch (e) { toast("图库加载失败：" + e.message); }
}

// ===== Smart Collections（虚拟合集，只过滤索引，绝不移动/复制文件） =====
async function renderSmartCollections() {
  const box = $("#gallery-collection-list");
  if (!box) return;
  let meta = null;
  try { meta = await api("/api/gallery/collections"); } catch { box.innerHTML = ""; return; }
  const fixed = [
    { kind: "favorites", label: "收藏", count: meta.favorites || 0 },
    { kind: "continue_generate", label: "继续生成过", count: meta.continued || 0 },
    { kind: "restore", label: "恢复过", count: meta.restored || 0 },
  ];
  const rows = fixed.map((c) =>
    `<div class="tree-item gallery-collection ${activeGalleryCollection?.kind === c.kind && !activeGalleryCollection.value ? "active" : ""}" data-kind="${c.kind}" data-value="">` +
    `☆ ${esc(c.label)} <span class="gallery-dir-meta">${c.count}</span></div>`
  );
  for (const ch of (meta.characters || []).slice(0, 24)) {
    rows.push(
      `<div class="tree-item gallery-collection ${activeGalleryCollection?.kind === "character" && activeGalleryCollection.value === ch.identity ? "active" : ""}" data-kind="character" data-value="${esc(ch.identity)}">` +
      `👤 ${esc(ch.identity)} <span class="gallery-dir-meta">${ch.count}</span></div>`
    );
  }
  for (const t of (meta.tags || []).slice(0, 24)) {
    rows.push(
      `<div class="tree-item gallery-collection ${activeGalleryCollection?.kind === "tag" && activeGalleryCollection.value === t.tag ? "active" : ""}" data-kind="tag" data-value="${esc(t.tag)}">` +
      `# ${esc(t.tag)} <span class="gallery-dir-meta">${t.count}</span></div>`
    );
  }
  box.innerHTML = rows.join("");
  box.querySelectorAll(".gallery-collection").forEach((n) =>
    n.addEventListener("click", () => openGalleryCollection(n.dataset.kind, n.dataset.value))
  );
}

// ===== 图库日期分组（仅 nai_generated）：按 item.created_at 本地日期分组，组标题为网格内整行，不嵌套包裹卡片 =====
function galleryDateGroupOf(it) {
  const raw = it && it.created_at;
  if (!raw) return { key: "undated", label: "未标注日期" };
  const d = new Date(raw);
  if (isNaN(d.getTime())) return { key: "undated", label: "未标注日期" };
  const today = new Date();
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (key === `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`) return { key, label: "今天" };
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (key === `${y.getFullYear()}-${y.getMonth() + 1}-${y.getDate()}`) return { key, label: "昨天" };
  return { key, label: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` };
}
function galleryCardHtml(it, dirName) {
  const dir = it.dir_name || dirName;
  return `<div class="gallery-card ${it.favorite ? "fav" : ""}" data-file="${esc(it.file_name)}" data-dir="${esc(dir)}">` +
    `<input class="gallery-select" type="checkbox" aria-label="选择图片" ${selectedGalleryFiles.has(galleryFileKey(dir, it.file_name)) ? "checked" : ""} />` +
    `<img src="/gallery/${encodeURIComponent(dir)}/${encodeURIComponent(it.file_path.split("/").pop())}" loading="lazy" alt="" />` +
    `<button class="gallery-fav ${it.favorite ? "on" : ""}" title="${it.favorite ? "取消收藏" : "收藏"}">★</button>` +
    `<div class="gallery-card-prompt">${esc(it.prompt)}</div>` +
    `</div>`;
}
// 生成 #gallery-grid 的内部 HTML：非 nai_generated 保持原平铺；nai_generated 按日期顺序插标题。
// 不复制/拆分 galleryItems，卡片仍为网格直接子元素、DOM 顺序与 galleryItems 一致（审阅索引不受影响）。
// 合集模式跨目录时按条目自身 dir 分组日期；普通目录仍按 dirName。
function renderGalleryGridHtml(items, dirName) {
  const grouped = (activeGalleryCollection ? items.some((it) => (it.dir_name || dirName) === "nai_generated") : dirName === "nai_generated");
  let counts = null;
  if (grouped) {
    counts = new Map();
    items.forEach((it) => {
      const key = galleryDateGroupOf(it).key;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  }
  let html = "";
  let lastKey = null;
  items.forEach((it) => {
    if (grouped) {
      const g = galleryDateGroupOf(it);
      if (g.key !== lastKey) {
        html += `<div class="gallery-group-title" data-group-key="${esc(g.key)}"><span class="gallery-group-name">${esc(g.label)}</span><span class="gallery-group-count">${counts.get(g.key)}</span></div>`;
        lastKey = g.key;
      }
    }
    html += galleryCardHtml(it, dirName);
  });
  return html;
}
// 删除卡片后调用：移除已空的日期组标题，并刷新剩余组的计数
function refreshGalleryGroupTitles() {
  const grid = $("#gallery-grid");
  if (!grid) return;
  grid.querySelectorAll(".gallery-group-title").forEach((title) => {
    let el = title.nextElementSibling;
    let count = 0;
    while (el && !el.classList.contains("gallery-group-title")) {
      if (el.classList.contains("gallery-card")) count++;
      el = el.nextElementSibling;
    }
    if (!count) { title.remove(); return; }
    const countEl = title.querySelector(".gallery-group-count");
    if (countEl) countEl.textContent = String(count);
  });
}

// 渲染 + 绑定当前 galleryItems 到网格。dirName 仅作日期分组/回退用；每张卡片用条目自身 dir。
function renderGalleryGrid(dirName) {
  const grid = $("#gallery-grid");
  applyGalleryZoom();
  if (!galleryItems.length) {
    galleryReviewIndex = -1;
    grid.innerHTML = `<div class="empty">暂无图片</div>`;
    updateGallerySelectionUi();
    pendingScroll = null;
    return;
  }
  grid.innerHTML = renderGalleryGridHtml(galleryItems, dirName);
  updateGallerySelectionUi();
  if (pendingScroll != null) {
    const st = pendingScroll; pendingScroll = null;
    requestAnimationFrame(() => { grid.scrollTop = st; });
  }
  grid.querySelectorAll(".gallery-card").forEach((card) => {
    const itemDir = card.dataset.dir || dirName;
    const findIndex = () => galleryItems.findIndex((x) => x.file_name === card.dataset.file && (x.dir_name || dirName) === itemDir);
    const checkbox = card.querySelector(".gallery-select");
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => toggleGalleryFile(itemDir, card.dataset.file, checkbox.checked));
    card.addEventListener("click", (e) => {
      if (e.target.closest(".gallery-fav") || e.target.closest(".gallery-select")) return;
      lastGalleryCardIndex = findIndex();
      showGalleryPreview(itemDir, card.dataset.file);
      if (galleryReviewMode) selectGalleryReviewItem(findIndex());
    });
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".gallery-fav") || e.target.closest(".gallery-select")) return;
      openReview(findIndex());
    });
    card.querySelector(".gallery-fav").addEventListener("click", (e) => {
      e.stopPropagation();
      const fav = !card.classList.contains("fav");
      toggleGalleryFav(itemDir, card.dataset.file, fav);
    });
  });
  if (galleryReviewMode) selectGalleryReviewItem(Math.max(0, galleryReviewIndex));
}

async function openGalleryDir(dirName) {
  activeGalleryDir = dirName;
  activeGalleryCollection = null;
  selectedGalleryFiles.clear();
  $("#gallery-dir-list").querySelectorAll(".gallery-dir").forEach((n) =>
    n.classList.toggle("active", n.dataset.dir === dirName)
  );
  $("#gallery-title").textContent = dirName;
  $("#gallery-del-btn").style.display = "inline-block";
  try {
    const data = await api(`/api/gallery/${encodeURIComponent(dirName)}`);
    galleryItems = data.items;
    lastGalleryCardIndex = -1;
    renderGalleryGrid(dirName);
  } catch (e) { toast("目录加载失败：" + e.message); }
}

async function openGalleryCollection(kind, value) {
  activeGalleryCollection = { kind, value: value || "" };
  activeGalleryDir = null;
  selectedGalleryFiles.clear();
  $("#gallery-dir-list").querySelectorAll(".gallery-dir, .gallery-collection").forEach((n) =>
    n.classList.toggle("active", n.dataset.kind === kind && (n.dataset.value || "") === (value || ""))
  );
  $("#gallery-del-btn").style.display = "none";
  try {
    const query = value ? `?q=${encodeURIComponent(value)}` : "";
    const data = await api(`/api/gallery/collections/${encodeURIComponent(kind)}${query}`);
    galleryItems = data.items;
    lastGalleryCardIndex = -1;
    $("#gallery-title").textContent = galleryCollectionLabel(kind, value);
    renderGalleryGrid(null);
  } catch (e) { toast("合集加载失败：" + e.message); }
}

function galleryCollectionLabel(kind, value) {
  if (kind === "favorites") return "收藏";
  if (kind === "continue_generate") return "继续生成过";
  if (kind === "restore") return "恢复过";
  if (kind === "character") return `角色 · ${value || ""}`;
  if (kind === "tag") return `标签 · ${value || ""}`;
  return "合集";
}

$("#gallery-review-btn").addEventListener("click", () => {
  if (galleryReviewMode) { exitReview(); return; }
  openReview(lastGalleryCardIndex >= 0 ? lastGalleryCardIndex : 0);
});
$("#gallery-review-back").addEventListener("click", () => { exitReview(); $("#gallery-review-back").blur(); });
$("#gallery-review-exit").addEventListener("click", () => { exitReview(); $("#gallery-review-exit").blur(); });
$("#gallery-review-prev").addEventListener("click", () => { selectGalleryReviewItem(galleryReviewIndex - 1); $("#gallery-review-prev").blur(); });
$("#gallery-review-next").addEventListener("click", () => { selectGalleryReviewItem(galleryReviewIndex + 1); $("#gallery-review-next").blur(); });
$("#gallery-review-fav").addEventListener("click", (e) => { e.stopPropagation(); toggleGalleryReviewFav(); $("#gallery-review-fav").blur(); });
$("#gallery-review-del").addEventListener("click", (e) => { e.stopPropagation(); deleteGalleryReviewItem(); $("#gallery-review-del").blur(); });
$("#gallery-review-zoom-fit").addEventListener("click", () => { setGalleryReviewZoom("fit"); $("#gallery-review-zoom-fit").blur(); });
$("#gallery-review-zoom-100").addEventListener("click", () => { setGalleryReviewZoom("1:1"); $("#gallery-review-zoom-100").blur(); });
$("#gallery-review-canvas").addEventListener("dblclick", () => setGalleryReviewZoom(galleryReviewZoomMode === "1:1" ? "fit" : "1:1"));
document.addEventListener("keydown", (event) => {
  if (!galleryReviewMode || state.view !== "gallery") return;
  const target = event.target;
  if (target.matches("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "Escape") { exitReview(); return; }
  if (event.key === "f" || event.key === "F") { event.preventDefault(); setGalleryReviewZoom("fit"); return; }
  if (event.key === "1") { event.preventDefault(); setGalleryReviewZoom("1:1"); return; }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  selectGalleryReviewItem(galleryReviewIndex + (event.key === "ArrowRight" ? 1 : -1));
});
// 审阅模式下鼠标/键盘活动即恢复工具栏，闲置约 1.5s 后淡出
document.addEventListener("mousemove", () => { if (galleryReviewMode) resetReviewIdle(); }, { passive: true });
document.addEventListener("keydown", () => { if (galleryReviewMode) resetReviewIdle(); });

async function showGalleryPreview(dirName, fileName) {
  const seq = ++galleryPreviewSeq;
  let it = galleryItems.find((x) => x.file_name === fileName && (x.dir_name || "") === dirName);
  if (!it) {
    try {
      const data = await api(`/api/gallery/${encodeURIComponent(dirName)}`);
      if (seq !== galleryPreviewSeq) return; // 过期响应，丢弃，避免覆盖较新的选中项
      it = data.items.find((x) => x.file_name === fileName);
      if (!it) return;
    } catch (e) { toast("预览失败：" + e.message); return; }
  }
  try {
    const dir = galleryDirOf(it);
    const body = $("#gallery-preview-body");
    const imgPath = `/gallery/${encodeURIComponent(dir)}/${encodeURIComponent(it.file_path.split("/").pop())}`;
    const parentLine = it.parent ? `<div class="gallery-parent">来源：${it.parent.available ? `<a href="#" data-parent-dir="${esc(it.parent.dir_name)}" data-parent-file="${esc(it.parent.file_name)}">${esc(it.parent.prompt || it.parent.file_name)}</a>` : `<span class="gallery-parent-missing">已不可用</span>`}</div>` : "";
    body.innerHTML =
      `<img src="${imgPath}" class="gallery-preview-img" alt="" />` +
      parentLine +
      (() => { const recipe = naiRecipeFromItem(it), settings = recipe.settings || recipe; return `<dl class="gallery-meta"><dt>Prompt</dt><dd>${esc(it.prompt || "")}</dd><dt>Negative</dt><dd>${esc(it.negative_prompt || "")}</dd><dt>Seed</dt><dd>${esc(settings.seed ?? it.seed ?? "-")}</dd><dt>Model</dt><dd>${esc(settings.model ?? it.model ?? "-")}</dd></dl>`; })() +
      `<div class="gallery-preview-actions"><button class="primary" id="gallery-continue-btn">继续生成</button><button class="ghost" id="gallery-fav-btn">${it.favorite ? "取消收藏 ★" : "收藏 ☆"}</button></div>` +
      `<div class="gallery-recipe-actions"><button id="gallery-recipe-seed">复用 Seed</button><button id="gallery-recipe-img2img">用作图生图</button><button id="gallery-recipe-copy-prompt">复制 Prompt</button></div>` +
      (it.snapshot_id ? `<details class="gallery-partial-restore"><summary>部分恢复 ▾</summary><div class="gallery-restore-actions"><button data-restore-sections="">全部加载</button><button data-restore-sections="character,appearance,clothing,expression,action">加载角色</button><button data-restore-sections="style,quality">加载画风</button><button data-restore-sections="composition,scene">加载构图</button></div></details>` : "");
    // 主按钮：恢复完整生成配置 + 跳转生图 + 聚焦 Prompt；记录 continue 事件并带父级血缘。
    $("#gallery-continue-btn").addEventListener("click", async () => {
      const meta = extractMetaFromGalleryItem(it);
      sendGalleryEvent(it, "continue_generate");
      setGenerationParent(it);
      await showView("generate");
      applyGenerationConfig(meta);
      $("#nai-editor")?.focus();
    });
    $("#gallery-fav-btn").addEventListener("click", () => {
      toggleGalleryFav(dir, it.file_name, !it.favorite);
      showGalleryPreview(dir, it.file_name);
    });
    $("#gallery-recipe-seed").addEventListener("click", async () => {
      const meta = extractMetaFromGalleryItem(it);
      if (meta.seed != null) {
        await showView("generate");
        $("#nai-seed").value = String(meta.seed);
        $("#nai-seed-mode").value = "fixed";
        toast(`Seed ${meta.seed} 已填入（Fixed 模式）`);
      } else { toast("该图无 Seed 信息"); }
    });
    $("#gallery-recipe-copy-prompt").addEventListener("click", async () => {
      const meta = extractMetaFromGalleryItem(it);
      const text = meta.effectivePrompt || meta.rawPrompt || it.prompt || "";
      try { await navigator.clipboard.writeText(text); toast("Prompt 已复制"); }
      catch { const restored = naiResolveRestoredPrompt(meta.rawPrompt, meta.rawNegative, meta.characterPrompts); naiApplyRestoredPrompt(restored.basePrompt, restored.globalUc, restored.characters); toast("已填入 Prompt 框"); }
    });
    $("#gallery-recipe-img2img").addEventListener("click", async () => { await showView("generate"); await naiUseImageSource(imgPath, it.file_name || "图库图片"); toast("已设为图生图基础图"); });
    body.querySelectorAll("[data-restore-sections]").forEach((b) => b.addEventListener("click", () => {
      sendGalleryEvent(it, "restore");
      setGenerationParent(it);
      restoreSnapshot(it.snapshot_id, b.dataset.restoreSections);
    }));
    body.querySelector("[data-parent-dir]")?.addEventListener("click", (e) => {
      e.preventDefault();
      openGalleryDir(it.parent.dir_name);
    });
  } catch (e) { toast("预览失败：" + e.message); }
}

async function toggleGalleryFav(dirName, fileName, fav) {
  try {
    await api("/api/gallery/favorite", { method: "POST", body: JSON.stringify({ dir_name: dirName, file_name: fileName, favorite: fav }) });
    // 更新卡片状态
    const card = document.querySelector(`.gallery-card[data-file="${CSS.escape(fileName)}"][data-dir="${CSS.escape(dirName)}"]`) || document.querySelector(`.gallery-card[data-file="${CSS.escape(fileName)}"]`);
    if (card) { card.classList.toggle("fav", fav); card.querySelector(".gallery-fav").classList.toggle("on", fav); }
    toast(fav ? "已收藏" : "已取消收藏");
    loadGalleryList();
  } catch (e) { toast("操作失败：" + e.message); }
}

async function toggleGalleryReviewFav() {
  const item = galleryItems[galleryReviewIndex];
  if (!item || !galleryDirOf(item)) return;
  const dir = galleryDirOf(item);
  const fav = !item.favorite;
  try {
    await api("/api/gallery/favorite", { method: "POST", body: JSON.stringify({ dir_name: dir, file_name: item.file_name, favorite: fav }) });
    item.favorite = fav;
    const card = document.querySelector(`.gallery-card[data-file="${CSS.escape(item.file_name)}"][data-dir="${CSS.escape(dir)}"]`) || document.querySelector(`.gallery-card[data-file="${CSS.escape(item.file_name)}"]`);
    if (card) { card.classList.toggle("fav", fav); card.querySelector(".gallery-fav")?.classList.toggle("on", fav); }
    updateReviewFavButton(item);
    toast(fav ? "已收藏" : "已取消收藏");
  } catch (e) { toast("操作失败：" + e.message); }
}

async function deleteGalleryReviewItem() {
  const item = galleryItems[galleryReviewIndex];
  if (!item || !galleryDirOf(item)) return;
  const dir = galleryDirOf(item);
  if (!confirm(`确定删除当前图片「${item.file_name}」？图片会移入项目「待清理」文件夹，图库索引将移除。`)) return;
  const oldIndex = galleryReviewIndex;
  const remaining = galleryItems.length - 1;
  try {
    await api("/api/gallery/item/delete", { method: "POST", body: JSON.stringify({ dir_name: dir, file_name: item.file_name }) });
    if (remaining <= 0) {
      // 目录清空：退出审阅并显示空状态
      galleryItems = [];
      galleryReviewIndex = -1;
      setGalleryReviewMode(false);
      $("#gallery-grid").innerHTML = `<div class="empty">暂无图片</div>`;
      $("#gallery-preview-body").innerHTML = `<div class="empty">点击图片查看大图与提示词</div>`;
      updateGallerySelectionUi();
    } else {
      // 删除当前项后，翻到「下一张」；若删的是最后一张则回退到上一张
      galleryReviewIndex = Math.min(oldIndex, remaining - 1);
      galleryItems = galleryItems.filter((x) => x.file_name !== item.file_name);
      selectedGalleryFiles.delete(galleryFileKey(dir, item.file_name));
      document.querySelector(`.gallery-card[data-file="${CSS.escape(item.file_name)}"][data-dir="${CSS.escape(dir)}"]`)?.remove();
      refreshGalleryGroupTitles();
      updateGallerySelectionUi();
      renderGalleryReview();
    }
    loadGalleryList(); // 刷新目录计数；openGalleryDir 会重渲染网格并恢复审阅视图
    toast("已删除当前图片");
  } catch (e) { toast("删除失败：" + e.message); }
}

async function handleGalleryUpload() {
  const file = $("#gallery-file").files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("upload", file);
  $("#gallery-import-btn").textContent = "导入中…";
  $("#gallery-import-btn").disabled = true;
  try {
    const r = await fetch("/api/gallery/import", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "导入失败");
    toast(`导入成功：${data.imported} 张，跳过 ${data.skipped}，失败 ${data.failed}`);
    activeGalleryDir = data.dir;
    await loadGalleryList();
  } catch (e) {
    toast("导入失败：" + e.message);
  } finally {
    $("#gallery-import-btn").textContent = "导入图包";
    $("#gallery-import-btn").disabled = false;
    $("#gallery-file").value = "";
  }
}

async function deleteGalleryDir() {
  if (!activeGalleryDir) return;
  if (!confirm(`确定移除图库目录「${activeGalleryDir}」？图片会移到项目「待清理」目录，索引会从图库中移除。`)) return;
  try {
    const r = await fetch(`/api/gallery/${encodeURIComponent(activeGalleryDir)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
    activeGalleryDir = null;
    $("#gallery-preview-body").innerHTML = `<div class="empty">点击图片查看大图与提示词</div>`;
    await loadGalleryList();
    toast("已移到待清理目录");
  } catch (e) { toast("移除失败：" + e.message); }
}

// ===== NovelAI 生图（三栏工作台，联动 8787 服务） =====
const NAI_SERVER = (localStorage.getItem("nai_server") || (location.port === "8787" ? location.origin : "http://127.0.0.1:8787")).replace(/\/+$/, "");
let naiSSEOpened = false;
let naiPhase = "ready";        // ready|submitting|generating|retrieving|saving|complete|error|cancelled
let naiImages = [];            // Python 图库 nai_generated 图片列表
let naiIdx = -1;               // viewer 当前索引
let naiZoom = 1;               // 1 = Fit，其他为缩放倍数
let naiApiBatchId = null;
let naiApiConfigured = false;
let naiSubscriptionTier = "unknown";
let naiGenerationMode = "txt2img";
let naiImg2ImgSource = null;
let naiCharacters;
// P0: Generation 档位 & Prompt Compiler state
// positive tier: off | standard | light；negative tier: off | light | heavy | furry_focus | human_focus
// 默认 standard + heavy 以保持当前 V5 Full 默认行为。
let naiPositiveTier = "standard";
let naiNegativeTier = "heavy";
let naiTransparentBg = false;
// 生成血缘：显式「继续生成 / 恢复」后设置，随下一次 naiGenerate 写入 meta.parent，随后立即清空，
// 避免无关的空白工作区生图误带父级。
let naiGenerationParent = null;

// 档位值规范化：正面档位旧值 v5_standard 兼容映射为 standard；未知值回退默认。
function naiNormalizePositiveTier(value) {
  if (value === "standard" || value === "light") return value;
  if (value === "v5_standard") return "standard"; // 旧 localStorage/metadata 值兼容
  return "off";
}
function naiNormalizeNegativeTier(value) {
  if (value === "light" || value === "heavy" || value === "furry_focus" || value === "human_focus") return value;
  if (value === "off") return "off";
  return "heavy"; // 旧/未知值回退默认 heavy
}

// 旧 metadata/localStorage 兼容：旧 qualityTags=true/false -> standard/off
// 旧 heavyUc=true/false -> heavy/off
{
  // 新档位键优先。
  const newPos = localStorage.getItem("nai_positive_tier");
  const newNeg = localStorage.getItem("nai_negative_tier");
  if (newPos !== null) naiPositiveTier = naiNormalizePositiveTier(newPos);
  if (newNeg !== null) naiNegativeTier = naiNormalizeNegativeTier(newNeg);
  // 旧 metadata 兼容。
  const legacyPos = localStorage.getItem("nai_quality_tags");
  const legacyNegRaw = localStorage.getItem("nai_heavy_uc");
  const legacyUcPreset = localStorage.getItem("nai_uc_preset");
  if (newNeg === null && legacyUcPreset !== null) {
    naiNegativeTier = naiNormalizeNegativeTier(legacyUcPreset);
  } else if (newNeg === null && legacyNegRaw !== null) {
    naiNegativeTier = legacyNegRaw === "false" ? "off" : "heavy";
  }
  if (newPos === null && legacyPos !== null) naiPositiveTier = legacyPos === "false" ? "off" : "standard";
}

function naiNormalizeNumberInput(v, fallback = null) {
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function naiSetSelectValue(id, value, fallback) {
  const el = $(id);
  const desired = String(value || fallback || "");
  if ([...el.options].some((option) => option.value === desired)) el.value = desired;
}

const NAI_RESOLUTION_PRESETS = Object.freeze({
  small_portrait: { width: 512, height: 768, category: "small", maxCount: 6 },
  small_square: { width: 640, height: 640, category: "small", maxCount: 6 },
  small_landscape: { width: 768, height: 512, category: "small", maxCount: 6 },
  normal_portrait: { width: 832, height: 1216, category: "normal", maxCount: 4 },
  normal_square: { width: 1024, height: 1024, category: "normal", maxCount: 4 },
  normal_landscape: { width: 1216, height: 832, category: "normal", maxCount: 4 },
  large_portrait: { width: 1024, height: 1536, category: "large", maxCount: 4 },
  large_square: { width: 1472, height: 1472, category: "large", maxCount: 4 },
  large_landscape: { width: 1536, height: 1024, category: "large", maxCount: 4 },
});

function naiResolutionPresetForSize(width, height) {
  return Object.entries(NAI_RESOLUTION_PRESETS).find(([, preset]) => preset.width === Number(width) && preset.height === Number(height))?.[0] || "custom";
}

function naiBatchMaxCount() {
  const configured = Number(userSettings.novelai_batch_max_count);
  return Number.isInteger(configured) ? Math.max(1, Math.min(6, configured)) : 6;
}

function naiSyncCountOptions() {
  const count = $("#nai-count");
  const prior = Number(count.value) || 1;
  const maxCount = naiBatchMaxCount();
  count.max = String(maxCount);
  count.value = String(Math.max(1, Math.min(prior, maxCount)));
}

function naiApplyResolutionPreset() {
  const key = $("#nai-resolution-category").value;
  const preset = NAI_RESOLUTION_PRESETS[key];
  if (preset) {
    $("#nai-width").value = preset.width;
    $("#nai-height").value = preset.height;
    naiSyncCountOptions();
    naiToggleCustomResolution();
    return preset;
  }
  naiSyncCountOptions();
  naiToggleCustomResolution();
  return null;
}

function naiSyncResolutionFromInputs() {
  const key = naiResolutionPresetForSize($("#nai-width").value, $("#nai-height").value);
  $("#nai-resolution-category").value = key;
  naiSyncCountOptions();
  naiToggleCustomResolution();
}

// 仅当 Resolution = Custom 时显示原始宽高输入
function naiToggleCustomResolution() {
  const box = $("#nai-custom-resolution");
  if (!box) return;
  box.hidden = $("#nai-resolution-category").value !== "custom";
}

function naiRecipeFromItem(item) {
  const parameters = item?.parameters && typeof item.parameters === "object" ? item.parameters : {};
  return parameters.recipe && typeof parameters.recipe === "object" ? parameters.recipe : parameters;
}

function naiImageUrl(item) {
  return item ? `/gallery/nai_generated/${encodeURIComponent(item.file_path.split("/").pop())}` : "";
}

function naiSetMode(mode) {
  naiGenerationMode = mode === "img2img" ? "img2img" : "txt2img";
  document.querySelectorAll("[data-nai-mode]").forEach((button) => button.classList.toggle("active", button.dataset.naiMode === naiGenerationMode));
  $("#nai-img2img-panel").hidden = naiGenerationMode !== "img2img";
  naiRenderCost();
}

function naiRenderImg2ImgSource() {
  const preview = $("#nai-img2img-preview");
  preview.innerHTML = naiImg2ImgSource?.dataUrl
    ? `<img src="${esc(naiImg2ImgSource.dataUrl)}" alt="图生图基础图" /><span>${esc(naiImg2ImgSource.name || "基础图")}</span>`
    : `<span>尚未选择图片</span>`;
}

function naiReadBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function naiPersistImg2ImgSource(dataUrl, name) {
  const response = await fetch(`${NAI_SERVER}/api/novelai/img2img-source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_image: dataUrl, source_image_name: name }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "基础图保存失败");
  return result;
}

async function naiUseImageSource(url, name = "历史图") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`基础图读取失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  naiImg2ImgSource = { dataUrl: await naiReadBlobAsDataUrl(blob), path: url, name };
  naiSetMode("img2img");
  naiRenderImg2ImgSource();
}

function naiRenderCharacters() {
  const tabsBox = $("#nai-character-tabs");
  const list = $("#nai-character-list");
  const count = document.getElementById("nai-character-count");
  if (count) count.textContent = String(naiCharacters.length);
  rebuildNaiTagTarget();
  // 悬空 activeNaiTarget 回退 base
  if (activeNaiTarget !== "base" && !naiCharacters[activeNaiTarget]) activeNaiTarget = "base";
  // Tab 条：Base（静态）+ Character N（动态，插在「+ 角色」前）
  if (tabsBox) {
    const addBtn = tabsBox.querySelector("#nai-character-add");
    const baseBtn = tabsBox.querySelector('[data-nai-char-tab="base"]');
    tabsBox.querySelectorAll("[data-nai-char-tab]").forEach((b) => { if (b !== baseBtn) b.remove(); });
    naiCharacters.forEach((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nai-char-tab ${activeNaiTarget === i ? "active" : ""}`;
      b.dataset.naiCharTab = String(i);
      const identity = String(state.prompt?.characters?.[i]?.name || "").trim();
      const generic = `Character ${i + 1}`;
      b.textContent = identity && identity !== generic ? `${generic} · ${identity}` : generic;
      tabsBox.insertBefore(b, addBtn);
    });
    baseBtn?.classList.toggle("active", activeNaiTarget === "base");
  }
  if (activeNaiTarget === "base") {
    list.innerHTML = `<div class="empty">Base Prompt 在顶部编辑</div>`;
    return;
  }
  const index = activeNaiTarget;
  const character = state.prompt?.characters?.[index];
  if (!character) { list.innerHTML = `<div class="empty">暂无独立角色</div>`; return; }
  const manual = !!character.position;
  // 角色设置：可折叠，仅 角色名 / Position / X·Y / 上移·下移 / 移除；绝不内嵌 textarea
  // （该角色 Prompt / UC 一律在顶部单一 #nai-editor 编辑）。
  list.innerHTML = `<details class="nai-character" data-character-index="${index}" open>
    <summary class="nai-character-head">
      <input type="text" class="nai-character-name" data-character-name value="${esc(character.name || `Character ${index + 1}`)}" placeholder="角色名" aria-label="角色名" />
      <span class="nai-character-head-actions">
        <button type="button" data-character-move="up" title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-character-move="down" title="下移" ${index === naiCharacters.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" data-character-remove title="移除角色">×</button>
      </span>
    </summary>
    <div class="nai-character-body">
      <label class="nai-character-position"><input type="checkbox" data-character-manual ${manual ? "checked" : ""} /><span>手动位置</span></label>
      <div class="nai-coordinate-row" ${manual ? "" : "hidden"}>
        <label><span>X</span><input type="number" min="0" max="1" step="0.05" data-character-field="x" value="${character.position?.x ?? 0.5}" /></label>
        <label><span>Y</span><input type="number" min="0" max="1" step="0.05" data-character-field="y" value="${character.position?.y ?? 0.5}" /></label>
      </div>
      <p class="nai-character-hint">在顶部单一编辑器编辑该角色 Prompt / UC。</p>
    </div>
  </details>`;
}

function naiAddCharacter(character = {}) {
  window.PromptBridge.dispatch({ type: "ADD_CHARACTER", payload: character });
  activeNaiTarget = (state.prompt?.characters?.length || 1) - 1;
  workbenchCharIndex = activeNaiTarget;
  window.PromptBridge.setActiveTarget(`char:${activeNaiTarget}`);
  naiRenderCharacters();
  renderWorkbenchEditorFromDocument({ force: true });
}

function naiCollectCharacters() {
  // NAI v4 multi-prompt shape：{ prompt, negative_prompt, position }，来自 PromptDocument 权威。
  return promptDocument.buildGenerationPromptState(state.prompt).characters
    .map((character) => ({ prompt: character.prompt, negative_prompt: character.uc, position: character.position ? { ...character.position } : null }))
    .filter((character) => character.prompt);
}

function naiCollectParameters() {
  const number = (id, dflt = null) => naiNormalizeNumberInput($(id).value, dflt);
  const seedText = $("#nai-seed").value.trim();
  const seed = seedText === "" ? null : Number(seedText);
  return {
    model: $("#nai-model").value,
    width: number("#nai-width"), height: number("#nai-height"),
    resolution_category: $("#nai-resolution-category").value,
    count: number("#nai-count", 1),
    seed_mode: $("#nai-seed-mode").value || "random",
    seed: Number.isInteger(seed) ? seed : null,
    steps: number("#nai-steps"), guidance: number("#nai-guidance"),
    sampler: $("#nai-sampler").value,
    scheduler: $("#nai-scheduler")?.value || "karras",
    cfg_rescale: number("#nai-cfg-rescale", 0),
    auto_smea: $("#nai-auto-smea")?.value === "true",
    positive_tier: naiPositiveTier,
    negative_tier: naiNegativeTier,
    transparent_bg: naiTransparentBg,
  };
}

// ---- P0: Effective Preview ----
// 编译参数（Preview 与实际发送共用，避免分叉）。
// 返回 { result, params }，result 为 compileGenerationPrompts 的详细编译结果。
function naiCompileGeneration(rawPrompt, rawNegative) {
  const params = naiCollectParameters();
  const { compileGenerationPrompts } = window.PromptCompiler;
  const result = compileGenerationPrompts(rawPrompt, rawNegative, params.model, {
    positiveTier: naiPositiveTier,
    negativeTier: naiNegativeTier,
    transparentBackground: naiTransparentBg,
  });
  return { result, params };
}

function naiUpdateEffectivePreview() {
  // 生成视图只读 PromptDocument 权威：Base/UC 一律来自 buildGenerationPromptState，
  // 绝不读 #nai-prompt / #nai-neg textarea。
  const generation = promptDocument.buildGenerationPromptState(state.prompt);
  const rawPrompt = generation.basePrompt;
  const rawNeg = generation.globalUc;
  const { result, params } = naiCompileGeneration(rawPrompt, rawNeg);
  const preset = NAI_RESOLUTION_PRESETS[params.resolution_category];
  const resolutionStr = preset ? `${preset.width}×${preset.height}` : `${params.width}×${params.height}`;
  const seedStr = params.seed_mode === "random" ? "Random" : String(params.seed ?? "-");
  if ($("#nai-effective-prompt")) $("#nai-effective-prompt").textContent = result.effectivePositive || "(空)";
  if ($("#nai-effective-negative")) $("#nai-effective-negative").textContent = result.effectiveNegative || "(空)";
  if ($("#nai-source-positive-user")) $("#nai-source-positive-user").textContent = result.userPositive.length ? result.userPositive.join(", ") : "(无)";
  if ($("#nai-source-positive-auto")) $("#nai-source-positive-auto").textContent = result.autoPositive.length ? result.autoPositive.join(", ") : "(无)";
  if ($("#nai-source-negative-user")) $("#nai-source-negative-user").textContent = result.userNegative.length ? result.userNegative.join(", ") : "(无)";
  if ($("#nai-source-negative-auto")) $("#nai-source-negative-auto").textContent = result.autoNegative.length ? result.autoNegative.join(", ") : "(无)";
  if ($("#nai-suppressed-auto")) {
    // WEBUI PARITY：跨极性冲突仅 warning，不删除任何 token。
    // 优先使用 crossPolarityWarnings（含用户两侧同 token 冲突）；为空则回退显示 userCrossPolarityConflicts。
    const warnings = result.crossPolarityWarnings ?? [...(result.suppressedAuto?.positive || []), ...(result.suppressedAuto?.negative || []), ...(result.userCrossPolarityConflicts || [])];
    $("#nai-suppressed-auto").textContent = warnings.length ? warnings.join(", ") : "(无)";
  }
  if ($("#nai-user-conflicts")) $("#nai-user-conflicts").textContent = result.userCrossPolarityConflicts.length ? result.userCrossPolarityConflicts.join(", ") : "(无)";
  if ($("#nai-eff-model")) $("#nai-eff-model").textContent = params.model;
  if ($("#nai-eff-resolution")) $("#nai-eff-resolution").textContent = resolutionStr;
  if ($("#nai-eff-sampler")) $("#nai-eff-sampler").textContent = params.sampler;
  if ($("#nai-eff-scheduler")) $("#nai-eff-scheduler").textContent = params.scheduler || "karras";
  if ($("#nai-eff-steps")) $("#nai-eff-steps").textContent = params.steps;
  if ($("#nai-eff-cfg")) $("#nai-eff-cfg").textContent = params.guidance;
  if ($("#nai-eff-seed")) $("#nai-eff-seed").textContent = seedStr;
}

// 纯 formatter：把 Base + 角色 + Global UC 拼成与 /api/export structured 同构的多行文本
// （Base: / Character N: / Character N UC: / Global UC:）。
// 仅作导出/调试展示用，绝不写回 Workbench Base textarea，也不参与正常编辑/生成同步。
function naiStructuredDisplayText(basePrompt, characters, globalUc) {
  const lines = [];
  if (String(basePrompt || "").trim()) lines.push(`Base: ${String(basePrompt).trim()}`);
  (characters || []).forEach((c, i) => {
    const name = `Character ${i + 1}`;
    if (String(c?.prompt || "").trim()) lines.push(`${name}: ${String(c.prompt).trim()}`);
    if (String(c?.negative_prompt || "").trim()) lines.push(`${name} UC: ${String(c.negative_prompt).trim()}`);
  });
  if (String(globalUc || "").trim()) lines.push(`Global UC: ${String(globalUc).trim()}`);
  return lines.join("\n");
}

function naiMatchesOpusFreeRule(parameters) {
  const preset = NAI_RESOLUTION_PRESETS[naiResolutionPresetForSize(parameters.width, parameters.height)];
  return naiGenerationMode === "txt2img"
    && Number(parameters.steps) <= 28
    // 本项目的本地队列严格串行，每个上游请求的 n_samples 固定为 1。
    // 免 Anlas 仅标记官方明确的 Normal 尺寸条件；Small、Large 和自定义尺寸不作免费承诺。
    && preset?.category === "normal";
}

function naiRenderCost() {
  const el = $("#nai-cost");
  const parameters = naiCollectParameters();
  const count = Math.max(1, Math.min(naiBatchMaxCount(), Math.floor(Number(parameters.count) || 1)));
  const eligible = naiMatchesOpusFreeRule(parameters);
  const isV5 = String(parameters.model || "").startsWith("nai-diffusion-5-");
  if (eligible && naiSubscriptionTier === "opus") {
    el.className = "nai-cost";
    el.innerHTML = `<span>Opus 串行队列 · ${count} 张分别发送${isV5 ? " · V5 使用额度" : ""}</span><strong>预计 0 Image Anlas</strong>`;
    el.title = `本地批处理会逐张串行请求；当前为文生图、Normal、≤28 Steps，符合 Opus 单张免 Image Anlas 条件。${isV5 ? "V5 仍受 Opus 使用额度限制；额度耗尽后的费用以 NovelAI 实际扣费为准。" : ""}`;
  } else if (eligible) {
    el.className = "nai-cost unknown";
    el.innerHTML = `<span>Opus 串行规则 · ${count} 张分别发送</span><strong>${naiSubscriptionTier === "unknown" ? "正在确认订阅方案" : "当前套餐不免 Anlas"}</strong>`;
    el.title = "本地批处理逐张发送，不会触发“同时生成多张”的收费条件；但免 Image Anlas 仅适用于 Opus。当前套餐的实际费用请以 NovelAI 返回结果为准。";
  } else {
    el.className = "nai-cost paid";
    el.innerHTML = `<span>不满足 Opus 单张免 Anlas 条件（${count} 张串行）</span><strong>费用以 NovelAI 实际扣费为准</strong>`;
    el.title = "免 Image Anlas 需要 Opus、文生图、Normal 尺寸、≤28 Steps，且每个上游请求仅一张。图生图、Small/Large/自定义尺寸或更高 Steps 不在本地免费承诺范围内。";
  }
  const btn = $("#nai-gen");
  if (["ready", "complete", "error", "cancelled"].includes(naiPhase)) {
    btn.textContent = naiApiConfigured ? "Generate" : "Generate · 未配置 Token";
    btn.disabled = !naiApiConfigured;
  }
}

function updateNaiPromptMeta() {
  const editor = $("#nai-editor");
  if (!editor) return;
  const text = editor.value.trim();
  const n = text ? text.split(",").filter((x) => x.trim()).length : 0;
  $("#nai-prompt-meta").textContent = `${n} tags · ${text.length} 字符`;
}

function naiSetJob(text, cls) {
  const b = $("#nai-job");
  b.textContent = text;
  b.className = "nai-job" + (cls ? " " + cls : "");
}

function naiSetPhase(phase, msg) {
  naiPhase = phase;
  const btn = $("#nai-gen");
  const cancel = $("#nai-cancel");
  const job = $("#nai-job");
  const old = job.querySelector(".nai-progress");
  if (old) old.remove();
  const active = ["submitting", "generating", "retrieving", "saving"].includes(phase);
  btn.disabled = active || !naiApiConfigured;
  cancel.disabled = !["generating", "retrieving", "saving"].includes(phase);
  switch (phase) {
    case "ready": btn.textContent = "Generate"; naiSetJob("Ready"); naiRenderCost(); break;
    case "submitting": btn.textContent = "Submitting..."; naiSetJob("Submitting..."); job.insertAdjacentHTML("beforeend", '<div class="nai-progress"></div>'); break;
    case "generating": btn.textContent = "Generating..."; naiSetJob("Generating with NovelAI..."); job.insertAdjacentHTML("beforeend", '<div class="nai-progress"></div>'); break;
    case "retrieving": btn.textContent = "Retrieving..."; naiSetJob("Retrieving image..."); break;
    case "saving": btn.textContent = "Saving..."; naiSetJob("Saving to library..."); break;
    case "complete": btn.textContent = "Generate"; naiSetJob("Saved to library", "ok"); naiRenderCost(); break;
    case "error": btn.textContent = "Generate"; naiSetJob(msg || "生成失败", "err"); naiRenderCost(); break;
    case "cancelled": btn.textContent = "Generate"; naiSetJob("已取消", "err"); naiRenderCost(); break;
  }
}

async function loadNaiApiStatus() {
  const status = $("#nai-api-status");
  status.textContent = "正在连接 NovelAI…";
  status.className = "nai-live";
  try {
    const r = await fetch(`${NAI_SERVER}/api/novelai/status`);
    const j = await r.json().catch(() => ({}));
    naiApiConfigured = !!j.configured && j.state === "connected";
    naiSubscriptionTier = j.subscriptionTier || "unknown";
    const network = j.network && j.network !== "direct" ? " · 本机代理" : " · 直连";
    const labels = {
      unconfigured: "未配置 NovelAI API Token，请在设置中填写",
      connected: `NovelAI 已连接${network}`,
      unreachable: j.error || "无法连接 NovelAI，请检查代理",
    };
    status.textContent = labels[j.state] || j.error || `NovelAI 连接检查失败（${j.code || r.status}）`;
    status.className = "nai-live " + (naiApiConfigured ? "ok" : "err");
    if (["ready", "complete", "error", "cancelled"].includes(naiPhase)) {
      $("#nai-gen").disabled = !naiApiConfigured;
      $("#nai-gen").textContent = naiApiConfigured ? "Generate" : "Generate · 暂不可用";
    }
    naiRenderCost();
    return j;
  } catch (e) {
    naiApiConfigured = false;
    naiSubscriptionTier = "unknown";
    status.textContent = `NovelAI 本地服务未启动：${NAI_SERVER}`;
    status.className = "nai-live err";
    $("#nai-gen").disabled = true;
    $("#nai-gen").textContent = "Generate · 服务未启动";
    return null;
  }
}

function initGenerateView() {
  naiSetMode(naiGenerationMode);
  naiRenderImg2ImgSource();
  // 进入生图视图时让 naiCharacters 单向镜像 state.prompt.characters（权威状态），
  // 避免直接导航进入时 view adapter 与购物车角色数不一致。
  syncNaiCharactersFromState();
  naiRenderCharacters();
  renderWorkbenchEditorFromDocument({ force: true });
  naiUpdateRangeLabels();
  naiSyncResolutionFromInputs();
  naiRenderCost();
  loadNaiGallery();
  loadNaiApiStatus();
  // P0: Initialize 档位选择器（正面 / 负面）
  naiSetSelectValue("#nai-positive-tier", naiPositiveTier, "standard");
  naiSetSelectValue("#nai-negative-tier", naiNegativeTier, "heavy");
  naiUpdateTierHint();
  naiUpdateEffectivePreview();
  if (!naiSSEOpened) { naiSSEOpened = true; naiSSE(); }
}

// 更新档位提示：档位内容为「用户提供的官方档位事实」，统一应用于所有模型家族；
// V5 Curated 不伪造专属差异，也不声称已抓到 Curated 专属 payload。
function naiUpdateTierHint() {
  const hint = $("#nai-tier-hint");
  if (!hint) return;
  const model = $("#nai-model").value;
  const notes = [];
  if (model === "nai-diffusion-5-curated") {
    notes.push("V5 Curated 与 V5 Full 使用同一官方档位内容（用户提供的官方档位事实），不声称抓到 Curated 专属 payload");
  }
  if (naiNegativeTier === "off") {
    notes.push("负面档位为关闭：客户端不注入自动 UC，且请求层发送 uc_preset=off（不发送 heavy）");
  }
  hint.textContent = notes.join("；");
  hint.classList.toggle("show", notes.length > 0);
}

async function naiGenerate() {
  // 生成只读 PromptDocument 权威：Base/UC/角色一律来自 buildGenerationPromptState，
  // 绝不读 #nai-prompt / #nai-neg；编译与预览共用同一份输入，保证 Preview == payload。
  const generation = promptDocument.buildGenerationPromptState(state.prompt);
  const prompt = generation.basePrompt;
  const negativePrompt = generation.globalUc;
  if (!prompt.trim()) { toast("提示词为空"); return; }
  if (!naiApiConfigured) { toast("未配置 NovelAI 官方 API Token，已阻止生成"); return; }
  const parameters = naiCollectParameters();
  const compiled = naiCompileGeneration(prompt.trim(), negativePrompt).result;
  const generationPrompt = compiled.effectivePositive;
  const generationNegative = compiled.effectiveNegative;
  const characters = naiCollectCharacters();
  const maxCount = naiBatchMaxCount();
  const count = Math.max(1, Math.min(maxCount, Number(parameters.count) || 1));
  if (["fixed", "increment"].includes(parameters.seed_mode) && !Number.isInteger(parameters.seed)) {
    toast("Fixed/Increment 模式需要整数 Seed"); return;
  }
  if (naiGenerationMode === "img2img" && !naiImg2ImgSource?.dataUrl) {
    toast("图生图需要先选择基础图片"); return;
  }
  const img2img = naiGenerationMode === "img2img" ? {
    source_image: naiImg2ImgSource.dataUrl,
    source_image_path: naiImg2ImgSource.path || null,
    source_image_name: naiImg2ImgSource.name || null,
    strength: Number($("#nai-strength").value),
    noise: Number($("#nai-noise").value),
  } : null;
  const generationState = { ...parameters, mode: naiGenerationMode, characters, img2img: img2img ? { ...img2img, source_image: undefined } : null };
  const savedSnapshot = await saveSnapshot({ positive_prompt: generationPrompt, negative_prompt: generationNegative, structured_state: state.prompt, generation: generationState, quiet: true });
  if (!savedSnapshot || !pendingSnapshotId) { toast("正式生成前保存快照失败，已阻止生成"); return; }
  const snapshotId = pendingSnapshotId;
  updateAdvSummary(parameters);
  naiSetPhase("submitting");
  try {
    const meta = {
      rawPrompt: prompt,
      effectivePrompt: generationPrompt,
      rawNegative: negativePrompt,
      effectiveNegative: generationNegative,
      promptSources: {
        userPositive: compiled.userPositive,
        autoPositive: compiled.autoPositive,
        userNegative: compiled.userNegative,
        autoNegative: compiled.autoNegative,
        suppressedAuto: compiled.suppressedAuto,
        crossPolarityWarnings: compiled.crossPolarityWarnings,
        userCrossPolarityConflicts: compiled.userCrossPolarityConflicts,
      },
      model: parameters.model,
      width: parameters.width,
      height: parameters.height,
      sampler: parameters.sampler,
      scheduler: parameters.scheduler || "karras",
      steps: parameters.steps,
      cfg: parameters.guidance,
      cfgRescale: parameters.cfg_rescale ?? 0,
      seed: parameters.seed,
      seed_mode: parameters.seed_mode,
      positiveTier: naiPositiveTier,
      negativeTier: naiNegativeTier,
      ucPreset: naiNegativeTier,
      transparentBackground: naiTransparentBg,
      resolution_category: parameters.resolution_category,
      mode: naiGenerationMode,
      // 兼容旧字段：qualityTags / heavyUc 由档位派生，保留供旧 metadata 恢复。
      qualityTags: naiPositiveTier !== "off",
      heavyUc: naiNegativeTier !== "off",
      ...(characters.length ? { characterPrompts: characters } : {}),
      // 生成血缘：继续生成 / 恢复时带入父级身份；空白工作区生成为 null。
      parent: naiGenerationParent,
    };
    naiGenerationParent = null; // 用后即清，避免无关的空白生图误带父级
    const res = await fetch(`${NAI_SERVER}/api/novelai/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: naiGenerationMode,
        prompt: generationPrompt,
        negative_prompt: generationNegative,
        characters,
        img2img,
        references: [],
        settings: {
          model: parameters.model,
          width: parameters.width,
          height: parameters.height,
          sampler: parameters.sampler,
          steps: parameters.steps,
          guidance: parameters.guidance,
          seed_mode: parameters.seed_mode,
          seed: parameters.seed,
          noise_schedule: parameters.scheduler || "karras",
          cfg_rescale: parameters.cfg_rescale ?? 0,
          auto_smea: parameters.auto_smea === true,
        },
         count,
         quality_preset: naiPositiveTier,
         uc_preset: naiNegativeTier,
         prompt_presets_compiled: true,
         quality_toggle: naiPositiveTier !== "off",
        snapshot_id: snapshotId,
        name: "manual",
        meta,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      const hints = {
        TOKEN_MISSING: "请先在设置中填写 NovelAI API Token",
        AUTH_ERROR: "NovelAI API Token 无效或已失效，请重新填写",
        NETWORK_ERROR: "无法连接 NovelAI，请检查本机代理",
        NETWORK_TIMEOUT: "连接 NovelAI 超时，请检查代理节点",
        INSUFFICIENT_CREDITS: "NovelAI Anlas 余额不足",
        RATE_LIMIT: "NovelAI 请求过于频繁，请稍后再试",
      };
      throw new Error(hints[j.code] || j.error || "生成失败");
    }
    naiApiBatchId = j.batchId;
    naiSetPhase("generating");
    naiSetJob(`生成中：0/${j.total || count}`);
  } catch (e) {
    naiSetPhase("error", e.message);
  }
}

async function naiCancel() {
  if (!naiApiBatchId) { toast("当前没有可取消的官方 API 批次"); return; }
  try {
    const r = await fetch(`${NAI_SERVER}/api/novelai/generate/${encodeURIComponent(naiApiBatchId)}/cancel`, { method: "POST" });
    const j = await r.json();
    if (!j.ok) throw new Error("批次已结束或不存在");
    toast("已取消尚未发送的请求");
  } catch (e) { toast("取消失败：" + e.message); }
}

function naiSSE() {
  const es = new EventSource(`${NAI_SERVER}/events`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "api-batch.update" && (!naiApiBatchId || e.batchId === naiApiBatchId)) {
      naiApiBatchId = e.batchId;
      if (e.status === "running") {
        naiSetPhase("generating");
        naiSetJob(`生成中：${e.completed || 0}/${e.total || "?"} · 当前第 ${e.current || 0} 张`);
      } else if (e.status === "completed") {
        naiSetPhase("complete");
        naiSetJob(`已完成：${e.completed}/${e.total}`);
        loadNaiGallery(); loadGalleryList();
        setTimeout(() => { naiApiBatchId = null; naiSetPhase("ready"); }, 1500);
      } else if (e.status === "cancelling") {
        naiSetJob(`正在停止剩余请求：当前已完成 ${e.completed || 0}/${e.total || 0}`);
      } else if (e.status === "cancelled") {
        naiSetPhase("cancelled");
        naiSetJob(`已取消剩余请求：共完成 ${e.completed || 0}/${e.total || 0}`);
        setTimeout(() => { naiApiBatchId = null; naiSetPhase("ready"); }, 800);
      } else if (e.status === "failed") {
        const detail = e.error || "API 批次失败";
        const trace = e.correlation_id ? ` · 请求 ${e.correlation_id}` : "";
        const code = e.code ? ` [${e.code}]` : "";
        naiSetPhase("error", `${detail}${code}${trace}`);
        naiSetJob(`失败：${detail}${code}${trace} · 已完成 ${e.completed || 0}/${e.total || 0}`);
        naiApiBatchId = null;
      }
    }
    if (e.type === "api-batch.image" && (!naiApiBatchId || e.batchId === naiApiBatchId)) {
      loadNaiGallery();
      loadGalleryList();
    }
  };
  es.onerror = () => { toast("与 NovelAI API 服务断开，生成进度可能延迟"); };
}

// [7] 从购物车「继续到生图」不再导出→复制→写 DOM：生成视图直接读 PromptDocument，
// 这里只负责单向镜像角色 + 切换视图。
function switchToGenerateView() {
  endEditTransaction();
  syncNaiCharactersFromState();
  return showView("generate");
}

// ---- Output Viewer / History ----
async function loadNaiGallery() {
  try {
    const data = await api("/api/gallery/nai_generated");
    naiImages = data.items || [];
    if (naiImages.length && naiIdx < 0) naiIdx = 0;
    if (naiIdx >= naiImages.length) naiIdx = naiImages.length - 1;
    renderViewer();
    renderHistory();
  } catch { /* 图库暂无该目录时忽略 */ }
}

function renderViewer() {
  const v = $("#nai-viewer");
  const meta = $("#nai-viewer-meta");
  const navi = $("#nai-navi");
  if (!naiImages.length || naiIdx < 0) {
    v.innerHTML = `<div class="empty">生成后图片显示在这里，点击可 100% 查看</div>`;
    meta.textContent = ""; navi.textContent = ""; return;
  }
  const it = naiImages[naiIdx];
  const src = `/gallery/nai_generated/${encodeURIComponent(it.file_path.split("/").pop())}`;
  v.innerHTML = `<img src="${src}" id="nai-viewer-img" alt="" />`;
  navi.textContent = `${naiIdx + 1} / ${naiImages.length}`;
  const recipe = naiRecipeFromItem(it);
  const settings = recipe.settings || recipe;
  meta.innerHTML = `<div><strong>Prompt</strong> ${esc(it.prompt || "-")}</div><div><strong>Negative</strong> ${esc(it.negative_prompt || "-")}</div><div><strong>Seed</strong> ${esc(settings.seed ?? it.seed ?? "-")} · <strong>Model</strong> ${esc(settings.model ?? it.model ?? "-")} · <strong>Mode</strong> ${esc(recipe.mode || "txt2img")}</div>` +
    `<div class="viewer-meta-actions"><button data-meta-action="restore">恢复参数</button><button data-meta-action="seed">复用 Seed</button><button data-meta-action="copy">复制 Prompt</button></div>` +
    (it.snapshot_id ? `<div class="viewer-restore-actions"><button data-viewer-restore="">全部加载</button><button data-viewer-restore="character,appearance,clothing,expression,action">加载角色</button><button data-viewer-restore="style,quality">加载画风</button><button data-viewer-restore="composition,scene">加载构图</button></div>` : "");
  meta.querySelectorAll("[data-viewer-restore]").forEach((b) => b.addEventListener("click", () => {
    sendGalleryEvent(it, "restore");
    setGenerationParent(it);
    restoreSnapshot(it.snapshot_id, b.dataset.viewerRestore);
  }));
  meta.querySelectorAll("[data-meta-action]").forEach((b) => b.addEventListener("click", () => {
    const itemMeta = extractMetaFromGalleryItem(it);
    if (b.dataset.metaAction === "restore") { sendGalleryEvent(it, "restore"); setGenerationParent(it); applyGenerationConfig(itemMeta); }
    else if (b.dataset.metaAction === "seed" && itemMeta.seed != null) { $("#nai-seed").value = String(itemMeta.seed); $("#nai-seed-mode").value = "fixed"; toast(`Seed ${itemMeta.seed} 已填入`); }
    else if (b.dataset.metaAction === "copy") { const t = itemMeta.effectivePrompt || itemMeta.rawPrompt || it.prompt || ""; navigator.clipboard.writeText(t).then(() => toast("Prompt 已复制")).catch(() => { const restored = naiResolveRestoredPrompt(itemMeta.rawPrompt, itemMeta.rawNegative, itemMeta.characterPrompts); naiApplyRestoredPrompt(restored.basePrompt, restored.globalUc, restored.characters); toast("已填入 Prompt 框"); }); }
  }));
  $("#nai-pin").textContent = it.favorite ? "♥ Pin" : "♡ Pin";
  $("#nai-pin").classList.toggle("on", !!it.favorite);
  const img = $("#nai-viewer-img");
  img.style.transform = naiZoom === 1 ? "" : `scale(${naiZoom})`;
  img.onclick = () => {
    if (naiZoom === 1) { naiZoom = 2; img.style.transform = "scale(2)"; img.style.cursor = "zoom-out"; }
    else { naiZoom = 1; img.style.transform = ""; img.style.cursor = "zoom-in"; }
  };
}

function renderHistory() {
  const h = $("#nai-history");
  if (!naiImages.length) { h.innerHTML = `<div class="empty">暂无生成历史</div>`; return; }
  const today = new Date().toDateString();
  const groups = { 今天: [], 更早: [] };
  naiImages.forEach((it, i) => {
    const d = new Date(it.created_at);
    (d.toDateString() === today ? groups["今天"] : groups["更早"]).push({ it, i });
  });
  let html = "";
  for (const [g, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += `<div class="nh-group">${g}</div>`;
    for (const { it, i } of items) {
      const src = `/gallery/nai_generated/${encodeURIComponent(it.file_path.split("/").pop())}`;
      html += `<img src="${src}" data-i="${i}" class="${i === naiIdx ? "current" : ""}" title="${esc(it.prompt || "")}" />`;
    }
  }
  h.innerHTML = html;
  h.querySelectorAll("img").forEach((img) => img.addEventListener("click", () => {
    naiIdx = Number(img.dataset.i); naiZoom = 1; renderViewer(); renderHistory();
  }));
}

function applyZoom() {
  const img = $("#nai-viewer-img");
  if (img) img.style.transform = naiZoom === 1 ? "" : `scale(${naiZoom})`;
}

// Advanced 折叠摘要：显示当前已透传的 Steps/Guidance
function updateAdvSummary(parameters) {
  const p = parameters || {};
  const parts = [];
  if (p.sampler) parts.push(p.sampler);
  if (p.steps) parts.push(`Steps ${p.steps}`);
  if (p.guidance) parts.push(`CFG ${p.guidance}`);
  if (p.scheduler && p.scheduler !== "karras") parts.push(p.scheduler);
  $("#nai-adv-summary").textContent = parts.length ? parts.join(" · ") : "NovelAI 当前";
}

// Pin：收藏/取消收藏当前 Viewer 图片（复用 Python 图库收藏）
async function naiPin() {
  const it = naiImages[naiIdx];
  if (!it) { toast("没有可收藏的图片"); return; }
  try {
    await api("/api/gallery/favorite", {
      method: "POST", body: JSON.stringify({ dir_name: "nai_generated", file_name: it.file_name, favorite: !it.favorite }),
    });
    it.favorite = !it.favorite;
    renderViewer();
    toast(it.favorite ? "已收藏 ♥" : "已取消收藏");
  } catch (e) { toast("收藏失败：" + e.message); }
}

// P0 状态同步：把恢复出的干净 Base / Global UC / 角色文本 reconcile 进权威 PromptDocument（state.prompt），
// 复用 RECONCILE_TEXT 同一条 reconcileTargetText 路径，再由调用方 syncNaiCharactersFromState 单向镜像回
// naiCharacters，避免恢复后的生图视图与购物车 / PromptBridge 静默分叉（不引入第二份权威状态）。
// 该函数只 reconcile 权威状态；persist / render / notify 由调用方在表单完全就绪后统一 commitPromptChange()。
function naiSyncRestoredPromptToState(basePrompt, globalUc, characters) {
  if (!promptDocument || !state.prompt) return;
  pushHistory();
  // 角色数对齐，确保 reconcile 到 char:N / char:N:uc 时目标角色存在（PromptDocument 恒 ≥1 角色）。
  while (state.prompt.characters.length < characters.length) {
    state.prompt = promptDocument.addCharacter(state.prompt, {});
  }
  while (state.prompt.characters.length > Math.max(1, characters.length)) {
    state.prompt = promptDocument.removeCharacter(state.prompt, state.prompt.characters.length - 1);
  }
  const known = new Map(knownCatalogTags);
  state.prompt = promptDocument.reconcileTargetText(state.prompt, "base", basePrompt, known);
  state.prompt = promptDocument.reconcileTargetText(state.prompt, "global_uc", globalUc, known);
  characters.forEach((character, index) => {
    state.prompt.characters[index].position = character.position ? { ...character.position } : null;
    state.prompt = promptDocument.reconcileTargetText(state.prompt, `char:${index}`, character.prompt, known);
    state.prompt = promptDocument.reconcileTargetText(state.prompt, `char:${index}:uc`, character.negative_prompt, known);
  });
}

// 结构化边界：把恢复出的干净 Base / Global UC / 角色分发到生成表单并同步权威状态。
// 供 naiRestoreItem 与剪贴板失败回退共用（唯一恢复入口，绝不整串写回 #nai-editor）。
// 统一委托 restorePromptDocumentFromGeneration（restore → PromptDocument → notify → UI）。
function naiApplyRestoredPrompt(basePrompt, globalUc, characters) {
  restorePromptDocumentFromGeneration({
    basePrompt: basePrompt ?? undefined,
    globalUc: globalUc ?? undefined,
    characters: characters || [],
  });
}

// 统一恢复入口：把恢复出的生成字段归一化进 PromptDocument（复用 reconcileTargetText，
// 绝不写 DOM）。flow = restore → PromptDocument → notify → UI。
// data: { basePrompt, globalUc, characters:[{name?,prompt,uc?,negative_prompt?,position}], freeText?, freeTextEn?, useFreeTextEn? }
function restorePromptDocumentFromGeneration(data = {}) {
  if (!promptDocument || !state.prompt) return;
  const src = data && typeof data === "object" ? data : {};
  const characters = (Array.isArray(src.characters) ? src.characters : []).map((character) => ({
    prompt: String(character?.prompt || ""),
    negative_prompt: String(character?.uc ?? character?.negative_prompt ?? ""),
    position: character?.position ? { x: Number(character.position.x), y: Number(character.position.y) } : null,
    name: character?.name || null,
  }));
  naiSyncRestoredPromptToState(
    src.basePrompt != null ? String(src.basePrompt) : "",
    src.globalUc != null ? String(src.globalUc) : "",
    characters,
  );
  // free text：可选；缺省清空（legacy basePrompt 已把 Free text 行并入 Base）。
  state.prompt.free_text = src.freeText != null ? String(src.freeText) : "";
  state.prompt.free_text_en = src.freeTextEn != null ? String(src.freeTextEn) : "";
  state.prompt.use_free_text_en = !!src.useFreeTextEn;
  characters.forEach((character, index) => {
    if (character.name && state.prompt.characters[index]) state.prompt = promptDocument.renameCharacter(state.prompt, index, character.name);
  });
  syncNaiCharactersFromState();
  rebuildTargetSelect();
  commitPromptChange({ refresh: true });
  renderWorkbenchEditorFromDocument({ force: true });
}

// 只有明确点击恢复按钮时才写入编辑表单；点击历史缩略图只切换预览。
async function naiRestoreItem(it) {
  if (!it) { toast("没有可恢复的图片"); return; }
  sendGalleryEvent(it, "restore");
  setGenerationParent(it);
  const recipe = naiRecipeFromItem(it);
  const p = recipe.settings || recipe;
  // P0 结构化边界：与 applyGenerationConfig 共用 naiResolveRestoredPrompt 拆分，
  // 绝不把 legacy 结构化串（Base:/Character N:/Global UC:）整段写回 #nai-prompt。
  const restored = naiResolveRestoredPrompt(recipe.prompt || it.prompt || "", recipe.negative_prompt ?? it.negative_prompt ?? "", recipe.characters);
  naiApplyRestoredPrompt(restored.basePrompt, restored.globalUc, restored.characters);
  naiSetSelectValue("#nai-model", p.model, "nai-diffusion-5-full");
  $("#nai-width").value = p.width ?? 832;
  $("#nai-height").value = p.height ?? 1216;
  $("#nai-resolution-category").value = naiResolutionPresetForSize(p.width ?? 832, p.height ?? 1216);
  naiSyncCountOptions();
  naiToggleCustomResolution();
  $("#nai-count").value = String(Math.max(1, Math.min(naiBatchMaxCount(), Number(recipe.count || p.count || 1))));
  $("#nai-seed-mode").value = p.seed_mode || "fixed";
  $("#nai-seed").value = p.seed != null ? String(p.seed) : "";
  $("#nai-steps").value = p.steps != null ? String(p.steps) : "28";
  $("#nai-guidance").value = p.guidance != null ? String(p.guidance) : "5";
  naiSetSelectValue("#nai-sampler", p.sampler, "k_euler_ancestral");
  if ($("#nai-scheduler")) $("#nai-scheduler").value = p.scheduler || "karras";
  if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").value = p.cfg_rescale ?? 0;
  if ($("#nai-auto-smea")) $("#nai-auto-smea").value = String(p.auto_smea ?? false);
  naiSetMode(recipe.mode || "txt2img");
  if (recipe.mode === "img2img") {
    $("#nai-strength").value = recipe.img2img?.strength ?? 0.7;
    $("#nai-noise").value = recipe.img2img?.noise ?? 0;
    naiUpdateRangeLabels();
    const sourcePath = recipe.img2img?.source_image_path;
    if (sourcePath) {
      try { await naiUseImageSource(sourcePath, recipe.img2img?.source_image_name || "基础图"); }
      catch (error) { naiImg2ImgSource = null; naiRenderImg2ImgSource(); toast(`设置已恢复，但原基础图不可用：${error.message}`); }
    } else {
      naiImg2ImgSource = null;
      naiRenderImg2ImgSource();
    }
  } else {
    naiImg2ImgSource = null;
    naiRenderImg2ImgSource();
  }
  updateAdvSummary(p);
  updateNaiPromptMeta();
  naiUpdateEffectivePreview();
  naiRenderCost();
  toast("已恢复此图的完整生成设置");
}

function naiReuse() {
  return naiRestoreItem(naiImages[naiIdx]);
}

/**
 * 集中恢复 Generation Config 到 UI 控件。唯一入口，禁止散落直接操作 DOM .value。
 * @param {object} cfg — meta 对象（来自 image metadata）
 */
function applyGenerationConfig(cfg) {
  if (!cfg || typeof cfg !== "object") { toast("无可恢复的参数"); return; }
  // Prompt 恢复（P0 结构化边界优先级）：
  // 1) 旧结构化 rawPrompt（含 Base:/Character N:/Global UC: 行）→ 用现有解析器一次性拆解分发，
  //    绝不把整段结构化字符串写回 #nai-prompt；角色优先用保存的 characterPrompts（保留 position），
  //    缺失时退回从 display 行解析（position 置 null）。
  // 2) 否则视为新版保存的干净 Base + Global UC + characterPrompts。
  // 3) 纯 flat 单角色 rawPrompt 仍按普通文本支持。
  const savedCharacters = Array.isArray(cfg.characterPrompts) ? cfg.characterPrompts : [];
  // 结构化边界：与 naiRestoreItem 共用 naiResolveRestoredPrompt 拆分，绝不把
  // Base:/Character N:/Global UC: 混合串整段写回编辑器；统一走 restorePromptDocumentFromGeneration。
  const restored = naiResolveRestoredPrompt(cfg.rawPrompt, cfg.rawNegative, savedCharacters);
  restorePromptDocumentFromGeneration({
    basePrompt: restored.basePrompt ?? undefined,
    globalUc: restored.globalUc ?? undefined,
    characters: (restored.characters || []).map((character) => ({ prompt: character.prompt, uc: character.negative_prompt, position: character.position })),
  });
  // Model
  naiSetSelectValue("#nai-model", cfg.model, "nai-diffusion-5-full");
  // Resolution
  const w = Number(cfg.width) || 832;
  const h = Number(cfg.height) || 1216;
  $("#nai-width").value = w;
  $("#nai-height").value = h;
  $("#nai-resolution-category").value = naiResolutionPresetForSize(w, h);
  naiSyncCountOptions();
  naiToggleCustomResolution();
  // Sampler / Scheduler
  naiSetSelectValue("#nai-sampler", cfg.sampler, "k_euler_ancestral");
  if ($("#nai-scheduler")) $("#nai-scheduler").value = cfg.scheduler || "karras";
  // Steps / CFG / CFG Rescale
  if (cfg.steps != null) $("#nai-steps").value = String(cfg.steps);
  if (cfg.cfg != null) $("#nai-guidance").value = String(cfg.cfg);
  if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").value = String(cfg.cfgRescale ?? 0);
  // Seed
  if (cfg.seed_mode) $("#nai-seed-mode").value = cfg.seed_mode;
  if (cfg.seed != null) $("#nai-seed").value = String(cfg.seed);
  // 档位（正面 / 负面）：新字段优先；旧字段 qualityTags / heavyUc 兼容映射。
  if (cfg.positiveTier != null) {
    naiPositiveTier = naiNormalizePositiveTier(cfg.positiveTier);
  } else if (cfg.qualityTags != null) {
    naiPositiveTier = !!cfg.qualityTags ? "standard" : "off";
  }
  if (cfg.negativeTier != null) {
    naiNegativeTier = naiNormalizeNegativeTier(cfg.negativeTier);
  } else if (cfg.ucPreset != null) {
    naiNegativeTier = naiNormalizeNegativeTier(cfg.ucPreset);
  } else if (cfg.heavyUc != null) {
    naiNegativeTier = !!cfg.heavyUc ? "heavy" : "off";
  }
  naiSetSelectValue("#nai-positive-tier", naiPositiveTier, "standard");
  naiSetSelectValue("#nai-negative-tier", naiNegativeTier, "heavy");
  if (cfg.transparentBackground != null) {
    naiTransparentBg = !!cfg.transparentBackground;
    if ($("#nai-transparent")) $("#nai-transparent").checked = naiTransparentBg;
  }
  // Mode
  if (cfg.mode) naiSetMode(cfg.mode);
  // Characters 已由 restorePromptDocumentFromGeneration 写入 PromptDocument 权威，
  // 这里仅同步 view adapter 并刷新角色列表（不含 textarea）。
  syncNaiCharactersFromState();
  naiRenderCharacters();
  // Refresh UI
  updateAdvSummary(naiCollectParameters());
  updateNaiPromptMeta();
  naiUpdateEffectivePreview();
  naiRenderCost();
  toast("已恢复生成参数");
}

/**
 * 从图库 item 提取 meta（兼容新旧格式）。
 * 新格式：item.parameters.meta 存在。
 * 旧格式：从 item.parameters.recipe 或 item.parameters 重建。
 */
function extractMetaFromGalleryItem(item) {
  const params = item?.parameters && typeof item.parameters === "object" ? item.parameters : {};
  // 新格式：直接有 meta 字段
  if (params.meta && typeof params.meta === "object") return params.meta;
  // 旧格式：从 recipe 或 parameters 重建 meta
  const recipe = params.recipe && typeof params.recipe === "object" ? params.recipe : params;
  const s = recipe.settings || recipe;
  return {
    rawPrompt: recipe.prompt || item.prompt || "",
    effectivePrompt: recipe.prompt || item.prompt || "",
    rawNegative: recipe.negative_prompt ?? item.negative_prompt ?? "",
    effectiveNegative: recipe.negative_prompt ?? item.negative_prompt ?? "",
    model: s.model,
    width: s.width,
    height: s.height,
    sampler: s.sampler,
    scheduler: s.scheduler || s.noise_schedule || "karras",
    steps: s.steps,
    cfg: s.guidance,
    cfgRescale: s.cfg_rescale ?? 0,
    seed: s.seed,
    seed_mode: s.seed_mode || "fixed",
    // 新 recipe 已保存档位；旧 recipe 缺省兼容 standard/heavy。
    positiveTier: recipe.quality_preset || (recipe.quality_toggle === false ? "off" : "standard"),
    negativeTier: recipe.uc_preset || "heavy",
    ucPreset: recipe.uc_preset || "heavy",
    transparentBackground: false,
    qualityTags: true,
    heavyUc: true,
    resolution_category: recipe.resolution_category || null,
    mode: recipe.mode || "txt2img",
    characterPrompts: Array.isArray(recipe.characters) ? recipe.characters : [],
  };
}

async function naiUseCurrentAsImg2Img() {
  const it = naiImages[naiIdx];
  if (!it) { toast("没有可用的历史图片"); return; }
  try {
    await naiUseImageSource(naiImageUrl(it), it.file_name || "历史图");
    toast("已将当前历史图设为图生图基础图");
  } catch (error) { toast(error.message); }
}

function naiUpdateRangeLabels() {
  $("#nai-strength-value").textContent = Number($("#nai-strength").value).toFixed(2);
  $("#nai-noise-value").textContent = Number($("#nai-noise").value).toFixed(2);
  naiRenderCost();
}

// ---- 生图视图事件绑定 ----
$("#nai-gen").addEventListener("click", naiGenerate);
$("#nai-cancel").addEventListener("click", naiCancel);
document.querySelectorAll("[data-nai-mode]").forEach((button) => button.addEventListener("click", () => naiSetMode(button.dataset.naiMode)));
$("#nai-img2img-pick").addEventListener("click", () => $("#nai-img2img-file").click());
$("#nai-img2img-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("请选择图片文件"); event.target.value = ""; return; }
  try {
    const dataUrl = await naiReadBlobAsDataUrl(file);
    const saved = await naiPersistImg2ImgSource(dataUrl, file.name);
    naiImg2ImgSource = { dataUrl, path: saved.source_image_path, name: saved.source_image_name || file.name };
    naiSetMode("img2img");
    naiRenderImg2ImgSource();
  } catch (error) {
    toast(error.message || "图片读取失败");
  } finally {
    event.target.value = "";
  }
});
$("#nai-strength").addEventListener("input", () => { naiUpdateRangeLabels(); naiRenderCost(); });
$("#nai-noise").addEventListener("input", () => { naiUpdateRangeLabels(); naiRenderCost(); });
$("#nai-character-add").addEventListener("click", (e) => {
  e.stopPropagation();
  naiAddCharacter();
});
$("#nai-character-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-nai-char-tab]");
  if (!btn) return;
  endEditTransaction(); // 目标切换结束上一次编辑会话
  activeNaiTarget = btn.dataset.naiCharTab === "base" ? "base" : Number(btn.dataset.naiCharTab);
  workbenchCharIndex = activeNaiTarget === "base" ? null : activeNaiTarget;
  window.PromptBridge.setActiveTarget(activeNaiTarget === "base" ? "base" : `char:${activeNaiTarget}`);
  naiRenderCharacters();
  renderWorkbenchEditorFromDocument({ force: true });
});
$("#nai-character-list").addEventListener("input", (event) => {
  const article = event.target.closest("[data-character-index]");
  if (!article) return;
  const index = Number(article.dataset.characterIndex);
  if (event.target.matches("[data-character-name]")) {
    window.PromptBridge.dispatch({ type: "RENAME_CHARACTER", payload: { index, name: event.target.value } });
    return;
  }
  const field = event.target.dataset.characterField;
  if (!field || !["x", "y"].includes(field)) return;
  const position = { ...(state.prompt.characters[index].position || { x: 0.5, y: 0.5 }) };
  position[field] = Math.max(0, Math.min(1, Number(event.target.value)));
  window.PromptBridge.dispatch({ type: "SET_CHARACTER_POSITION", payload: { index, position } });
});
$("#nai-character-list").addEventListener("change", (event) => {
  if (event.target.matches("[data-character-manual]")) {
    const article = event.target.closest("[data-character-index]");
    window.PromptBridge.dispatch({ type: "SET_CHARACTER_POSITION", payload: { index: Number(article.dataset.characterIndex), position: event.target.checked ? { x: 0.5, y: 0.5 } : null } });
  }
});
$("#nai-character-list").addEventListener("click", (event) => {
  const article = event.target.closest("[data-character-index]");
  if (!article) return;
  const index = Number(article.dataset.characterIndex);
  if (event.target.matches("[data-character-remove]")) {
    window.PromptBridge.dispatch({ type: "REMOVE_CHARACTER", payload: { index } });
  } else if (event.target.matches('[data-character-move="up"]') && index > 0) {
    window.PromptBridge.dispatch({ type: "MOVE_CHARACTER", payload: { fromIndex: index, toIndex: index - 1 } });
  } else if (event.target.matches('[data-character-move="down"]') && index < naiCharacters.length - 1) {
    window.PromptBridge.dispatch({ type: "MOVE_CHARACTER", payload: { fromIndex: index, toIndex: index + 1 } });
  } else return;
  naiRenderCharacters();
});
$("#nai-seed-random").addEventListener("click", () => { $("#nai-seed").value = Math.floor(Math.random() * 2147483647); });
// 单一编辑器：只有 #nai-editor 写 PromptDocument，目标随 workbench 视图动态解析。
const naiEditor = $("#nai-editor");
bindNaiAutocomplete(naiEditor, "base", { generateOnDoubleEnter: true });
naiEditor.addEventListener("focus", beginEditTransaction);
naiEditor.addEventListener("input", (event) => {
  updateNaiPromptMeta();
  const target = resolveWorkbenchEditorTarget(currentWorkbenchView());
  if (target) window.PromptBridge.dispatch({ type: "RECONCILE_TEXT", payload: { target, text: event.target.value, transaction: true } });
  naiUpdateEffectivePreview();
});
naiEditor.addEventListener("blur", endEditTransaction);
// 自然语言补充：仅 Base Text 显示；写 state.prompt 权威字段。
$("#nai-free-text")?.addEventListener("input", (event) => { state.prompt.free_text = event.target.value; state.prompt.use_free_text_en = false; commitPromptChange({ render: false }); naiUpdateEffectivePreview(); });
$("#nai-free-text-en")?.addEventListener("input", (event) => { state.prompt.free_text_en = event.target.value; commitPromptChange({ render: false }); naiUpdateEffectivePreview(); });
$("#nai-free-text-use-en")?.addEventListener("change", (event) => { state.prompt.use_free_text_en = event.target.checked && !!state.prompt.free_text_en.trim(); commitPromptChange({ render: false }); naiUpdateEffectivePreview(); });
$("#nai-resolution-category").addEventListener("change", () => { naiApplyResolutionPreset(); updateAdvSummary(naiCollectParameters()); naiRenderCost(); });
$("#nai-width").addEventListener("change", () => { naiSyncResolutionFromInputs(); naiRenderCost(); });
$("#nai-height").addEventListener("change", () => { naiSyncResolutionFromInputs(); naiRenderCost(); });
$("#nai-count").addEventListener("input", naiRenderCost);
$("#nai-steps").addEventListener("input", naiRenderCost);
$("#nai-zoom-in").addEventListener("click", () => { naiZoom = Math.min(4, naiZoom + 0.5); applyZoom(); });
$("#nai-zoom-out").addEventListener("click", () => { naiZoom = Math.max(1, naiZoom - 0.5); applyZoom(); });
$("#nai-zoom-fit").addEventListener("click", () => { naiZoom = 1; applyZoom(); });
$("#nai-pin").addEventListener("click", naiPin);
$("#nai-reuse").addEventListener("click", naiReuse);
$("#nai-use-img2img").addEventListener("click", naiUseCurrentAsImg2Img);
// Prompt / UC 标签：切换 workbench pane 并回流单一编辑器。
document.querySelectorAll(".nai-tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".nai-tab").forEach((x) => x.classList.toggle("active", x === t));
  endEditTransaction();
  workbenchPane = t.dataset.tab === "uc" ? "uc" : "prompt";
  renderWorkbenchEditorFromDocument({ force: true });
}));
$("#nai-history-refresh").addEventListener("click", loadNaiGallery);

// ---- P0: 档位选择器（正面 / 负面）/ Transparent / Effective Preview ----
$("#nai-positive-tier").addEventListener("change", () => {
  naiPositiveTier = naiNormalizePositiveTier($("#nai-positive-tier").value);
  localStorage.setItem("nai_positive_tier", naiPositiveTier);
  naiUpdateTierHint();
  naiUpdateEffectivePreview();
  window.WorkbenchComponents?.builder?.refreshSemantic();
});
$("#nai-negative-tier").addEventListener("change", () => {
  naiNegativeTier = $("#nai-negative-tier").value;
  localStorage.setItem("nai_negative_tier", naiNegativeTier);
  naiUpdateTierHint();
  naiUpdateEffectivePreview();
});
$("#nai-transparent").addEventListener("change", () => { naiTransparentBg = $("#nai-transparent").checked; naiUpdateEffectivePreview(); });
$("#nai-model").addEventListener("change", () => { naiUpdateTierHint(); naiUpdateEffectivePreview(); });
$("#nai-sampler").addEventListener("change", naiUpdateEffectivePreview);
if ($("#nai-scheduler")) $("#nai-scheduler").addEventListener("change", naiUpdateEffectivePreview);
$("#nai-steps").addEventListener("input", naiUpdateEffectivePreview);
$("#nai-guidance").addEventListener("input", naiUpdateEffectivePreview);
if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").addEventListener("input", naiUpdateEffectivePreview);
if ($("#nai-auto-smea")) $("#nai-auto-smea").addEventListener("change", naiUpdateEffectivePreview);


init();
pollInbox(true);
setInterval(() => pollInbox(false), 1200);
