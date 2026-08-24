"use strict";

// ===== 状态 =====
const state = {
  model: "v5",
  target: "base",
  characters: [{ name: "Character 1", prompt: [], uc: [] }],
  base: [],
  global_uc: [],
  free_text: "",
  categories: [],
  activeCategory: null,
  activeDbCat: null,
  view: "browse",
  favorites: new Set(),
  recent: [],
  models: [],
  history: [], // 撤销栈（快照）
};

const RELATIONS = ["", "source", "target", "mutual"];

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

function snapshot() { return JSON.stringify({ base: state.base, characters: state.characters, global_uc: state.global_uc, free_text: state.free_text }); }
function pushHistory() { state.history.push(snapshot()); if (state.history.length > 50) state.history.shift(); }

// ===== 用户设置 =====
let userSettings = { adolescent_mode: true, cache_limit_mb: 1024, cache_usage_mb: 0, proxy_enabled: true, proxy_url: "", danbooru_login: "", has_danbooru_api_key: false };

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
  $("#settings-status").textContent = `当前缓存：${s.cache_usage_mb ?? 0}MB / ${s.cache_limit_mb ?? 1024}MB`;
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
    };
    if (!Number.isFinite(payload.cache_limit_mb) || payload.cache_limit_mb < 0) {
      throw new Error("缓存上限必须是 0 或更大的数字");
    }
    userSettings = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    closeSettings();
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

// ===== 目标槽位 =====
function targetOptions() {
  const opts = [{ value: "base", label: "Base Prompt" }, { value: "global_uc", label: "Global UC" }];
  state.characters.forEach((ch, i) => {
    opts.push({ value: `char:${i}`, label: `${ch.name || "Character " + (i + 1)} Prompt` });
    opts.push({ value: `char:${i}:uc`, label: `${ch.name || "Character " + (i + 1)} UC` });
  });
  return opts;
}
function rebuildTargetSelect() {
  const sel = $("#target-select");
  const cur = state.target;
  sel.innerHTML = targetOptions().map((o) => `<option value="${o.value}" ${o.value === cur ? "selected" : ""}>${esc(o.label)}</option>`).join("");
}

// ===== 初始化 =====
async function init() {
  await loadUserSettings();
  const m = await api("/api/models");
  state.models = m.models;
  state.model = m.default;
  $("#model-select").innerHTML = m.models.map((x) => `<option value="${x.id}" ${x.id === m.default ? "selected" : ""}>${esc(x.label)}</option>`).join("");
  rebuildTargetSelect();
  await Promise.all([loadTaxonomy(), loadFavorites(), loadRecent()]);
  await loadZh();
  renderCart();
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
  // 默认打开第一个子目录（我的 -> 我的收藏）
  const first = catalogGroups[0]?.children?.[0];
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
    `<button class="fav-toggle ${fav ? "on" : ""}" data-fav="${esc(t.tag)}" title="${fav ? "取消收藏" : "收藏"}">${fav ? "★" : "☆"}</button>` +
    `<div class="tag-en">${esc(t.tag)}</div>` +
    (t.zh ? `<div class="tag-zh">${esc(t.zh)}</div>` : "") +
    `<div class="tag-meta">${esc(meta || "General")}</div>` +
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
    n.addEventListener("click", () => addEntry(n.dataset.tag))
  );
  el.querySelectorAll(".fav-toggle").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(b.dataset.fav); })
  );
  loadThumbs(tags.map((t) => t.tag));
}

// ===== 例图懒加载 =====
const thumbMap = {};   // tag -> 缩略图本地 URL
const largeMap = {};   // tag -> 大图本地 URL
let thumbLoadSeq = 0;
let thumbLoadState = null;

// 卡片默认显示缩略图（小、加载快）；悬停预览时才用大图（清晰）
function cardImgUrl(tag) {
  return thumbMap[tag] || largeMap[tag] || "";
}

function cardLargeUrl(tag) {
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
      document.querySelector(`[data-thumb-wrap="${CSS.escape(tag)}"]`)?.classList.add("failed");
    });
    updateThumbProgress();
  }
}

function applyThumbs(seq = thumbLoadSeq) {
  if (seq !== thumbLoadSeq) return;
  document.querySelectorAll("img[data-thumb]").forEach((img) => {
    const tag = img.dataset.thumb;
    const url = cardImgUrl(tag);
    if (!url || img.dataset.srcApplied === url) return;
    img.dataset.srcApplied = url;
    img.onload = () => {
      if (seq !== thumbLoadSeq) return;
      img.classList.add("loaded");
      img.closest(".tag-thumb-wrap")?.classList.add("loaded");
      thumbLoadState?.loaded.add(tag);
      thumbLoadState?.failed.delete(tag);
      updateThumbProgress();
    };
    img.onerror = () => {
      if (seq !== thumbLoadSeq) return;
      thumbLoadState?.failed.add(tag);
      img.closest(".tag-thumb-wrap")?.classList.add("failed");
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
  renderTagCards(results.map((r) => ({ tag: r.tag, zh: r.zh, post_count: r.post_count, is_deprecated: r.is_deprecated })));
}

// ===== 购物车渲染 =====
function entryHtml(e, slotKey) {
  const rel = e.relation || "";
  const wt = e.strength != null && e.strength !== 1 ? e.strength : (e.brackets !== 0 ? (e.brackets > 0 ? "{" + "+".repeat(e.brackets) : "[" + "-".repeat(-e.brackets)) : "");
  const zh = zhMap[e.tag] || "";
  return `<div class="entry" data-slot="${esc(slotKey)}" data-tag="${esc(e.tag)}">` +
    `<span class="rel">${esc(rel)}</span>` +
    `<span class="tag">${esc(e.tag)}${zh ? `<span class="zh">${esc(zh)}</span>` : ""}</span>` +
    `<button title="备注中文" class="note-btn ${zh ? "has" : ""}">${zh ? "✎" : "中文"}</button>` +
    `<span class="wt">${esc(wt === 0 ? "" : wt)}</span>` +
    `<button title="收藏" class="fav-btn">☆</button>` +
    `<button title="上移" class="up">↑</button>` +
    `<button title="下移" class="dn">↓</button>` +
    `<button title="删除" class="del">×</button>` +
    `</div>`;
}

function getSlot(key) {
  if (key === "base") return state.base;
  if (key === "global_uc") return state.global_uc;
  const m = key.match(/^char:(\d+)(:uc)?$/);
  if (m) return m[2] ? state.characters[+m[1]].uc : state.characters[+m[1]].prompt;
  return null;
}

function renderCart() {
  const el = $("#cart");
  let html = "";
  html += `<div class="slot"><div class="slot-title">Base Prompt</div>${state.base.map((e) => entryHtml(e, "base")).join("") || `<div class="empty">空</div>`}</div>`;
  state.characters.forEach((ch, i) => {
    html += `<div class="slot"><div class="slot-title">${esc(ch.name || "Character " + (i + 1))} <span class="rm" data-rm="char:${i}">移除</span></div>` +
      `${ch.prompt.map((e) => entryHtml(e, `char:${i}`)).join("") || `<div class="empty">空</div>`}` +
      `<div class="slot-title" style="margin-top:8px">UC</div>` +
      `${ch.uc.map((e) => entryHtml(e, `char:${i}:uc`)).join("") || `<div class="empty">空</div>`}</div>`;
  });
  html += `<div class="slot"><div class="slot-title">Global UC</div>${state.global_uc.map((e) => entryHtml(e, "global_uc")).join("") || `<div class="empty">空</div>`}</div>`;
  html += `<div class="slot"><div class="slot-title">自然语言（自由文本）</div><textarea class="free-text-box" id="free-text" placeholder="复杂空间关系 / 连续动作 / 画面意图…">${esc(state.free_text)}</textarea></div>`;
  el.innerHTML = html;

  bindEntryControls(el);
  $("#free-text").addEventListener("input", (ev) => { state.free_text = ev.target.value; });
  el.querySelectorAll("[data-rm]").forEach((n) => n.addEventListener("click", () => removeCharacter(+n.dataset.rm.split(":")[1])));
}

function bindEntryControls(root) {
  root.querySelectorAll(".entry").forEach((n) => {
    const slot = n.dataset.slot;
    const tag = n.dataset.tag;
    n.querySelector(".fav-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(tag); });
    n.querySelector(".note-btn").addEventListener("click", (e) => { e.stopPropagation(); editNote(tag); });
    n.querySelector(".up").addEventListener("click", () => moveEntry(slot, tag, -1));
    n.querySelector(".dn").addEventListener("click", () => moveEntry(slot, tag, +1));
    n.querySelector(".del").addEventListener("click", () => removeEntry(slot, tag));
    n.querySelector(".tag").addEventListener("click", () => openWeightEditor(slot, tag));
  });
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
function addEntry(tag) {
  // 同一槽位内去重：同一个 tag 在目标位置已存在时不再重复添加
  const slot = getSlot(state.target);
  if (slot.some((e) => e.tag === tag)) {
    toast(`「${tag}」已在当前位置`);
    return;
  }
  pushHistory();
  const entry = { tag, strength: null, brackets: 0, relation: null };
  slot.push(entry);
  api("/api/recent", { method: "POST", body: JSON.stringify({ tag }) }).catch(() => {});
  renderCart();
}

function removeEntry(slot, tag) {
  pushHistory();
  const arr = getSlot(slot);
  const i = arr.findIndex((e) => e.tag === tag);
  if (i >= 0) arr.splice(i, 1);
  renderCart();
}

function moveEntry(slot, tag, dir) {
  pushHistory();
  const arr = getSlot(slot);
  const i = arr.findIndex((e) => e.tag === tag);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderCart();
}

function openWeightEditor(slot, tag) {
  const arr = getSlot(slot);
  const e = arr.find((x) => x.tag === tag);
  if (!e) return;
  pushHistory();
  const strength = prompt(`数值权重（如 1.5 / 0.7 / -1，留空表示无）：`, e.strength != null ? e.strength : "");
  if (strength !== null && strength.trim() !== "") {
    const v = parseFloat(strength);
    e.strength = isNaN(v) ? null : v;
    e.brackets = 0;
  } else {
    e.strength = null;
  }
  if (e.strength == null) {
    const br = prompt(`强调层级（+N 加强 / -N 弱化 / 0 无）：`, e.brackets);
    if (br !== null) {
      const v = parseInt(br, 10);
      e.brackets = isNaN(v) ? 0 : v;
    }
  }
  const rel = prompt(`关系前缀（空 / source / target / mutual）：`, e.relation || "");
  if (rel !== null && RELATIONS.includes(rel.trim())) e.relation = rel.trim() || null;
  renderCart();
}

function addCharacter() {
  pushHistory();
  state.characters.push({ name: `Character ${state.characters.length + 1}`, prompt: [], uc: [] });
  rebuildTargetSelect();
  renderCart();
}

function removeCharacter(i) {
  pushHistory();
  state.characters.splice(i, 1);
  if (state.target.startsWith("char:")) {
    const m = state.target.match(/^char:(\d+)/);
    if (m && +m[1] >= state.characters.length) state.target = "base";
  }
  rebuildTargetSelect();
  renderCart();
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
  pushHistory();
  state.base = []; state.global_uc = []; state.free_text = "";
  state.characters = [{ name: "Character 1", prompt: [], uc: [] }];
  rebuildTargetSelect();
  renderCart();
}

function undo() {
  const last = state.history.pop();
  if (last == null) return;
  const s = JSON.parse(last);
  state.base = s.base; state.characters = s.characters; state.global_uc = s.global_uc; state.free_text = s.free_text;
  rebuildTargetSelect();
  renderCart();
}

// ===== 导出 =====
async function doExport() {
  const payload = {
    model: state.model,
    base_prompt: state.base,
    characters: state.characters,
    global_uc: state.global_uc,
    free_text: state.free_text,
  };
  const r = await api("/api/export", { method: "POST", body: JSON.stringify(payload) });
  const text = r.multi_character ? r.structured : r.flat;
  $("#export-text").textContent = text || "(空)";
  let warns = [];
  if (r.conflicts.length) warns.push(`可能冲突：${r.conflicts.join("；")}`);
  warns = warns.concat(r.warnings || []);
  $("#export-warnings").innerHTML = warns.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("");
  $("#export-output").style.display = "block";
  try { await navigator.clipboard.writeText(text); flash("已复制到剪贴板"); } catch { /* 忽略 */ }
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

// ===== Prompt 导入 =====
let inboxSeq = 0;

function countEntries(parsed) {
  let n = (parsed.base || []).length + (parsed.global_uc || []).length;
  (parsed.characters || []).forEach((c) => { n += (c.prompt || []).length + (c.uc || []).length; });
  return n;
}

function applyImported(parsed, mode, target = "base") {
  pushHistory();
  const flat = (parsed.base || []).map((e) => ({ ...e }));
  if (target !== "base") {
    const slot = getSlot(target);
    if (!slot) return;
    if (mode === "append") slot.push(...flat);
    else slot.splice(0, slot.length, ...flat);
    if (parsed.free_text) {
      state.free_text = state.free_text ? state.free_text + "\n" + parsed.free_text : parsed.free_text;
    }
    rebuildTargetSelect();
    renderCart();
    toast(`已导入 ${flat.length} 个标签`);
    return;
  }
  if (mode === "append") {
    state.base = state.base.concat(flat);
    if (parsed.free_text) state.free_text = state.free_text ? state.free_text + "\n" + parsed.free_text : parsed.free_text;
    rebuildTargetSelect();
    renderCart();
    toast(`已导入 ${flat.length} 个标签`);
    return;
  }
  state.base = flat;
  state.characters = (parsed.characters && parsed.characters.length)
    ? parsed.characters.map((c) => ({ name: c.name || "Character", prompt: c.prompt || [], uc: c.uc || [] }))
    : [{ name: "Character 1", prompt: [], uc: [] }];
  state.global_uc = parsed.global_uc || [];
  state.free_text = parsed.free_text || "";
  rebuildTargetSelect();
  renderCart();
  toast(`已导入 ${countEntries(parsed)} 个标签`);
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
  const box = $("#import-preview-box");
  box.style.display = "block";
  if (!data.segments || !data.segments.length) {
    box.innerHTML = `<div class="import-seg"><div class="imp-seg-head">无可解析的标签分段</div>` +
      (data.free_text ? `<div class="imp-free">自然语言：${esc(data.free_text)}</div>` : "") + `</div>`;
    return;
  }
  let html = `<div class="import-seg" style="color:var(--muted);font-size:12px;margin-bottom:6px;">` +
    `共 ${data.stats.total} 个标签，其中 ${data.stats.unmatched} 个未匹配（可替换或备注入库）</div>`;
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
      html += `<div class="imp-entry-line">${entryChipHtml(e)}`;
      if (e.match) {
        html += `<span class="imp-ok">✓ 匹配 ${esc(e.match.tag)}</span>`;
      } else {
        html += `<span class="imp-bad">✗ 未匹配</span>`;
        html += `<span class="imp-replace" data-si="${si}" data-ei="${ei}" title="保留原文">保留原文</span>`;
      }
      html += `</div>`;
      if (!e.match) {
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
      const si = +sel.dataset.si, ei = +sel.dataset.ei;
      const chip = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"] .imp-chip`);
      if (chip && sel.value) {
        chip.textContent = sel.value;
        chip.dataset.replaced = sel.value;
      } else if (chip) {
        const raw = importPreviewData.segments[si].entries[ei].raw;
        chip.textContent = raw; delete chip.dataset.replaced;
      }
    });
  });
}

async function applyImportedPreview() {
  if (!importPreviewData) return;
  const box = $("#import-preview-box");
  pushHistory();
  // 先处理库存储：把填了备注的未匹配 tag 存入 user_tags
  const notes = box.querySelectorAll("input.imp-note");
  for (const inp of notes) {
    const note = inp.value.trim();
    if (!note) continue;
    const si = +inp.dataset.si, ei = +inp.dataset.ei;
    const seg = importPreviewData.segments[si];
    const e = seg.entries[ei];
    const replaced = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"] select.imp-cand`);
    const tagName = replaced && replaced.value ? replaced.value : e.raw;
    try { await api("/api/user-tags", { method: "POST", body: JSON.stringify({ tag: tagName, note }) }); }
    catch { /* 忽略 */ }
  }
  // 按段分发到目标槽
  importPreviewData.segments.forEach((seg, si) => {
    const sel = box.querySelector(`select.seg-target[data-name="seg_${si}"]`);
    const target = sel ? sel.value : "base";
    if (!target || target === "__ignore__") return;
    const slot = getSlot(target);
    if (!slot) return;
    const entries = [];
    seg.entries.forEach((e, ei) => {
      const candSel = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"] select.imp-cand`);
      const noteInput = box.querySelector(`.imp-entry[data-si="${si}"][data-ei="${ei}"] input.imp-note`);
      let tag = candSel && candSel.value ? candSel.value : e.raw;
      if (noteInput && noteInput.value.trim() && !(candSel && candSel.value)) {
        // 有备注且未替换 → 保留原文
        tag = e.raw;
      }
      entries.push({ ...(e.entry || {}), tag });
    });
    slot.push(...entries);
  });
  // 自然语言自由文本
  if (importPreviewData.free_text) {
    state.free_text = state.free_text ? state.free_text + "\n" + importPreviewData.free_text : importPreviewData.free_text;
  }
  rebuildTargetSelect();
  renderCart();
  const total = importPreviewData.stats.total;
  toast(`已导入 ${total} 个标签`);
  importPreviewData = null;
  closeImportModal();
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

async function savePreset() {
  const name = prompt("Preset 名称：", `preset-${Date.now()}`);
  if (!name) return;
  await api("/api/presets", { method: "POST", body: JSON.stringify({
    name, kind: "prompt",
    payload: { model: state.model, base_prompt: state.base, characters: state.characters, global_uc: state.global_uc, free_text: state.free_text },
  }) });
  flash("Preset 已保存");
}

// ===== 搜索 / 视图切换 =====
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
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
}

function renderFavoritesView() {
  $("#browse-title").textContent = "收藏";
  renderTagCards([...state.favorites].map((t) => ({ tag: t, zh: zhMap[t] || "", post_count: 0 })));
}

function renderRecentView() {
  $("#browse-title").textContent = "最近使用";
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
$("#model-select").addEventListener("change", (e) => { state.model = e.target.value; });
$("#target-select").addEventListener("change", (e) => { state.target = e.target.value; });
$("#search-input").addEventListener("input", (e) => doSearch(e.target.value));
$("#cat-filter").addEventListener("change", () => doSearch($("#search-input").value));
$("#sort-select").addEventListener("change", (e) => { sortMode = e.target.value; if (activeCatalogId) openCatalog(activeCatalogId, 1); });
$("#back-btn").addEventListener("click", goBack);
$("#add-character").addEventListener("click", addCharacter);
$("#clear-btn").addEventListener("click", clearAll);
$("#undo-btn").addEventListener("click", undo);
$("#export-btn").addEventListener("click", doExport);
$("#save-preset").addEventListener("click", savePreset);
$("#sync-btn").addEventListener("click", runSync);
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-cancel").addEventListener("click", closeSettings);
$("#settings-save").addEventListener("click", saveUserSettings);
$("#clear-thumb-cache").addEventListener("click", clearThumbCache);
$("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettings(); });
$("#import-btn").addEventListener("click", openImportModal);
$("#import-preview").addEventListener("click", doImportPreview);
$("#import-ok").addEventListener("click", async () => {
  if (importPreviewData) await applyImportedPreview();
  else await doImportFromModal();
});
$("#import-cancel").addEventListener("click", closeImportModal);
$("#import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") closeImportModal(); });
// 图库
$("#gallery-import-btn").addEventListener("click", () => $("#gallery-file").click());
$("#gallery-file").addEventListener("change", handleGalleryUpload);
$("#gallery-refresh").addEventListener("click", loadGalleryList);
$("#gallery-del-btn").addEventListener("click", deleteGalleryDir);
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));


// ===== 图库 =====
let activeGalleryDir = null;

async function loadGalleryList() {
  try {
    const data = await api("/api/gallery");
    const el = $("#gallery-dir-list");
    if (!data.dirs.length) {
      el.innerHTML = `<div class="empty">暂无图包目录</div>`;
      $("#gallery-title").textContent = "图库";
      $("#gallery-grid").innerHTML = `<div class="empty">点击左上「导入图包」上传 zip，或选择左侧目录查看。</div>`;
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
    }
    if (activeGalleryDir) openGalleryDir(activeGalleryDir);
    else pendingScroll = null;
  } catch (e) { toast("图库加载失败：" + e.message); }
}

async function openGalleryDir(dirName) {
  activeGalleryDir = dirName;
  $("#gallery-dir-list").querySelectorAll(".gallery-dir").forEach((n) =>
    n.classList.toggle("active", n.dataset.dir === dirName)
  );
  $("#gallery-title").textContent = dirName;
  $("#gallery-del-btn").style.display = "inline-block";
  try {
    const data = await api(`/api/gallery/${encodeURIComponent(dirName)}`);
    const grid = $("#gallery-grid");
    if (!data.items.length) { grid.innerHTML = `<div class="empty">该目录暂无图片</div>`; pendingScroll = null; return; }
    grid.innerHTML = data.items.map((it) =>
      `<div class="gallery-card ${it.favorite ? "fav" : ""}" data-file="${esc(it.file_name)}">` +
      `<img src="/gallery/${encodeURIComponent(dirName)}/${encodeURIComponent(it.file_path.split("/").pop())}" loading="lazy" alt="" />` +
      `<button class="gallery-fav ${it.favorite ? "on" : ""}" title="${it.favorite ? "取消收藏" : "收藏"}">★</button>` +
      `<div class="gallery-card-prompt">${esc(it.prompt)}</div>` +
      `</div>`
    ).join("");
    if (pendingScroll != null) {
      const st = pendingScroll; pendingScroll = null;
      requestAnimationFrame(() => { grid.scrollTop = st; });
    }
    grid.querySelectorAll(".gallery-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".gallery-fav")) return;
        showGalleryPreview(dirName, card.dataset.file);
      });
      card.querySelector(".gallery-fav").addEventListener("click", (e) => {
        e.stopPropagation();
        const fav = !card.classList.contains("fav");
        toggleGalleryFav(dirName, card.dataset.file, fav);
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
      `<div class="gallery-preview-prompt">${esc(it.prompt)}</div>` +
      `<div class="gallery-preview-actions">` +
      `<button class="primary" id="gallery-copy-btn">复制提示词</button>` +
      `<button class="ghost" id="gallery-fav-btn">${it.favorite ? "取消收藏 ★" : "收藏 ☆"}</button>` +
      `</div>`;
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
  if (!confirm(`确定删除图库目录「${activeGalleryDir}」？项目副本和索引都会被删除。`)) return;
  try {
    await fetch(`/api/gallery/${encodeURIComponent(activeGalleryDir)}`, { method: "DELETE" });
    activeGalleryDir = null;
    $("#gallery-preview-body").innerHTML = `<div class="empty">点击图片查看大图与提示词</div>`;
    await loadGalleryList();
    toast("已删除");
  } catch (e) { toast("删除失败：" + e.message); }
}

// ===== NovelAI 生图（三栏工作台，联动 8787 服务） =====
const NAI_SERVER = (localStorage.getItem("nai_server") || "http://127.0.0.1:8787").replace(/\/+$/, "");
let naiSSEOpened = false;
let naiPhase = "ready";        // ready|submitting|generating|retrieving|saving|complete|error|cancelled
let naiImages = [];            // Python 图库 nai_generated 图片列表
let naiIdx = -1;               // viewer 当前索引
let naiZoom = 1;               // 1 = Fit，其他为缩放倍数
let naiBatchRunning = false;

function naiSetJob(text, cls) {
  const b = $("#nai-job");
  b.textContent = text;
  b.className = "nai-job" + (cls ? " " + cls : "");
}

function naiSetPhase(phase, msg) {
  naiPhase = phase;
  const btn = $("#nai-gen");
  const job = $("#nai-job");
  const old = job.querySelector(".nai-progress");
  if (old) old.remove();
  btn.disabled = false;
  btn.onclick = () => { if (naiPhase === "generating") naiCancel(); else naiGenerate(); };
  switch (phase) {
    case "ready": btn.textContent = "✦ Generate"; naiSetJob("Ready"); break;
    case "submitting": btn.textContent = "Submitting…"; btn.disabled = true; naiSetJob("Submitting…"); job.insertAdjacentHTML("beforeend", '<div class="nai-progress"></div>'); break;
    case "generating": btn.textContent = "● Generating…"; naiSetJob("Generating with NovelAI…"); job.insertAdjacentHTML("beforeend", '<div class="nai-progress"></div>'); break;
    case "retrieving": btn.textContent = "● Retrieving…"; btn.disabled = true; naiSetJob("Retrieving image…"); break;
    case "saving": btn.textContent = "● Saving…"; btn.disabled = true; naiSetJob("Saving to library…"); break;
    case "complete": btn.textContent = "✦ Generate"; naiSetJob("✓ Saved to library", "ok"); break;
    case "error": btn.textContent = "✦ Generate"; naiSetJob("✗ " + (msg || "生成失败"), "err"); break;
    case "cancelled": btn.textContent = "✦ Generate"; naiSetJob("已取消", "err"); break;
  }
}

function initGenerateView() {
  loadNaiGallery();
  loadPresets();
  if (!naiSSEOpened) { naiSSEOpened = true; naiSSE(); }
}

async function naiGenerate() {
  const prompt = $("#nai-prompt").value;
  if (!prompt.trim()) { toast("提示词为空"); return; }
  const parameters = {};
  const m = $("#nai-model").value, r = $("#nai-resolution").value, s = $("#nai-seed").value.trim();
  const st = $("#nai-steps").value.trim(), g = $("#nai-guidance").value.trim();
  if (m) parameters.model = m;
  if (r) parameters.resolution = r;
  if (s) parameters.seed = s;
  if (st) parameters.steps = st;
  if (g) parameters.guidance = g;
  updateAdvSummary(parameters);
  naiSetPhase("submitting");
  try {
    const res = await fetch(`${NAI_SERVER}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, negative_prompt: $("#nai-neg").value, parameters: Object.keys(parameters).length ? parameters : null }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "生成失败");
  } catch (e) {
    naiSetPhase("error", e.message);
  }
}

async function naiCancel() {
  try { await fetch(`${NAI_SERVER}/api/cancel`, { method: "POST" }); toast("已发送取消"); }
  catch (e) { toast("取消失败：" + e.message); }
}

function naiSSE() {
  const es = new EventSource(`${NAI_SERVER}/events`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "job.update") {
      switch (e.state) {
        case "submitted": naiSetPhase("submitting"); break;
        case "generating": naiSetPhase("generating"); break;
        case "captured": naiSetPhase("retrieving"); break;
        case "persisted": naiSetPhase("saving"); break;
        case "succeeded":
          naiSetPhase("complete");
          setTimeout(() => naiSetPhase("ready"), 1500);
          loadNaiGallery();
          loadGalleryList();
          break;
        case "failed": naiSetPhase("error", e.error || "生成失败"); break;
        case "timeout": naiSetPhase("error", "生成超时"); break;
        case "cancelled": naiSetPhase("cancelled"); setTimeout(() => naiSetPhase("ready"), 800); break;
      }
    }
    if (e.type === "batch.update") renderBatchStatus(e);
  };
  es.onerror = () => { /* 联动服务断线：状态由生成请求报错体现 */ };
}

async function naiFillFromCart() {
  try {
    const payload = { model: state.model, base_prompt: state.base, characters: state.characters, global_uc: state.global_uc, free_text: state.free_text };
    const r = await api("/api/export", { method: "POST", body: JSON.stringify(payload) });
    const text = r.multi_character ? r.structured : r.flat;
    if (text && text.trim()) { $("#nai-prompt").value = text; toast("已填入购物车提示词"); }
    else toast("购物车为空");
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
  meta.textContent = it.prompt || "";
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
  if (p.steps) parts.push(`Steps ${p.steps}`);
  if (p.guidance) parts.push(`Guidance ${p.guidance}`);
  $("#nai-adv-summary").textContent = parts.length ? parts.join(" · ") : "Uses NovelAI defaults";
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

// 复用设置：把当前图的提示词 + 参数恢复到左侧面板，便于再生成
function naiReuse() {
  const it = naiImages[naiIdx];
  if (!it) { toast("没有可复用的图片"); return; }
  $("#nai-prompt").value = it.prompt || "";
  $("#nai-neg").value = it.negative_prompt || "";
  const p = it.parameters || {};
  $("#nai-model").value = p.model || "";
  $("#nai-resolution").value = p.resolution || "";
  $("#nai-seed").value = p.seed != null ? String(p.seed) : "";
  $("#nai-steps").value = p.steps != null ? String(p.steps) : "";
  $("#nai-guidance").value = p.guidance != null ? String(p.guidance) : "";
  updateAdvSummary(p);
  toast("已复用此图设置");
}

// ---- 预设与批量 ----
async function loadPresets() {
  try {
    const r = await fetch(`${NAI_SERVER}/api/presets`);
    const j = await r.json();
    renderPresets(j.presets || []);
  } catch { /* 联动服务未连接 */ }
}

function renderPresets(presets) {
  const el = $("#nai-preset-list");
  if (!presets.length) { el.innerHTML = `<div class="empty">暂无预设</div>`; return; }
  el.innerHTML = presets.map((p) =>
    `<div class="nai-preset-item">` +
    `<input type="checkbox" data-id="${p.id}" />` +
    `<span class="np-name" title="${esc(p.name)}">${esc(p.name)}</span>` +
    `<span class="np-prompt" title="${esc(p.prompt)}">${esc(p.prompt)}</span>` +
    `<button class="np-del" data-id="${p.id}" title="删除">✕</button>` +
    `</div>`
  ).join("");
  el.querySelectorAll(".np-del").forEach((b) => b.addEventListener("click", async () => {
    await fetch(`${NAI_SERVER}/api/presets/${b.dataset.id}`, { method: "DELETE" });
    loadPresets();
  }));
}

async function savePreset() {
  const name = $("#nai-preset-name").value.trim();
  const prompt = $("#nai-prompt").value.trim();
  if (!name) { toast("请填写预设名称"); return; }
  if (!prompt) { toast("提示词为空"); return; }
  const r = await fetch(`${NAI_SERVER}/api/presets`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, prompt, negative_prompt: $("#nai-neg").value }),
  });
  const j = await r.json();
  if (j.ok) { toast("预设已保存"); $("#nai-preset-name").value = ""; loadPresets(); }
  else toast("保存失败：" + (j.error || ""));
}

async function batchRun() {
  const ids = [...document.querySelectorAll("#nai-preset-list input[type=checkbox]:checked")].map((c) => c.dataset.id);
  if (!ids.length) { toast("请先勾选预设"); return; }
  $("#nai-batch-run").disabled = true;
  $("#nai-batch-cancel").disabled = false;
  naiBatchRunning = true;
  try {
    const r = await fetch(`${NAI_SERVER}/api/batch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "batch", items: ids.map((id) => ({ presetId: id })), intervalMs: 3000 }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "批次启动失败");
    renderBatchStatus({ status: "running", done: 0, total: j.total || ids.length, succeeded: 0, failed: 0 });
  } catch (e) {
    $("#nai-batch-run").disabled = false;
    $("#nai-batch-cancel").disabled = true;
    naiBatchRunning = false;
    toast("批次失败：" + e.message);
  }
}

function renderBatchStatus(e) {
  const el = $("#nai-batch-status");
  if (e.status === "running") {
    el.className = "nai-job";
    el.textContent = `批次进行中：${e.done}/${e.total} · 成功 ${e.succeeded} · 失败 ${e.failed}${e.current ? " · " + e.current : ""}`;
  } else {
    el.className = "nai-job" + (e.status === "succeeded" ? " ok" : " err");
    el.textContent = `批次${e.status === "succeeded" ? "完成" : e.status === "cancelled" ? "已取消" : "结束"}：${e.done}/${e.total} · 成功 ${e.succeeded} · 失败 ${e.failed}`;
    $("#nai-batch-run").disabled = false;
    $("#nai-batch-cancel").disabled = true;
    naiBatchRunning = false;
    loadNaiGallery();
  }
}

async function batchCancel() {
  try { await fetch(`${NAI_SERVER}/api/batch/cancel`, { method: "POST" }); toast("已发送批次取消"); }
  catch (e) { toast("取消失败：" + e.message); }
}

// ---- 生图视图事件绑定 ----
$("#nai-gen").addEventListener("click", () => { if (naiPhase === "generating") naiCancel(); else naiGenerate(); });
$("#nai-fill-cart").addEventListener("click", naiFillFromCart);
$("#nai-seed-random").addEventListener("click", () => { $("#nai-seed").value = Math.floor(Math.random() * 2147483647); });
$("#nai-zoom-in").addEventListener("click", () => { naiZoom = Math.min(4, naiZoom + 0.5); applyZoom(); });
$("#nai-zoom-out").addEventListener("click", () => { naiZoom = Math.max(1, naiZoom - 0.5); applyZoom(); });
$("#nai-zoom-fit").addEventListener("click", () => { naiZoom = 1; applyZoom(); });
$("#nai-pin").addEventListener("click", naiPin);
$("#nai-reuse").addEventListener("click", naiReuse);
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
$("#nai-preset-save").addEventListener("click", savePreset);
$("#nai-batch-run").addEventListener("click", batchRun);
$("#nai-batch-cancel").addEventListener("click", batchCancel);
$("#nai-history-refresh").addEventListener("click", loadNaiGallery);


init();
pollInbox(true);
setInterval(() => pollInbox(false), 1200);
