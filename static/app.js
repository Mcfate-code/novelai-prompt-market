"use strict";

// ===== 状态 =====
const SECTION_IDS = ["character", "appearance", "clothing", "expression", "action", "composition", "scene", "style", "quality", "other"];
const DEFAULT_OPEN_SECTIONS = new Set(["character", "appearance", "clothing", "action", "composition", "style"]);
const DRAFT_KEY = "novelai_prompt_draft_v2";
const SECTION_LABELS = { character: "角色", appearance: "外观", clothing: "服装", expression: "表情", action: "动作", composition: "构图", scene: "场景", style: "画风", quality: "质量", other: "其他" };

function emptySections() { return Object.fromEntries(SECTION_IDS.map((id) => [id, []])); }
function emptyPromptState() {
  return { schema_version: 2, sections: emptySections(), characters: [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections() }], global_uc_sections: emptySections(), free_text: "" };
}
function normalizeEntry(value, section = "other", extra = {}) {
  const raw = typeof value === "string" ? { tag: value } : (value || {});
  const weight = Number(raw.weight ?? raw.strength ?? 1);
  return {
    id: String(raw.id || `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), tag: String(raw.tag || raw.raw || "").trim(),
    weight: Number.isFinite(weight) ? weight : 1, section: SECTION_IDS.includes(raw.section) ? raw.section : section,
    custom: !!raw.custom, source: raw.source || extra.source || "tag", bundle_id: raw.bundle_id ?? extra.bundle_id ?? null,
    bundle_name: raw.bundle_name ?? extra.bundle_name ?? null, sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : (extra.sort_order ?? 0),
  };
}
function normalizeSections(source) {
  const out = emptySections();
  if (!source || typeof source !== "object") return out;
  SECTION_IDS.forEach((id) => { out[id] = Array.isArray(source[id]) ? source[id].map((e, i) => normalizeEntry(e, id, { sort_order: i })).filter((e) => e.tag) : []; });
  return out;
}
function migratePromptState(raw) {
  if (raw?.schema_version === 2 && raw.sections) {
    return { schema_version: 2, sections: normalizeSections(raw.sections), characters: (Array.isArray(raw.characters) && raw.characters.length ? raw.characters : [{ name: "Character 1" }]).map((ch, i) => ({ name: ch.name || `Character ${i + 1}`, prompt_sections: normalizeSections(ch.prompt_sections), uc_sections: normalizeSections(ch.uc_sections), position: ch.position || null })), global_uc_sections: normalizeSections(raw.global_uc_sections), free_text: typeof raw.free_text === "string" ? raw.free_text : "" };
  }
  const prompt = emptyPromptState();
  (raw?.base || raw?.base_prompt || []).forEach((e, i) => prompt.sections[SECTION_IDS.includes(e?.section) ? e.section : "other"].push(normalizeEntry(e, e?.section || "other", { sort_order: i })));
  prompt.characters = (Array.isArray(raw?.characters) && raw.characters.length ? raw.characters : [{ name: "Character 1", prompt: [], uc: [] }]).map((ch, i) => {
    const item = { name: ch.name || `Character ${i + 1}`, prompt_sections: emptySections(), uc_sections: emptySections(), position: ch.position || null };
    (ch.prompt || []).forEach((e, j) => item.prompt_sections[SECTION_IDS.includes(e?.section) ? e.section : "other"].push(normalizeEntry(e, e?.section || "other", { sort_order: j })));
    (ch.uc || []).forEach((e, j) => item.uc_sections[SECTION_IDS.includes(e?.section) ? e.section : "other"].push(normalizeEntry(e, e?.section || "other", { sort_order: j })));
    return item;
  });
  (raw?.global_uc || []).forEach((e, i) => prompt.global_uc_sections[SECTION_IDS.includes(e?.section) ? e.section : "other"].push(normalizeEntry(e, e?.section || "other", { sort_order: i })));
  prompt.free_text = typeof raw?.free_text === "string" ? raw.free_text : "";
  return prompt;
}

const state = { model: "v5", target: "base", prompt: emptyPromptState(), characters: [], base: [], global_uc: [], free_text: "", categories: [], activeCategory: null, activeDbCat: null, view: "browse", favorites: new Set(), recent: [], models: [], history: [] };
const RELATIONS = ["", "source", "target", "mutual"];
let promptPresets = [];
let promptSections = SECTION_IDS.map((id) => ({ id, label: SECTION_LABELS[id] }));
let recommendations = [];
let promptConflicts = [];
let bundles = [];
let pendingSnapshotId = null;
let cartAdvanced = false;
let zhMap = {}; // prompt_tag -> 中文名

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
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
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
  const tag = entry.tag;
  const weight = Number(entry.weight ?? 1);
  return weight === 1 ? tag : `${Number(weight.toFixed(2))}::${tag}::`;
}
function promptPreviewText() {
  const tags = positivePromptEntries().map(weightText);
  if (state.prompt.free_text.trim()) tags.push(state.prompt.free_text.trim());
  return tags.join(", ");
}
function negativePreviewText() { return negativePromptEntries().map(weightText).join(", "); }
const refreshPromptServices = debounce(() => { loadRecommendations(); loadConflicts(); }, 250);
function commitPromptChange({ render = true, refresh = true } = {}) {
  persistDraft();
  if (render) renderCart();
  if (refresh) refreshPromptServices();
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
      novelai_batch_max_count: Number($("#setting-novelai-batch-max").value),
      novelai_example_credit_warning: $("#setting-novelai-example-credit-warning").checked,
      novelai_example_prompt_template: $("#setting-novelai-example-prompt").value.trim(),
    };
    if (!Number.isFinite(payload.cache_limit_mb) || payload.cache_limit_mb < 0) {
      throw new Error("缓存上限必须是 0 或更大的数字");
    }
    if (!Number.isInteger(payload.novelai_batch_max_count) || payload.novelai_batch_max_count < 1 || payload.novelai_batch_max_count > 100) {
      throw new Error("批处理上限必须是 1-100");
    }
    if (payload.novelai_example_prompt_template && !payload.novelai_example_prompt_template.includes("{tag}")) {
      throw new Error("例图提示词模板必须包含 {tag} 占位符");
    }
    userSettings = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
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
  if (!cartAdvanced) return opts;
  state.prompt.characters.forEach((ch, i) => {
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
}

// ===== 标签目标选择器（超市点击标签写入 Base / 指定角色） =====
function insertTagIntoString(text, tag) {
  const raw = String(tag ?? "").trim();
  if (!raw) return text;
  const tokens = String(text || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const existing = new Set(tokens.map((t) => t.toLowerCase()));
  if (existing.has(raw.toLowerCase())) return text;
  tokens.push(raw);
  return tokens.join(", ");
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
  const options = [`<option value="base">Base / Scene</option>`];
  naiCharacters.forEach((_, i) => options.push(`<option value="char:${i}">Character ${i + 1}</option>`));
  sel.innerHTML = options.join("");
  const m = String(state.target || "").match(/^char:(\d+)$/);
  if (m && naiCharacters[Number(m[1])]) {
    sel.value = state.target;
  } else {
    sel.value = "base";
    if (m) state.target = "base"; // 悬空的 char:N 回退到 base
  }
}

function addTagToTarget(tag) {
  const sel = document.getElementById("nai-tag-target");
  state.target = sel?.value || "base";
  const m = state.target.match(/^char:(\d+)$/);
  if (m && !naiCharacters[Number(m[1])]) state.target = "base";
  addEntry(tag);
  if (state.target === "base") {
    const promptEl = $("#nai-prompt");
    promptEl.value = insertTagIntoString(promptEl.value, tag);
    updateNaiPromptMeta();
    if (typeof naiUpdateEffectivePreview === "function") naiUpdateEffectivePreview();
  } else {
    const cm = state.target.match(/^char:(\d+)$/);
    if (cm) {
      const character = naiCharacters[Number(cm[1])];
      if (character) {
        character.prompt = insertTagIntoString(character.prompt, tag);
        naiRenderCharacters();
      }
    }
  }
}

// ===== 初始化 =====
async function init() {
  loadDraft();
  await loadUserSettings();
  const m = await api("/api/models");
  state.models = m.models;
  if (!state.model || !m.models.some((x) => x.id === state.model)) state.model = m.default;
  $("#model-select").innerHTML = m.models.map((x) => `<option value="${x.id}" ${x.id === state.model ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  rebuildTargetSelect();
  rebuildNaiTagTarget();
  await Promise.all([loadTaxonomy(), loadFavorites(), loadRecent(), loadPromptSections()]);
  await loadZh();
  await loadPromptPresets();
  renderCart();
  refreshPromptServices();
}

async function loadPromptSections() {
  try {
    const data = await api("/api/prompt/sections");
    if (Array.isArray(data.sections) && data.sections.length) {
      promptSections = data.sections.filter((s) => SECTION_IDS.includes(s.id)).map((s) => ({ id: s.id, label: s.label || SECTION_LABELS[s.id] }));
    }
  } catch { /* 后端升级期间使用内置分类 */ }
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
let contentRequestSeq = 0;  // 丢弃过期的分类/搜索响应

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
  return `<div class="tag-card ${t.is_deprecated ? "tag-deprecated" : ""}" data-tag="${esc(t.tag)}">` +
    `<div class="tag-thumb-wrap" data-thumb-wrap="${esc(t.tag)}"><img class="tag-thumb" data-thumb="${esc(t.tag)}" alt="" loading="lazy" decoding="async" /></div>` +
    `<div class="tag-example-controls" data-example-controls="${esc(t.tag)}"></div>` +
    `<button class="fav-toggle ${fav ? "on" : ""}" data-fav="${esc(t.tag)}" title="${fav ? "取消收藏" : "收藏"}">${fav ? "★" : "☆"}</button>` +
    `<div class="tag-en">${esc(t.tag)}</div>` +
    (t.zh ? `<div class="tag-zh">${esc(t.zh)}</div>` : "") +
    `<div class="tag-meta">${esc(meta || "General")}</div>` +
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
      thumbLoadState?.failed.add(tag);
      wrap?.classList.add("failed");
      updateThumbProgress();
    };
    img.src = url;
  });
}

// ===== hover 大图浮层 =====
let previewTimer = null;

function showThumbPreview(tag, anchor) {
  const url = cardLargeUrl(tag);
  if (!url) return;
  clearTimeout(previewTimer);
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
    const img = e.target.closest("img[data-thumb]");
    const card = e.target.closest(".tag-card");
    if (img && card) showThumbPreview(img.dataset.thumb, card);
  });
  list.addEventListener("mouseout", (e) => {
    const img = e.target.closest("img[data-thumb]");
    if (img) hideThumbPreview();
  });
  const box = $("#thumb-preview");
  box.addEventListener("mouseenter", () => clearTimeout(previewTimer));
  box.addEventListener("mouseleave", () => hideThumbPreview());
}
bindThumbPreview();

function renderCatalogTags(data) {
  renderTagCards(data.tags.map((t) => ({ tag: t.tag, zh: t.zh, post_count: t.post_count, is_deprecated: t.is_deprecated })));
}

function renderSearchResults(results) {
  $("#browse-title").textContent = `搜索结果`;
  renderTagCards(results.map((r) => ({ tag: r.tag, zh: r.zh, post_count: r.post_count, favorite: r.favorite, match_reason: r.match_reason || r.match_type, section: r.section, is_deprecated: r.is_deprecated })));
}

// ===== PromptState V2 渲染 =====
function getSectionMap(key) {
  if (key === "base") return state.prompt.sections;
  if (key === "global_uc") return state.prompt.global_uc_sections;
  const m = key.match(/^char:(\d+)(:uc)?$/);
  if (!m || !state.prompt.characters[+m[1]]) return null;
  return m[2] ? state.prompt.characters[+m[1]].uc_sections : state.prompt.characters[+m[1]].prompt_sections;
}
function getSlot(key) { const sections = getSectionMap(key); return sections ? flattenSections(sections) : null; }
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
    `<div class="weight-popover" hidden><button data-weight="0.8">弱 0.8</button><button data-weight="1">普通 1.0</button><button data-weight="1.2">强 1.2</button><span></span><button data-step="-0.05">−</button><strong>${Number(e.weight || 1).toFixed(2)}</strong><button data-step="0.05">+</button></div>` +
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

function advancedCartHtml() {
  let html = `<div class="slot"><div class="slot-title">全局 Prompt</div>${sectionDetailsHtml(state.prompt.sections, "base")}</div>`;
  state.prompt.characters.forEach((ch, i) => {
    html += `<div class="slot"><div class="slot-title">${esc(ch.name)} <span class="rm" data-rm="char:${i}">移除</span></div>${sectionDetailsHtml(ch.prompt_sections, `char:${i}`)}` +
      `<details class="uc-block"><summary>角色 UC</summary>${sectionDetailsHtml(ch.uc_sections, `char:${i}:uc`)}</details></div>`;
  });
  return html + `<details class="uc-block"><summary>Global UC</summary>${sectionDetailsHtml(state.prompt.global_uc_sections, "global_uc")}</details>`;
}

function renderCart() {
  syncLegacyProjection();
  const el = $("#cart");
  const html = `<section class="compact-cart"><label class="cart-tag-input"><span>添加标签</span><div><input id="cart-tag-input" autocomplete="off" placeholder="输入中文或英文，回车直接加入" /><button id="cart-tag-submit" type="button">添加</button></div><small>输入时会在中间自动查找；回车会加入完全匹配的标签。</small></label><button id="cart-custom-tag" type="button" class="ghost add-custom-btn">＋ 自定义标签</button><div class="compact-cart-head"><strong>Prompt</strong><span>${positivePromptEntries().length} 个标签</span></div><div class="compact-tags">${compactEntriesHtml()}</div>` +
    `<details class="compact-uc"><summary>Undesired Content（${negativePromptEntries().length}）</summary><div class="compact-tags">${compactUcHtml()}</div></details>` +
    `<label class="compact-free-text"><span>自然语言补充</span><textarea class="free-text-box" id="free-text" placeholder="复杂空间关系 / 连续动作 / 画面意图…">${esc(state.prompt.free_text)}</textarea></label></section>` +
    `<details class="cart-advanced" ${cartAdvanced ? "open" : ""}><summary>高级编辑：分区、权重与多角色</summary><div class="cart-advanced-body"><button type="button" class="cart-add-character" data-add-character>+ 添加角色</button>${advancedCartHtml()}</div></details>`;
  el.innerHTML = html;
  bindEntryControls(el);
  $("#free-text").addEventListener("input", debounce((ev) => { state.prompt.free_text = ev.target.value; commitPromptChange({ render: false }); updatePromptPreview(); }, 180));
  el.querySelectorAll("[data-rm]").forEach((n) => n.addEventListener("click", () => removeCharacter(+n.dataset.rm.split(":")[1])));
  el.querySelectorAll("[data-compact-remove]").forEach((button) => button.addEventListener("click", () => removeEntryById(button.dataset.compactSlot, button.dataset.compactRemove)));
  el.querySelector("[data-add-character]")?.addEventListener("click", addCharacter);
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
  el.querySelector(".cart-advanced")?.addEventListener("toggle", (event) => {
    cartAdvanced = event.currentTarget.open;
    rebuildTargetSelect();
  });
  updatePromptPreview();
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
    toggle.addEventListener("click", () => { root.querySelectorAll(".weight-popover:not([hidden])").forEach((p) => { if (p !== pop) p.hidden = true; }); pop.hidden = !pop.hidden; });
    pop.querySelectorAll("[data-weight]").forEach((b) => b.addEventListener("click", () => setEntryWeight(slot, id, Number(b.dataset.weight))));
    pop.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { const found = findEntry(slot, id); if (found) setEntryWeight(slot, id, Math.max(0.1, Math.min(2, found.entry.weight + Number(b.dataset.step)))); }));
    node.querySelector(".section-select").addEventListener("change", (e) => moveEntrySection(slot, id, e.target.value));
    node.querySelector(".del").addEventListener("click", () => removeEntryById(slot, id));
  });
}

// ===== 自定义标签（本地词库） =====
function openCustomTagModal() {
  $("#custom-tag-name").value = "";
  $("#custom-tag-note").value = "";
  $("#custom-tag-status").textContent = "";
  $("#custom-tag-modal").style.display = "flex";
  $("#custom-tag-name").focus();
}
function closeCustomTagModal() { $("#custom-tag-modal").style.display = "none"; }

async function submitCustomTag() {
  const nameEl = $("#custom-tag-name");
  const noteEl = $("#custom-tag-note");
  const status = $("#custom-tag-status");
  const tag = nameEl.value.trim();
  const note = noteEl.value.trim();
  if (!tag) { status.textContent = "标签名不能为空"; nameEl.focus(); return; }
  const btn = $("#custom-tag-save");
  btn.disabled = true;
  try {
    await api("/api/user-tags", { method: "POST", body: JSON.stringify({ tag, note }) });
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
      `<div class="custom-tag-row"><span class="ct-tag">${esc(t.tag)}</span>${t.note ? `<small class="ct-note">${esc(t.note)}</small>` : ""}<button class="ghost ct-del" data-tag="${esc(t.tag)}" type="button">删除</button></div>`
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
  const sections = getSectionMap(options.target || state.target);
  if (!sections) return;
  if (flattenSections(sections).some((e) => e.tag === tag)) { toast(`「${tag}」已在当前位置`); return; }
  pushHistory();
  const section = options.section || await classifyTag(tag);
  sections[section].push(normalizeEntry({ tag, section, custom: !!options.custom, source: options.source || "tag" }, section));
  api("/api/recent", { method: "POST", body: JSON.stringify({ tag }) }).catch(() => {});
  commitPromptChange();
}
function removeEntryById(slot, id) {
  const found = findEntry(slot, id); if (!found) return;
  pushHistory(); found.sections[found.section].splice(found.index, 1); commitPromptChange();
}
function removeTagEverywhere(tag) {
  pushHistory();
  const maps = [state.prompt.sections, state.prompt.global_uc_sections, ...state.prompt.characters.flatMap((ch) => [ch.prompt_sections, ch.uc_sections])];
  maps.forEach((map) => SECTION_IDS.forEach((id) => { map[id] = map[id].filter((e) => e.tag !== tag); }));
  commitPromptChange();
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
  pushHistory(); state.prompt.characters.push({ name: `Character ${state.prompt.characters.length + 1}`, prompt_sections: emptySections(), uc_sections: emptySections() });
  commitPromptChange(); rebuildTargetSelect();
}
function removeCharacter(i) {
  pushHistory(); state.prompt.characters.splice(i, 1);
  if (!state.prompt.characters.length) state.prompt.characters.push({ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections() });
  if (state.target.startsWith("char:")) { const m = state.target.match(/^char:(\d+)/); if (m && +m[1] >= state.prompt.characters.length) state.target = "base"; }
  rebuildTargetSelect(); commitPromptChange();
}

async function toggleFavorite(tag) {
  if (state.favorites.has(tag)) {
    await api(`/api/favorites/${encodeURIComponent(tag)}`, { method: "DELETE" });
    state.favorites.delete(tag);
  } else {
    await api("/api/favorites", { method: "POST", body: JSON.stringify({ tag }) });
    state.favorites.add(tag);
  }
  refreshCurrentView();
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
  rebuildTargetSelect(); commitPromptChange();
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
    panel.innerHTML = promptConflicts.map((c, i) => `<div class="conflict-row"><span>${esc(c.tag_a)} 与 ${esc(c.tag_b)} 可能冲突</span><button data-keep="${i}">保留</button><button data-remove="${esc(c.tag_a)}">删 A</button><button data-remove="${esc(c.tag_b)}">删 B</button></div>`).join("");
    panel.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", () => b.closest(".conflict-row").remove()));
    panel.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => removeTagEverywhere(b.dataset.remove)));
  } catch { panel.hidden = true; }
}
function bundleItemsFromPrompt() { return positivePromptEntries().map((e, i) => ({ tag: e.tag, weight: e.weight, section: e.section, sort_order: i })); }
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
  if ($("#bundles-modal").style.display !== "none") await loadBundles(); return data.bundle || data;
}
async function addBundle(id) {
  let bundle = bundles.find((b) => String(b.id) === String(id)); if (!bundle?.items) { const data = await api(`/api/bundles/${encodeURIComponent(id)}`); bundle = data.bundle || data; }
  if (!bundle) return; pushHistory();
  (bundle.items || []).forEach((item, i) => { const section = SECTION_IDS.includes(item.section) ? item.section : "other"; if (!state.prompt.sections[section].some((e) => e.tag === item.tag)) state.prompt.sections[section].push(normalizeEntry(item, section, { source: "bundle", bundle_id: bundle.id, bundle_name: bundle.name, sort_order: i })); });
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
  commitPromptChange(); closeSnapshotModal(); await showView("browse"); toast("Prompt 已恢复");
}

// ===== Prompt 导入 =====
let inboxSeq = 0;

function countEntries(parsed) {
  let n = (parsed.base || []).length + (parsed.global_uc || []).length;
  (parsed.characters || []).forEach((c) => { n += (c.prompt || []).length + (c.uc || []).length; });
  return n;
}

function applyImported(parsed, mode, target = "base") {
  pushHistory(); const incoming = migratePromptState(parsed);
  if (target === "base" && mode === "replace") state.prompt = incoming;
  else {
    const targetSections = getSectionMap(target); if (!targetSections) return;
    if (mode === "replace") SECTION_IDS.forEach((id) => { targetSections[id] = []; });
    SECTION_IDS.forEach((id) => incoming.sections[id].forEach((entry) => { if (!targetSections[id].some((e) => e.tag === entry.tag)) targetSections[id].push(entry); }));
    if (incoming.free_text) state.prompt.free_text = mode === "replace" ? incoming.free_text : [state.prompt.free_text, incoming.free_text].filter(Boolean).join("\n");
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
  $("#import-text").focus();
  rebuildImportTargetSelect();
}
function closeImportModal() { $("#import-modal").style.display = "none"; }

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
  if (importPreviewData.free_text) state.prompt.free_text = mode === "replace" ? importPreviewData.free_text : [state.prompt.free_text, importPreviewData.free_text].filter(Boolean).join("\n");
  rebuildTargetSelect(); commitPromptChange(); importPreviewData = null; closeImportModal(); toast(`已导入 ${imported} 个标签`);
}

async function doImportFromModal() {
  const text = $("#import-text").value.trim();
  if (!text) { toast("请先粘贴提示词"); return; }
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  const target = $("#import-target").value || "base";
  const r = await api("/api/import", { method: "POST", body: JSON.stringify({ text, mode }) });
  applyImported(r.parsed, mode, target);
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
  $("#browse-title").textContent = "我的收藏";
  renderTagCards([...state.favorites].map((t) => ({ tag: t, zh: zhMap[t] || "", post_count: 0 })));
}

function renderRecentView() {
  $("#browse-title").textContent = "最近使用的标签";
  renderTagCards(state.recent.map((t) => ({ tag: t, zh: zhMap[t] || "", post_count: 0 })));
}

async function showView(view) {
  if (view === state.view) return;
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
$("#target-select").addEventListener("change", (e) => { state.target = e.target.value; });
$("#nai-tag-target")?.addEventListener("change", (e) => {
  const v = e.target.value;
  const m = v.match(/^char:(\d+)$/);
  state.target = v === "base" || (m && naiCharacters[Number(m[1])]) ? v : "base";
});
$("#search-input").addEventListener("input", (e) => doSearch(e.target.value));
$("#cat-filter").addEventListener("change", () => doSearch($("#search-input").value));
bind("#semantic-search-btn", "click", runSemanticSearch);
const semanticCloseBtn = $("#semantic-close");
if (semanticCloseBtn) semanticCloseBtn.addEventListener("click", () => { const box = $("#semantic-results"); if (box) box.hidden = true; });
const recommendationsCloseBtn = $("#recommendations-close");
if (recommendationsCloseBtn) recommendationsCloseBtn.addEventListener("click", () => { const box = $("#recommendations"); if (box) box.hidden = true; });
$("#sort-select").addEventListener("change", (e) => { sortMode = e.target.value; if (activeCatalogId) openCatalog(activeCatalogId, 1); });
$("#back-btn").addEventListener("click", goBack);
$("#cart-advanced-toggle").addEventListener("click", () => { cartAdvanced = !cartAdvanced; rebuildTargetSelect(); renderCart(); });
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
$("#import-ok").addEventListener("click", async () => {
  if (importPreviewData) await applyImportedPreview();
  else await doImportFromModal();
});
$("#import-cancel").addEventListener("click", closeImportModal);
$("#import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") closeImportModal(); });
$("#custom-tag-cancel").addEventListener("click", closeCustomTagModal);
$("#custom-tag-save").addEventListener("click", submitCustomTag);
$("#custom-tag-name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitCustomTag(); } });
$("#custom-tag-modal").addEventListener("click", (e) => { if (e.target.id === "custom-tag-modal") closeCustomTagModal(); });
bind("#top-import-btn", "click", openImportModal);
bind("#bundles-btn", "click", openBundlesModal);
bind("#prompt-history-btn", "click", openSnapshotModal);
bind("#bundles-close", "click", closeBundlesModal); bind("#bundle-create", "click", () => createBundle());
bind("#snapshot-close", "click", closeSnapshotModal); bind("#save-snapshot-btn", "click", () => saveSnapshot());
bind("#save-bundle-btn", "click", () => openBundlesModal());
bind("#send-generate-btn", "click", async () => { const text = promptPreviewText(); if (!text) { toast("当前 Prompt 为空"); return; } await showView("generate"); await naiFillFromCart(); });
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
let galleryItems = [];
let selectedGalleryFiles = new Set();
const GALLERY_ZOOM_KEY = "tags-market-gallery-zoom";
const GALLERY_ZOOM_LEVELS = ["small", "medium", "large"];
let galleryZoom = GALLERY_ZOOM_LEVELS.includes(localStorage.getItem(GALLERY_ZOOM_KEY)) ? localStorage.getItem(GALLERY_ZOOM_KEY) : "medium";

function galleryFileKey(dirName, fileName) { return `${dirName}\u0000${fileName}`; }
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
  const selected = galleryItems.filter((it) => selectedGalleryFiles.has(galleryFileKey(activeGalleryDir, it.file_name))).length;
  $("#gallery-select-all").textContent = total && selected === total ? "取消全选" : "全选";
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
    else pendingScroll = null;
  } catch (e) { toast("图库加载失败：" + e.message); }
}

async function openGalleryDir(dirName) {
  activeGalleryDir = dirName;
  selectedGalleryFiles.clear();
  $("#gallery-dir-list").querySelectorAll(".gallery-dir").forEach((n) =>
    n.classList.toggle("active", n.dataset.dir === dirName)
  );
  $("#gallery-title").textContent = dirName;
  $("#gallery-del-btn").style.display = "inline-block";
  try {
    const data = await api(`/api/gallery/${encodeURIComponent(dirName)}`);
    galleryItems = data.items;
    const grid = $("#gallery-grid");
    applyGalleryZoom();
    if (!data.items.length) { grid.innerHTML = `<div class="empty">该目录暂无图片</div>`; updateGallerySelectionUi(); pendingScroll = null; return; }
    grid.innerHTML = data.items.map((it) =>
      `<div class="gallery-card ${it.favorite ? "fav" : ""}" data-file="${esc(it.file_name)}">` +
      `<input class="gallery-select" type="checkbox" aria-label="选择图片" ${selectedGalleryFiles.has(galleryFileKey(dirName, it.file_name)) ? "checked" : ""} />` +
      `<img src="/gallery/${encodeURIComponent(dirName)}/${encodeURIComponent(it.file_path.split("/").pop())}" loading="lazy" alt="" />` +
      `<button class="gallery-fav ${it.favorite ? "on" : ""}" title="${it.favorite ? "取消收藏" : "收藏"}">★</button>` +
      `<div class="gallery-card-prompt">${esc(it.prompt)}</div>` +
      `<div class="gallery-card-actions">` +
      `<button class="gallery-action-btn" data-action="restore" title="恢复参数">恢复参数</button>` +
      `<button class="gallery-action-btn" data-action="seed" title="复用 Seed">复用 Seed</button>` +
      `<button class="gallery-action-btn" data-action="copy" title="复制 Prompt">复制 Prompt</button>` +
      `</div>` +
      `</div>`
    ).join("");
    updateGallerySelectionUi();
    if (pendingScroll != null) {
      const st = pendingScroll; pendingScroll = null;
      requestAnimationFrame(() => { grid.scrollTop = st; });
    }
    grid.querySelectorAll(".gallery-card").forEach((card) => {
      const checkbox = card.querySelector(".gallery-select");
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => toggleGalleryFile(dirName, card.dataset.file, checkbox.checked));
      card.addEventListener("click", (e) => {
        if (e.target.closest(".gallery-fav") || e.target.closest(".gallery-select") || e.target.closest(".gallery-action-btn")) return;
        showGalleryPreview(dirName, card.dataset.file);
      });
      card.querySelector(".gallery-fav").addEventListener("click", (e) => {
        e.stopPropagation();
        const fav = !card.classList.contains("fav");
        toggleGalleryFav(dirName, card.dataset.file, fav);
      });
      // Metadata restore action buttons
      card.querySelectorAll(".gallery-action-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const fileName = card.dataset.file;
          const item = galleryItems.find((x) => x.file_name === fileName);
          if (!item) return;
          const action = btn.dataset.action;
          if (action === "restore") {
            const meta = extractMetaFromGalleryItem(item);
            await showView("generate");
            applyGenerationConfig(meta);
          } else if (action === "seed") {
            const meta = extractMetaFromGalleryItem(item);
            if (meta.seed != null) {
              await showView("generate");
              $("#nai-seed").value = String(meta.seed);
              $("#nai-seed-mode").value = "fixed";
              toast(`Seed ${meta.seed} 已填入（Fixed 模式）`);
            } else { toast("该图无 Seed 信息"); }
          } else if (action === "copy") {
            const meta = extractMetaFromGalleryItem(item);
            const text = meta.effectivePrompt || meta.rawPrompt || item.prompt || "";
            try { await navigator.clipboard.writeText(text); toast("Prompt 已复制"); }
            catch { $("#nai-prompt").value = text; toast("已填入 Prompt 框"); }
          }
        });
      });
    });
  } catch (e) { toast("目录加载失败：" + e.message); }
}

async function showGalleryPreview(dirName, fileName) {
  try {
    const data = await api(`/api/gallery/${encodeURIComponent(dirName)}`);
    const it = data.items.find((x) => x.file_name === fileName);
    if (!it) return;
    const body = $("#gallery-preview-body");
    const imgPath = `/gallery/${encodeURIComponent(dirName)}/${encodeURIComponent(it.file_path.split("/").pop())}`;
    body.innerHTML =
      `<img src="${imgPath}" class="gallery-preview-img" alt="" />` +
      (() => { const recipe = naiRecipeFromItem(it), settings = recipe.settings || recipe; return `<dl class="gallery-meta"><dt>Prompt</dt><dd>${esc(it.prompt || "")}</dd><dt>Negative</dt><dd>${esc(it.negative_prompt || "")}</dd><dt>Seed</dt><dd>${esc(settings.seed ?? it.seed ?? "-")}</dd><dt>Model</dt><dd>${esc(settings.model ?? it.model ?? "-")}</dd></dl>`; })() +
      `<div class="gallery-preview-actions"><button class="primary" id="gallery-copy-btn">复制提示词</button><button class="ghost" id="gallery-fav-btn">${it.favorite ? "取消收藏 ★" : "收藏 ☆"}</button></div>` +
      `<div class="gallery-recipe-actions"><button id="gallery-recipe-restore">恢复参数</button><button id="gallery-recipe-seed">复用 Seed</button><button id="gallery-recipe-copy-prompt">复制 Prompt</button><button id="gallery-recipe-img2img">以此图进行图生图</button></div>` +
      (it.snapshot_id ? `<div class="gallery-restore-actions"><button data-restore-sections="">全部加载</button><button data-restore-sections="character,appearance,clothing,expression,action">加载角色</button><button data-restore-sections="style,quality">加载画风</button><button data-restore-sections="composition,scene">加载构图</button></div>` : "");
    $("#gallery-copy-btn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(it.prompt);
        toast("提示词已复制");
      } catch { toast("复制失败，请手动选择"); }
    });
    $("#gallery-fav-btn").addEventListener("click", () => {
      toggleGalleryFav(dirName, it.file_name, !it.favorite);
      showGalleryPreview(dirName, it.file_name);
    });
    $("#gallery-recipe-restore").addEventListener("click", async () => {
      const meta = extractMetaFromGalleryItem(it);
      await showView("generate");
      applyGenerationConfig(meta);
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
      catch { $("#nai-prompt").value = text; toast("已填入 Prompt 框"); }
    });
    $("#gallery-recipe-img2img").addEventListener("click", async () => { await showView("generate"); await naiUseImageSource(imgPath, it.file_name || "图库图片"); toast("已设为图生图基础图"); });
    body.querySelectorAll("[data-restore-sections]").forEach((b) => b.addEventListener("click", () => restoreSnapshot(it.snapshot_id, b.dataset.restoreSections)));
  } catch (e) { toast("预览失败：" + e.message); }
}

async function toggleGalleryFav(dirName, fileName, fav) {
  try {
    await api("/api/gallery/favorite", { method: "POST", body: JSON.stringify({ dir_name: dirName, file_name: fileName, favorite: fav }) });
    // 更新卡片状态
    const card = document.querySelector(`.gallery-card[data-file="${CSS.escape(fileName)}"]`);
    if (card) { card.classList.toggle("fav", fav); card.querySelector(".gallery-fav").classList.toggle("on", fav); }
    toast(fav ? "已收藏" : "已取消收藏");
    loadGalleryList();
  } catch (e) { toast("操作失败：" + e.message); }
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
let naiNegSplit = false;
let naiStructuredDraft = null;
let naiGenerationMode = "txt2img";
let naiImg2ImgSource = null;
let naiCharacters = [];
// P0: Generation Preset & Prompt Compiler state
let naiPresetMode = localStorage.getItem("nai_preset_mode") || "website"; // website | high_quality | custom
let naiQualityTagsEnabled = true;
let naiHeavyUcEnabled = true;
let naiTransparentBg = false;

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
  return Number.isInteger(configured) ? Math.max(1, Math.min(100, configured)) : 6;
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
    return preset;
  }
  naiSyncCountOptions();
  return null;
}

function naiSyncResolutionFromInputs() {
  const key = naiResolutionPresetForSize($("#nai-width").value, $("#nai-height").value);
  $("#nai-resolution-category").value = key;
  naiSyncCountOptions();
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
  const list = $("#nai-character-list");
  const count = document.getElementById("nai-character-count");
  if (count) count.textContent = String(naiCharacters.length);
  rebuildNaiTagTarget();
  if (!naiCharacters.length) {
    list.innerHTML = `<div class="empty">暂无独立角色</div>`;
    return;
  }
  list.innerHTML = naiCharacters.map((character, index) => {
    const manual = !!character.position;
    return `<article class="nai-character" data-character-index="${index}">
      <div class="nai-character-head"><strong>角色 ${index + 1}</strong><div>
        <button type="button" data-character-move="up" title="上移" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-character-move="down" title="下移" ${index === naiCharacters.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" data-character-remove title="移除角色">×</button>
      </div></div>
      <label><span>Prompt</span><textarea data-character-field="prompt" placeholder="角色独立提示词">${esc(character.prompt || "")}</textarea></label>
      <label><span>UC</span><textarea data-character-field="negative_prompt" placeholder="角色独立负面提示词">${esc(character.negative_prompt || "")}</textarea></label>
      <label class="nai-character-position"><input type="checkbox" data-character-manual ${manual ? "checked" : ""} /><span>手动位置</span></label>
      <div class="nai-coordinate-row" ${manual ? "" : "hidden"}>
        <label><span>X</span><input type="number" min="0" max="1" step="0.05" data-character-field="x" value="${character.position?.x ?? 0.5}" /></label>
        <label><span>Y</span><input type="number" min="0" max="1" step="0.05" data-character-field="y" value="${character.position?.y ?? 0.5}" /></label>
      </div>
    </article>`;
  }).join("");
}

function naiAddCharacter(character = {}) {
  naiCharacters.push({ prompt: character.prompt || "", negative_prompt: character.negative_prompt || character.uc || "", position: character.position && character.position !== "auto" ? { x: Number(character.position.x ?? 0.5), y: Number(character.position.y ?? 0.5) } : null });
  naiRenderCharacters();
}

function naiCollectCharacters() {
  return naiCharacters.map((character) => ({
    prompt: String(character.prompt || "").trim(),
    negative_prompt: String(character.negative_prompt || "").trim(),
    position: character.position ? { x: Number(character.position.x), y: Number(character.position.y) } : null,
  })).filter((character) => character.prompt);
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
    quality_preset: $("#nai-quality").value,
    preset_mode: naiPresetMode,
    quality_tags: naiQualityTagsEnabled,
    heavy_uc: naiHeavyUcEnabled,
    transparent_bg: naiTransparentBg,
  };
}

function naiQualityEnabled(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !["off", "false", "0", "disabled"].includes(normalized);
}

// ---- P0: Generation Preset Mode ----
const NAI_PRESET_CONFIGS = Object.freeze({
  website: { steps: 23, guidance: 7, sampler: "k_euler_ancestral", scheduler: "karras", cfg_rescale: 0, auto_smea: false, qualityTags: true, heavyUc: true },
  high_quality: { steps: 28, guidance: 7, sampler: "k_euler_ancestral", scheduler: "karras", cfg_rescale: 0, auto_smea: false, qualityTags: true, heavyUc: true },
  custom: null, // custom = user controls everything
});

function naiApplyPresetMode(mode) {
  naiPresetMode = mode;
  localStorage.setItem("nai_preset_mode", mode);
  // Update radio UI
  document.querySelectorAll('input[name="nai-preset"]').forEach((r) => { r.checked = r.value === mode; });
  const advanced = $("#nai-advanced-section");
  if (mode === "custom") {
    advanced.classList.remove("nai-advanced-locked");
  } else {
    advanced.classList.add("nai-advanced-locked");
    // Apply preset values to hidden fields
    const cfg = NAI_PRESET_CONFIGS[mode];
    if (cfg) {
      $("#nai-steps").value = cfg.steps;
      $("#nai-guidance").value = cfg.guidance;
      naiSetSelectValue("#nai-sampler", cfg.sampler, "k_euler_ancestral");
      if ($("#nai-scheduler")) $("#nai-scheduler").value = cfg.scheduler;
      if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").value = cfg.cfg_rescale;
      if ($("#nai-auto-smea")) $("#nai-auto-smea").value = String(cfg.auto_smea);
      naiQualityTagsEnabled = cfg.qualityTags;
      naiHeavyUcEnabled = cfg.heavyUc;
      $("#nai-quality-tags").checked = cfg.qualityTags;
      $("#nai-heavy-uc").checked = cfg.heavyUc;
    }
  }
  naiUpdateEffectivePreview();
  naiRenderCost();
  updateAdvSummary(naiCollectParameters());
}

// ---- P0: Effective Preview ----
function naiUpdateEffectivePreview() {
  const rawPrompt = $("#nai-prompt").value;
  const rawNeg = $("#nai-neg").value;
  const { compilePrompt, compileNegative } = window.PromptCompiler;
  const effectivePrompt = compilePrompt(rawPrompt, { qualityTags: naiQualityTagsEnabled, transparentBackground: naiTransparentBg });
  const effectiveNegative = compileNegative(rawNeg, { heavyUc: naiHeavyUcEnabled });
  const params = naiCollectParameters();
  const preset = NAI_RESOLUTION_PRESETS[params.resolution_category];
  const resolutionStr = preset ? `${preset.width}×${preset.height}` : `${params.width}×${params.height}`;
  const seedStr = params.seed_mode === "random" ? "Random" : String(params.seed ?? "-");
  if ($("#nai-effective-prompt")) $("#nai-effective-prompt").textContent = effectivePrompt || "(空)";
  if ($("#nai-effective-negative")) $("#nai-effective-negative").textContent = effectiveNegative || "(空)";
  if ($("#nai-eff-model")) $("#nai-eff-model").textContent = params.model;
  if ($("#nai-eff-resolution")) $("#nai-eff-resolution").textContent = resolutionStr;
  if ($("#nai-eff-sampler")) $("#nai-eff-sampler").textContent = params.sampler;
  if ($("#nai-eff-scheduler")) $("#nai-eff-scheduler").textContent = params.scheduler || "karras";
  if ($("#nai-eff-steps")) $("#nai-eff-steps").textContent = params.steps;
  if ($("#nai-eff-cfg")) $("#nai-eff-cfg").textContent = params.guidance;
  if ($("#nai-eff-seed")) $("#nai-eff-seed").textContent = seedStr;
}

function naiStructuredRequest(prompt, negativePrompt) {
  if (!naiStructuredDraft) return null;
  if (prompt.trim() !== naiStructuredDraft.displayPrompt || negativePrompt !== naiStructuredDraft.displayNegative) return null;
  return {
    prompt: naiStructuredDraft.basePrompt,
    negative_prompt: naiStructuredDraft.globalUc,
    characters: naiStructuredDraft.characters,
  };
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
  const text = $("#nai-prompt").value.trim();
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
  naiRenderCharacters();
  naiUpdateRangeLabels();
  naiSyncResolutionFromInputs();
  naiRenderCost();
  loadNaiGallery();
  loadNaiApiStatus();
  // P0: Initialize preset mode & toggles
  naiApplyPresetMode(naiPresetMode);
  naiUpdateEffectivePreview();
  if (!naiSSEOpened) { naiSSEOpened = true; naiSSE(); }
}

async function naiGenerate() {
  const prompt = $("#nai-prompt").value;
  const negativePrompt = $("#nai-neg").value;
  if (!prompt.trim()) { toast("提示词为空"); return; }
  if (!naiApiConfigured) { toast("未配置 NovelAI 官方 API Token，已阻止生成"); return; }
  const parameters = naiCollectParameters();
  const structured = naiStructuredRequest(prompt, negativePrompt);
  // P0: Apply Prompt Compiler to get effective prompt/negative
  const { compilePrompt, compileNegative } = window.PromptCompiler;
  const rawGenerationPrompt = structured?.prompt || prompt.trim();
  const rawGenerationNegative = structured?.negative_prompt ?? negativePrompt;
  const generationPrompt = compilePrompt(rawGenerationPrompt, { qualityTags: naiQualityTagsEnabled, transparentBackground: naiTransparentBg });
  const generationNegative = compileNegative(rawGenerationNegative, { heavyUc: naiHeavyUcEnabled });
  const editorCharacters = naiCollectCharacters();
  const characters = editorCharacters.length ? editorCharacters : (structured?.characters || []);
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
  const savedSnapshot = await saveSnapshot({ positive_prompt: generationPrompt, negative_prompt: generationNegative, structured_state: structured ? state.prompt : emptyPromptState(), generation: generationState, quiet: true });
  if (!savedSnapshot || !pendingSnapshotId) { toast("正式生成前保存快照失败，已阻止生成"); return; }
  const snapshotId = pendingSnapshotId;
  updateAdvSummary(parameters);
  naiSetPhase("submitting");
  try {
    const meta = {
      rawPrompt: $("#nai-prompt").value,
      effectivePrompt: generationPrompt,
      rawNegative: $("#nai-neg").value,
      effectiveNegative: generationNegative,
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
      qualityPreset: parameters.quality_preset,
      ucPreset: naiHeavyUcEnabled ? "heavy" : "off",
      transparentBackground: naiTransparentBg,
      presetMode: naiPresetMode,
      qualityTags: naiQualityTagsEnabled,
      heavyUc: naiHeavyUcEnabled,
      resolution_category: parameters.resolution_category,
      mode: naiGenerationMode,
      ...(characters.length ? { characterPrompts: characters } : {}),
    };
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
        },
        count,
        quality_toggle: naiQualityEnabled(parameters.quality_preset),
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

async function naiFillFromCart() {
  try {
    const r = await api("/api/export", { method: "POST", body: JSON.stringify(exportPayload()) });
    const text = r.multi_character ? r.structured : r.flat;
    if (!text?.trim()) { toast("购物车为空"); return; }
    const basePrompt = [r.base, r.free_text].filter((part) => part?.trim()).join(", ");
    const characters = (r.characters || [])
      .filter((character) => character.prompt?.trim())
      .map((character) => ({
        prompt: character.prompt,
        negative_prompt: character.uc || "",
        position: character.position || "auto",
      }));
    $("#nai-prompt").value = text;
    $("#nai-neg").value = r.global_uc || "";
    naiStructuredDraft = {
      displayPrompt: text.trim(),
      displayNegative: r.global_uc || "",
      basePrompt,
      globalUc: r.global_uc || "",
      characters,
    };
    naiCharacters = characters.map((character) => ({ ...character, position: character.position === "auto" ? null : character.position }));
    naiRenderCharacters();
    updateNaiPromptMeta();
    naiUpdateEffectivePreview();
    toast(characters.length ? `已填入结构化 Prompt（${characters.length} 个角色）` : "已填入购物车提示词");
  } catch (e) { toast("填入失败：" + e.message); }
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
  meta.querySelectorAll("[data-viewer-restore]").forEach((b) => b.addEventListener("click", () => restoreSnapshot(it.snapshot_id, b.dataset.viewerRestore)));
  meta.querySelectorAll("[data-meta-action]").forEach((b) => b.addEventListener("click", () => {
    const itemMeta = extractMetaFromGalleryItem(it);
    if (b.dataset.metaAction === "restore") { applyGenerationConfig(itemMeta); }
    else if (b.dataset.metaAction === "seed" && itemMeta.seed != null) { $("#nai-seed").value = String(itemMeta.seed); $("#nai-seed-mode").value = "fixed"; toast(`Seed ${itemMeta.seed} 已填入`); }
    else if (b.dataset.metaAction === "copy") { const t = itemMeta.effectivePrompt || itemMeta.rawPrompt || it.prompt || ""; navigator.clipboard.writeText(t).then(() => toast("Prompt 已复制")).catch(() => { $("#nai-prompt").value = t; toast("已填入 Prompt 框"); }); }
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

// 只有明确点击恢复按钮时才写入编辑表单；点击历史缩略图只切换预览。
async function naiRestoreItem(it) {
  if (!it) { toast("没有可恢复的图片"); return; }
  const recipe = naiRecipeFromItem(it);
  const p = recipe.settings || recipe;
  $("#nai-prompt").value = recipe.prompt || it.prompt || "";
  $("#nai-neg").value = recipe.negative_prompt ?? it.negative_prompt ?? "";
  naiSetSelectValue("#nai-model", p.model, "nai-diffusion-5-full");
  $("#nai-width").value = p.width ?? 832;
  $("#nai-height").value = p.height ?? 1216;
  $("#nai-resolution-category").value = naiResolutionPresetForSize(p.width ?? 832, p.height ?? 1216);
  naiSyncCountOptions();
  $("#nai-count").value = String(Math.max(1, Math.min(naiBatchMaxCount(), Number(recipe.count || p.count || 1))));
  $("#nai-seed-mode").value = p.seed_mode || "fixed";
  $("#nai-seed").value = p.seed != null ? String(p.seed) : "";
  $("#nai-steps").value = p.steps != null ? String(p.steps) : "28";
  $("#nai-guidance").value = p.guidance != null ? String(p.guidance) : "5";
  naiSetSelectValue("#nai-sampler", p.sampler, "k_euler_ancestral");
  if ($("#nai-scheduler")) $("#nai-scheduler").value = p.scheduler || "karras";
  if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").value = p.cfg_rescale ?? 0;
  if ($("#nai-auto-smea")) $("#nai-auto-smea").value = String(p.auto_smea ?? false);
  naiSetSelectValue("#nai-quality", recipe.quality_toggle === false ? "off" : p.quality_preset, "on");
  naiCharacters = Array.isArray(recipe.characters) ? recipe.characters.map((character) => ({
    prompt: character.prompt || "",
    negative_prompt: character.negative_prompt || "",
    position: character.position ? { ...character.position } : null,
  })) : [];
  naiRenderCharacters();
  naiStructuredDraft = null;
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
  // Prompt
  if (cfg.rawPrompt != null) $("#nai-prompt").value = cfg.rawPrompt;
  if (cfg.rawNegative != null) $("#nai-neg").value = cfg.rawNegative;
  // Model
  naiSetSelectValue("#nai-model", cfg.model, "nai-diffusion-5-full");
  // Resolution
  const w = Number(cfg.width) || 832;
  const h = Number(cfg.height) || 1216;
  $("#nai-width").value = w;
  $("#nai-height").value = h;
  $("#nai-resolution-category").value = naiResolutionPresetForSize(w, h);
  naiSyncCountOptions();
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
  // Quality / UC toggles
  if (cfg.qualityPreset) naiSetSelectValue("#nai-quality", cfg.qualityPreset, "on");
  if (cfg.presetMode) {
    naiPresetMode = cfg.presetMode;
    localStorage.setItem("nai_preset_mode", cfg.presetMode);
    document.querySelectorAll('input[name="nai-preset"]').forEach((r) => { r.checked = r.value === cfg.presetMode; });
  }
  if (cfg.qualityTags != null) {
    naiQualityTagsEnabled = !!cfg.qualityTags;
    if ($("#nai-quality-tags")) $("#nai-quality-tags").checked = naiQualityTagsEnabled;
  }
  if (cfg.heavyUc != null) {
    naiHeavyUcEnabled = !!cfg.heavyUc;
    if ($("#nai-heavy-uc")) $("#nai-heavy-uc").checked = naiHeavyUcEnabled;
  }
  if (cfg.transparentBackground != null) {
    naiTransparentBg = !!cfg.transparentBackground;
    if ($("#nai-transparent")) $("#nai-transparent").checked = naiTransparentBg;
  }
  // Mode
  if (cfg.mode) naiSetMode(cfg.mode);
  // Characters
  if (Array.isArray(cfg.characterPrompts)) {
    naiCharacters = cfg.characterPrompts.map((c) => ({
      prompt: c.prompt || "",
      negative_prompt: c.negative_prompt || "",
      position: c.position ? { ...c.position } : null,
    }));
    naiRenderCharacters();
    if (naiCharacters.length > 0) {
      const section = document.getElementById("nai-characters-section");
      if (section) section.open = true;
    }
  }
  // Refresh UI
  naiStructuredDraft = null;
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
    qualityPreset: recipe.quality_toggle === false ? "off" : "on",
    ucPreset: "heavy",
    transparentBackground: false,
    presetMode: "custom",
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
  const section = document.getElementById("nai-characters-section");
  if (section) section.open = true;
});
$("#nai-character-list").addEventListener("input", (event) => {
  const article = event.target.closest("[data-character-index]");
  const field = event.target.dataset.characterField;
  if (!article || !field) return;
  const character = naiCharacters[Number(article.dataset.characterIndex)];
  if (["x", "y"].includes(field)) {
    character.position ||= { x: 0.5, y: 0.5 };
    character.position[field] = Math.max(0, Math.min(1, Number(event.target.value)));
  } else character[field] = event.target.value;
});
$("#nai-character-list").addEventListener("change", (event) => {
  if (!event.target.matches("[data-character-manual]")) return;
  const article = event.target.closest("[data-character-index]");
  const character = naiCharacters[Number(article.dataset.characterIndex)];
  character.position = event.target.checked ? { x: 0.5, y: 0.5 } : null;
  naiRenderCharacters();
});
$("#nai-character-list").addEventListener("click", (event) => {
  const article = event.target.closest("[data-character-index]");
  if (!article) return;
  const index = Number(article.dataset.characterIndex);
  if (event.target.matches("[data-character-remove]")) {
    state.target = remapNaiTagTarget(state.target, "remove", index);
    naiCharacters.splice(index, 1);
  } else if (event.target.matches('[data-character-move="up"]') && index > 0) {
    state.target = remapNaiTagTarget(state.target, "move", index, index - 1);
    [naiCharacters[index - 1], naiCharacters[index]] = [naiCharacters[index], naiCharacters[index - 1]];
  } else if (event.target.matches('[data-character-move="down"]') && index < naiCharacters.length - 1) {
    state.target = remapNaiTagTarget(state.target, "move", index, index + 1);
    [naiCharacters[index + 1], naiCharacters[index]] = [naiCharacters[index], naiCharacters[index + 1]];
  } else return;
  naiRenderCharacters();
});
$("#nai-fill-cart").addEventListener("click", naiFillFromCart);
$("#nai-seed-random").addEventListener("click", () => { $("#nai-seed").value = Math.floor(Math.random() * 2147483647); });
$("#nai-prompt").addEventListener("input", updateNaiPromptMeta);
$("#nai-neg").addEventListener("input", updateNaiPromptMeta);
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
document.querySelectorAll(".nai-tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".nai-tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#nai-prompt").style.display = t.dataset.tab === "prompt" ? "" : "none";
  $("#nai-neg").style.display = t.dataset.tab === "undesired" ? "" : "none";
}));
$("#nai-split-neg").addEventListener("click", () => {
  naiNegSplit = !naiNegSplit;
  if (naiNegSplit) {
    $("#nai-prompt").style.display = "";
    $("#nai-neg").style.display = "";
    document.querySelectorAll(".nai-tab").forEach((x) => x.classList.remove("active"));
    toast("负面提示词已并排显示（再点恢复 Tab）");
  } else {
    $("#nai-prompt").style.display = "";
    $("#nai-neg").style.display = "none";
    document.querySelectorAll(".nai-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "prompt"));
  }
});
$("#nai-history-refresh").addEventListener("click", loadNaiGallery);

// ---- P0: Preset Mode / Quality Tags / Heavy UC / Transparent / Effective Preview ----
document.querySelectorAll('input[name="nai-preset"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) naiApplyPresetMode(r.value); }));
$("#nai-quality-tags").addEventListener("change", () => { naiQualityTagsEnabled = $("#nai-quality-tags").checked; naiUpdateEffectivePreview(); });
$("#nai-heavy-uc").addEventListener("change", () => { naiHeavyUcEnabled = $("#nai-heavy-uc").checked; naiUpdateEffectivePreview(); });
$("#nai-transparent").addEventListener("change", () => { naiTransparentBg = $("#nai-transparent").checked; naiUpdateEffectivePreview(); });
$("#nai-prompt").addEventListener("input", naiUpdateEffectivePreview);
$("#nai-neg").addEventListener("input", naiUpdateEffectivePreview);
$("#nai-model").addEventListener("change", naiUpdateEffectivePreview);
$("#nai-sampler").addEventListener("change", naiUpdateEffectivePreview);
if ($("#nai-scheduler")) $("#nai-scheduler").addEventListener("change", naiUpdateEffectivePreview);
$("#nai-steps").addEventListener("input", naiUpdateEffectivePreview);
$("#nai-guidance").addEventListener("input", naiUpdateEffectivePreview);
if ($("#nai-cfg-rescale")) $("#nai-cfg-rescale").addEventListener("input", naiUpdateEffectivePreview);
if ($("#nai-auto-smea")) $("#nai-auto-smea").addEventListener("change", naiUpdateEffectivePreview);


init();
pollInbox(true);
setInterval(() => pollInbox(false), 1200);
