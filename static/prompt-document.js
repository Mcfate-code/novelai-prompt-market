/**
 * PromptDocument schema_version=2 pure data contract.
 * No DOM, storage, or application state is referenced here.
 */
const SECTION_IDS = ["character", "appearance", "clothing", "expression", "action", "composition", "scene", "style", "quality", "other"];
const TARGET_RE = /^char:(\d+)(:uc)?$/;
import { splitPromptTokens, parsePromptToken, serializePromptToken } from "./prompt-tokenizer.js";

function emptySections() { return Object.fromEntries(SECTION_IDS.map((id) => [id, []])); }
function idFor(raw, section, extra = {}) { return String(raw.id || extra.id || `tag-${section}-${raw.sort_order ?? extra.sort_order ?? 0}-${String(raw.tag ?? raw.raw ?? "").trim()}`); }
function normalizeEntry(value, section = "other", extra = {}) {
  const raw = typeof value === "string" ? { tag: value } : (value || {});
  const weight = Number(raw.weight != null ? raw.weight : raw.strength != null ? raw.strength : 1);
  const relation = ["source", "target", "mutual"].includes(raw.relation) ? raw.relation : null;
  const brackets = Number.isFinite(Number(raw.brackets)) ? Number(raw.brackets) : 0;
  return {
    id: idFor(raw, section, extra), tag: String(raw.tag ?? raw.raw ?? "").trim(),
    weight: Number.isFinite(weight) ? weight : 1,
    section: SECTION_IDS.includes(raw.section) ? raw.section : (SECTION_IDS.includes(section) ? section : "other"),
    custom: !!raw.custom, source: raw.source || extra.source || "tag",
    bundle_id: raw.bundle_id ?? extra.bundle_id ?? null, bundle_name: raw.bundle_name ?? extra.bundle_name ?? null,
    provenance: raw.provenance ?? extra.provenance ?? null, interaction_id: raw.interaction_id ?? extra.interaction_id ?? null,
    variation_id: raw.variation_id ?? extra.variation_id ?? null,
    pose_fingerprint: raw.pose_fingerprint ?? extra.pose_fingerprint ?? null,
    pose_role: raw.pose_role ?? extra.pose_role ?? null,
    sort_order: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : Number(extra.sort_order ?? 0),
    relation, brackets,
  };
}
function normalizeSections(source) {
  const out = emptySections();
  if (Array.isArray(source)) return sectionsFromList(source);
  if (!source || typeof source !== "object") return out;
  SECTION_IDS.forEach((section) => {
    if (Array.isArray(source[section])) out[section] = source[section].map((e, i) => normalizeEntry(e, section, { sort_order: i })).filter((e) => e.tag);
  });
  return out;
}
function enabledValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "off", "no"].includes(String(value).trim().toLocaleLowerCase());
}
function normalizeCharacter(raw, index) {
  const ch = raw || {};
  const prompt = ch.prompt_sections || ch.prompt || {};
  const uc = ch.uc_sections || ch.uc || {};
  return { name: String(ch.name || `Character ${index + 1}`), prompt_sections: Array.isArray(prompt) ? sectionsFromList(prompt) : normalizeSections(prompt), uc_sections: Array.isArray(uc) ? sectionsFromList(uc) : normalizeSections(uc), position: ch.position || null, enabled: enabledValue(ch.enabled, true) };
}
function sectionsFromList(list) {
  const out = emptySections();
  list.forEach((e, i) => { const section = SECTION_IDS.includes(e?.section) ? e.section : "other"; out[section].push(normalizeEntry(e, section, { sort_order: i })); });
  return out;
}
function normalize(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const v2 = value.schema_version === 2;
  const baseSource = value.sections ?? value.base ?? value.base_prompt ?? [];
  const base = Array.isArray(baseSource) ? sectionsFromList(baseSource) : normalizeSections(baseSource);
  const chars = Array.isArray(value.characters) && value.characters.length ? value.characters.map(normalizeCharacter) : [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections(), position: null, enabled: true }];
  const globalSource = value.global_uc_sections ?? value.global_uc ?? [];
  const global = Array.isArray(globalSource) ? sectionsFromList(globalSource) : normalizeSections(globalSource);
  const freeText = typeof value.free_text === "string" ? value.free_text : "";
  const freeTextEn = typeof value.free_text_en === "string" ? value.free_text_en : "";
  const assistantContext = value.assistant_context && typeof value.assistant_context === "object" ? value.assistant_context : {};
  return { schema_version: 2, sections: base, characters: chars, global_uc_sections: global, free_text: freeText, free_text_en: freeTextEn, use_free_text_en: value.use_free_text_en === true && (v2 || !!freeTextEn), assistant_context: assistantContext };
}
function createEmpty() { return normalize({ schema_version: 2, sections: emptySections(), characters: [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections(), enabled: true }], global_uc_sections: emptySections(), assistant_context: {} }); }
function getSections(document, target) {
  const doc = document;
  if (target === "base") return doc.sections;
  if (target === "global_uc") return doc.global_uc_sections;
  const match = String(target || "").match(TARGET_RE);
  if (!match || !doc.characters[Number(match[1])]) return null;
  return match[2] ? doc.characters[Number(match[1])].uc_sections : doc.characters[Number(match[1])].prompt_sections;
}
function getTargetSections(document, target) { return getSections(document, target); }
function getTargetEntries(document, target) {
  const sections = getSections(normalize(document), target);
  return sections ? SECTION_IDS.flatMap((id) => sections[id].map((entry) => ({ ...entry, section: id }))) : [];
}
/**
 * 推荐上下文的正向标签（target-local）。规则：
 *   base            -> Base positive 仅
 *   char:N          -> Base positive + Character N positive
 *   global_uc       -> 无正向推荐（返回 []）
 *   char:N:uc       -> 无正向推荐（返回 []）
 */
function recommendationContextTags(document, target) {
  const doc = normalize(document);
  const t = String(target || "").trim();
  if (t === "global_uc" || /:uc$/.test(t)) return [];
  const seen = new Set();
  const out = [];
  const push = (entry) => {
    const tag = String(entry?.tag ?? "").trim();
    if (!tag) return;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  for (const entry of getTargetEntries(doc, "base")) push(entry);
  const m = String(t).match(TARGET_RE);
  if (m && !m[2]) {
    for (const entry of getTargetEntries(doc, `char:${m[1]}`)) push(entry);
  }
  return out;
}

/**
 * 当前 target 已选标签集合（target-local，用于推荐去重）。
 * 只排除当前 target 自身已有的 tag，不跨界污染其他角色。
 */
function selectedTagKeysForTarget(document, target) {
  const doc = normalize(document);
  const t = String(target || "").trim();
  const keys = new Set();
  for (const entry of getTargetEntries(doc, t)) {
    const tag = String(entry?.tag ?? "").trim();
    if (tag) keys.add(tag.toLocaleLowerCase());
  }
  return keys;
}
function weightText(entry) { return serializePromptToken(entry); }
function serializeTarget(document, target) { return getTargetEntries(document, target).filter((e) => e.tag).map(weightText).join(", "); }
function knownMap(knownTags) {
  if (knownTags instanceof Map) return knownTags;
  const map = new Map();
  if (Array.isArray(knownTags)) knownTags.forEach((tag) => map.set(String(typeof tag === "string" ? tag : tag.tag).toLocaleLowerCase(), typeof tag === "string" ? tag : tag.tag));
  else Object.entries(knownTags || {}).forEach(([key, value]) => map.set(String(key).toLocaleLowerCase(), String(value)));
  return map;
}
function parseTargetText(text, knownTags = new Map()) {
  const known = knownMap(knownTags);
  return splitPromptTokens(text).map((token) => {
    const parsed = parsePromptToken(token);
    if (!parsed.tag) return null;
    const canonical = known.get(parsed.tag.toLocaleLowerCase());
    // 只丢弃真正的尖括号噪声 token；{} / [] 强调与关系前缀 token 永不静默清除。
    if (!canonical && !parsed.weighted && !parsed.relation && parsed.brackets === 0 && /[<>]/.test(parsed.tag)) return null;
    return { tag: canonical || parsed.tag, weight: parsed.weight, weighted: parsed.weighted, relation: parsed.relation, brackets: parsed.brackets };
  }).filter(Boolean);
}
function replaceSections(sections, entries) {
  const out = emptySections();
  entries.forEach((entry, i) => { const section = SECTION_IDS.includes(entry.section) ? entry.section : "other"; out[section].push(normalizeEntry(entry, section, { sort_order: i })); });
  return out;
}
function reconcileTargetText(document, target, text, knownTags = new Map()) {
  const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc;
  const current = getTargetEntries(doc, target); const parsed = parseTargetText(text, knownTags);
  const byTag = new Map(current.map((entry) => [entry.tag.toLocaleLowerCase(), entry]));
  const known = knownMap(knownTags);
  const entries = parsed.map((item, index) => {
    const existing = byTag.get(item.tag.toLocaleLowerCase());
    return { ...(existing || {}), tag: item.tag, weight: item.weight, custom: existing?.custom ?? !known.has(item.tag.toLocaleLowerCase()), source: existing?.source || (known.has(item.tag.toLocaleLowerCase()) ? "tag" : "raw"), sort_order: index, relation: item.relation, brackets: item.brackets };
  });
  if (target === "base") doc.sections = replaceSections(sections, entries);
  else if (target === "global_uc") doc.global_uc_sections = replaceSections(sections, entries);
  else { const m = String(target).match(TARGET_RE); doc.characters[Number(m[1])][m[2] ? "uc_sections" : "prompt_sections"] = replaceSections(sections, entries); }
  return doc;
}
function updateEntry(document, target, entryId, patch) {
  const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc;
  let found = null;
  SECTION_IDS.forEach((id) => { sections[id].forEach((entry) => { if (entry.id === entryId) found = { ...entry, ...patch }; }); });
  if (!found) return doc;
  SECTION_IDS.forEach((id) => { sections[id] = sections[id].filter((entry) => entry.id !== entryId); });
  const next = normalizeEntry(found, found.section || "other");
  sections[next.section].push(next);
  return doc;
}
function addTag(document, target, value, section = "other", extra = {}) { const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc; const entry = normalizeEntry(value, section, extra); sections[entry.section].push(entry); return doc; }
function replaceSlotTag(document, target, value, section = "other", replaceTags = []) {
  const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc;
  const keys = new Set((Array.isArray(replaceTags) ? replaceTags : []).map((tag) => String(tag).trim().toLocaleLowerCase()).filter(Boolean));
  if (keys.size) SECTION_IDS.forEach((id) => { sections[id] = (sections[id] || []).filter((entry) => !keys.has(String(entry.tag || "").toLocaleLowerCase())); });
  return addTag(doc, target, value, section, { source: "slot_replace" });
}
function removeTag(document, target, entryId) { const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc; SECTION_IDS.forEach((id) => { sections[id] = sections[id].filter((e) => e.id !== entryId); }); return doc; }
function characterHasContent(character, index) {
  if (!character || typeof character !== "object") return false;
  if (character.position) return true;
  return [character.prompt_sections, character.uc_sections].some((sections) => getSectionEntries(sections).some((entry) => String(entry.tag || "").trim()));
}
function getSectionEntries(sections) {
  if (!sections || typeof sections !== "object") return [];
  return SECTION_IDS.flatMap((id) => Array.isArray(sections[id]) ? sections[id] : []);
}
function addCharacter(document, character = {}) {
  const doc = normalize(document);
  // V4/V4.5 的本地 UI 先支持 6 个角色；V5 没有项目层面的固定上限。
  if (doc.characters.length >= 6) return doc;
  doc.characters.push(normalizeCharacter(character, doc.characters.length));
  return doc;
}
function removeCharacter(document, index) {
  const doc = normalize(document); const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= doc.characters.length) return doc;
  doc.characters.splice(idx, 1);
  if (!doc.characters.length) doc.characters.push(normalizeCharacter({}, 0));
  // 删除任意角色后，场景上下文中的按角色索引数据也必须跟着移动，避免
  // Character 2 的服装/状态/互动残留到新的 Character 1。
  const remapIndexMap = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const next = {};
    Object.entries(value).forEach(([key, item]) => {
      const n = Number(key);
      if (!Number.isInteger(n)) next[key] = item;
      else if (n < idx) next[n] = item;
      else if (n > idx) next[n - 1] = item;
    });
    return next;
  };
  const ctx = { ...(doc.assistant_context || {}) };
  ["clothing_state", "character_state", "expressions"].forEach((key) => { if (ctx[key]) ctx[key] = remapIndexMap(ctx[key]); });
  const removedInteractionIds = new Set();
  if (Array.isArray(ctx.interactions)) {
    ctx.interactions.forEach((row) => { if (Number(row?.actor) === idx || Number(row?.target) === idx) removedInteractionIds.add(String(row.id)); });
    ctx.interactions = ctx.interactions
      .filter((row) => Number(row?.actor) !== idx && Number(row?.target) !== idx)
      .map((row) => ({ ...row, actor: Number(row.actor) > idx ? Number(row.actor) - 1 : Number(row.actor), target: Number(row.target) > idx ? Number(row.target) - 1 : Number(row.target) }));
  }
  if (removedInteractionIds.size) {
    doc.characters.forEach((character) => SECTION_IDS.forEach((section) => {
      character.prompt_sections[section] = (character.prompt_sections[section] || []).filter((entry) => !removedInteractionIds.has(String(entry.interaction_id || "")));
    }));
  }
  ctx.participant_count = doc.characters.length;
  doc.assistant_context = ctx;
  return doc;
}
function renameCharacter(document, index, name) { const doc = normalize(document); if (doc.characters[Number(index)]) doc.characters[Number(index)].name = String(name || `Character ${Number(index) + 1}`); return doc; }
function setCharacterEnabled(document, index, enabled) { const doc = normalize(document); if (doc.characters[Number(index)]) doc.characters[Number(index)].enabled = enabledValue(enabled, true); return doc; }
function moveCharacter(document, fromIndex, toIndex) {
  const doc = normalize(document); const from = Number(fromIndex); const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= doc.characters.length || to >= doc.characters.length) return doc;
  const [character] = doc.characters.splice(from, 1); doc.characters.splice(to, 0, character); return doc;
}
function setCharacterPosition(document, index, position) {
  const doc = normalize(document); const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || !doc.characters[idx]) return doc;
  doc.characters[idx].position = position == null ? null : { x: Number(position.x), y: Number(position.y) };
  return doc;
}

function getAssistantContext(document) { return (normalize(document).assistant_context) || {}; }
function setAssistantContext(document, context = {}) {
  const doc = normalize(document);
  const next = { ...(doc.assistant_context || {}) };
  if (context && typeof context === "object") {
    for (const [key, value] of Object.entries(context)) {
      if (value == null) delete next[key]; else next[key] = value;
    }
  }
  doc.assistant_context = next;
  return doc;
}

function syncSceneParticipants(document, count, { removeIndices = [], addCharacters = [] } = {}) {
  const doc = normalize(document); const requested = Number(count);
  if (!Number.isInteger(requested) || requested < 1 || requested > 6) return { document: doc, ok: false, blockedIndices: [] };
  const blockedIndices = [];
  if (requested < doc.characters.length) {
    for (let i = requested; i < doc.characters.length; i++) if (characterHasContent(doc.characters[i], i)) blockedIndices.push(i);
    if (blockedIndices.length) return { document: doc, ok: false, blockedIndices };
    doc.characters = doc.characters.slice(0, requested);
  }
  while (doc.characters.length < requested) {
    const supplied = Array.isArray(addCharacters) ? addCharacters[doc.characters.length] || {} : {};
    doc.characters.push(normalizeCharacter(supplied, doc.characters.length));
  }
  const ctx = { ...(doc.assistant_context || {}), participant_count: requested };
  doc.assistant_context = ctx;
  return { document: doc, ok: true, blockedIndices: [] };
}

// 这些词在旧快照 / 外部导入中经常被错误放进 Base。它们描述的是角色
// 的身体姿势或状态，不是镜头构图；恢复 / 换姿势时应迁移到角色卡。
const CHARACTER_POSE_STATE_TAGS = new Set([
  "missionary", "missionary position", "lying on back", "doggystyle", "on all fours",
  "girl on top", "cowgirl position", "reverse cowgirl position", "spooning", "on side",
  "standing", "standing sex", "standing missionary", "mating press", "knees to chest",
  "prone bone", "lying on stomach", "upright straddle", "sitting", "legs up", "kneeling",
  "69", "upright 69", "masturbation", "vaginal sex", "anal sex", "fellatio", "cunnilingus",
]);
const CHARACTER_STATE_TAG_SECTIONS = new Map([
  ["nude", "clothing"], ["clothed", "clothing"], ["partially clothed", "clothing"],
  ["lingerie", "clothing"], ["see-through clothes", "clothing"],
  ["blush", "expression"], ["tears", "expression"], ["smile", "expression"],
  ["ahegao", "expression"], ["sweat", "appearance"],
]);

function characterTargetsForEntry(document, entry) {
  const characters = document.characters || [];
  const row = (document.assistant_context?.interactions || []).find((item) => String(item?.id || "") === String(entry?.interaction_id || ""));
  if (!row) return characters.map((_, index) => index);
  if (entry.relation === "source") return Number.isInteger(Number(row.actor)) ? [Number(row.actor)] : characters.map((_, index) => index);
  if (entry.relation === "target") return Number.isInteger(Number(row.target)) ? [Number(row.target)] : characters.map((_, index) => index);
  if (entry.relation === "mutual") return [Number(row.actor), Number(row.target)].filter((index, position, list) => Number.isInteger(index) && index >= 0 && index < characters.length && list.indexOf(index) === position);
  return characters.map((_, index) => index);
}

/**
 * 将旧的 Base 姿势 / 状态条目迁移到角色卡。
 *
 * 只移动 action、expression，以及已知的姿势 / 角色状态词；scene / composition
 * 中的纯镜头词（full body、from above 等）保持在 Base。旧生成姿势也会先迁移，
 * 再由换姿势流程清理，确保恢复后的文档不会再次出现 Base 姿势。
 */
function moveBasePoseStateToCharacters(document) {
  const doc = document;
  const moved = [];
  for (const section of SECTION_IDS) {
    const entries = doc.sections[section] || [];
    const keep = [];
    for (const entry of entries) {
      const tag = String(entry?.tag || "").trim();
      const key = tag.toLocaleLowerCase();
      const shouldMove = section === "action" || section === "expression" || CHARACTER_POSE_STATE_TAGS.has(key) || CHARACTER_STATE_TAG_SECTIONS.has(key);
      if (!shouldMove) {
        keep.push(entry);
        continue;
      }
      const targetSection = CHARACTER_STATE_TAG_SECTIONS.get(key) || (section === "expression" ? "expression" : "action");
      const targets = characterTargetsForEntry(doc, entry);
      targets.forEach((index) => {
        const character = doc.characters[index];
        if (!character) return;
        const targetEntries = character.prompt_sections[targetSection] || (character.prompt_sections[targetSection] = []);
        if (targetEntries.some((existing) => String(existing?.tag || "").trim().toLocaleLowerCase() === key)) return;
        targetEntries.push(normalizeEntry({
          ...entry,
          id: `${entry.id || "base-entry"}:char:${index}`,
          section: targetSection,
          source: entry.source === "pose_variation" ? "pose_variation_migrated" : "base_auto_classified",
          provenance: entry.provenance || "base_auto_classified",
          pose_role: index,
        }, targetSection));
        moved.push({ tag, index, targetSection });
      });
    }
    doc.sections[section] = keep;
  }
  return moved;
}

// 对外提供给恢复 / 导入入口的幂等迁移：已经在角色卡中的条目不会重复添加。
function migrateBasePoseState(document) {
  const doc = normalize(document);
  moveBasePoseStateToCharacters(doc);
  return doc;
}

/**
 * 原子应用一个姿势计划。
 *
 * 姿势是“可替换槽位”，不是普通 ADD_TAG：清理上一次由工作台生成的
 * pose_variation 条目和关系，再把姿势 / 状态写入各角色卡；只有镜头构图
 * 词留在 Base。这样一次点击只有一个 undo 边界，也不会把旧姿势叠加到新姿势上。
 */
function applyPoseVariation(document, payload = {}) {
  const doc = normalize(document);
  const plan = payload.plan && typeof payload.plan === "object" ? payload.plan : payload;
  const variationId = String(plan.variation_id || plan.id || `pose-${Date.now()}`);
  const fingerprint = String(plan.fingerprint || plan.pose_fingerprint || variationId);
  const replaceTags = new Set((Array.isArray(payload.replaceTags) ? payload.replaceTags : []).map((tag) => String(tag).trim().toLocaleLowerCase()).filter(Boolean));
  // 旧版本 / 外部导入的 Base 动作先归档到角色卡，再清理上一轮生成的姿势。
  // 否则 replaceTags 会先把用户原有的 Base 姿势直接删掉。
  moveBasePoseStateToCharacters(doc);
  const isOldPose = (entry) => entry?.source === "pose_variation" || entry?.source === "pose_variation_migrated" || replaceTags.has(String(entry?.tag || "").toLocaleLowerCase());
  for (const sections of [doc.sections, ...doc.characters.flatMap((character) => [character.prompt_sections])]) {
    for (const section of SECTION_IDS) sections[section] = (sections[section] || []).filter((entry) => !isOldPose(entry));
  }
  const add = (target, tag, section = "action", extra = {}) => {
    const value = String(tag || "").trim();
    if (!value) return;
    const sections = getSections(doc, target);
    if (!sections) return;
    const safeSection = SECTION_IDS.includes(section) ? section : "action";
    if (sections[safeSection].some((entry) => String(entry?.tag || "").trim().toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    sections[safeSection].push(normalizeEntry({ tag: value, section: safeSection, source: "pose_variation", variation_id: variationId, pose_fingerprint: fingerprint, ...extra }, safeSection));
  };
  const roleTags = Array.isArray(plan.roleTags) ? plan.roleTags : [];
  const cameraTags = new Set((Array.isArray(plan.cameraTags) ? plan.cameraTags : (Array.isArray(plan.camera) ? plan.camera : [])).map((tag) => String(tag).trim().toLocaleLowerCase()).filter(Boolean));
  const poseAndCameraTags = [...new Set([...(Array.isArray(plan.baseTags) ? plan.baseTags : []), ...(Array.isArray(plan.cameraTags) ? plan.cameraTags : []), ...(Array.isArray(plan.camera) ? plan.camera : [])].map((tag) => String(tag).trim()).filter(Boolean))];
  for (const tag of poseAndCameraTags) {
    const key = String(tag).trim().toLocaleLowerCase();
    if (cameraTags.has(key)) {
      add("base", tag, plan.baseSection || "composition");
      continue;
    }
    // 没有显式 roleTags 的自定义计划：姿势词至少要进入每个角色卡，
    // 否则多角色生成会再次退回错误的 Base 共享提示词。
    const explicit = roleTags.some((tags) => Array.isArray(tags) && tags.length);
    let targets = explicit
      ? roleTags.map((tags, index) => ({ tags, index })).filter(({ tags }) => Array.isArray(tags) && tags.some((value) => String(value).trim().toLocaleLowerCase() === key))
      : doc.characters.map((_, index) => ({ index }));
    if (explicit && !targets.length) targets = doc.characters.map((_, index) => ({ index }));
    targets.forEach(({ index }) => add(`char:${index}`, tag, "action", { pose_role: index }));
  }
  roleTags.forEach((tags, index) => (Array.isArray(tags) ? tags : []).forEach((tag) => add(`char:${index}`, tag, "action", { pose_role: index })));

  const previousInteractions = Array.isArray(doc.assistant_context?.interactions) ? doc.assistant_context.interactions : [];
  const interactions = previousInteractions.filter((row) => row && row.source !== "pose_variation");
  for (const row of Array.isArray(plan.relations) ? plan.relations : []) {
    const source = Number(row.source); const target = Number(row.target);
    if (!Number.isInteger(source) || !Number.isInteger(target) || source < 0 || target < 0 || source >= doc.characters.length || target >= doc.characters.length || source === target) continue;
    const id = `${variationId}-${source}-${target}`;
    const action = String(row.action || "").trim();
    const relation = row.relation === "mutual" ? "mutual" : "directional";
    interactions.push({ id, actor: source, target, action, relation, source: "pose_variation", variation_id: variationId, pose_fingerprint: fingerprint });
    // `sex` 是姿势计划的内部互动类型，不是角色自身的可生成标签。
    // 关系仍保存在 assistant_context.interactions，避免把它泄漏为
    // `source#sex` / `target#sex` 填入每个角色 Prompt；具体姿势由角色卡的
    // plan.roleTags / plan.baseTags（非 cameraTags）提供。其他显式动作仍保留
    // 关系前缀，兼容自定义计划。
    if (action && action.toLocaleLowerCase() !== "sex") {
      add(`char:${source}`, action, "action", { relation: relation === "mutual" ? "mutual" : "source", interaction_id: id });
      if (relation === "mutual") add(`char:${target}`, action, "action", { relation: "mutual", interaction_id: id });
      else add(`char:${target}`, action, "action", { relation: "target", interaction_id: id });
    }
  }
  const priorHistory = Array.isArray(doc.assistant_context?.pose_history) ? doc.assistant_context.pose_history : [];
  const poseHistory = [fingerprint, ...priorHistory.filter((value) => String(value) !== fingerprint)].slice(0, 12);
  const ctx = { ...(doc.assistant_context || {}), interactions, pose_history: poseHistory, pose_variation: {
    id: variationId, fingerprint, label: String(plan.label || ""), participant_count: Number(plan.participantCount || doc.characters.length), adult_only: plan.adultOnly !== false,
  } };
  if (Array.isArray(plan.positions)) {
    plan.positions.forEach((position, index) => { if (doc.characters[index] && position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))) doc.characters[index].position = { x: Number(position.x), y: Number(position.y) }; });
  }
  doc.assistant_context = ctx;
  return doc;
}

function applyInteraction(document, interaction = {}) {
  const doc = normalize(document); const actor = Number(interaction.actor); const target = Number(interaction.target);
  const action = String(interaction.action || "").trim(); const relation = interaction.relation === "mutual" ? "mutual" : "directional";
  if (!Number.isInteger(actor) || !Number.isInteger(target) || actor < 0 || target < 0 || actor >= doc.characters.length || target >= doc.characters.length || !action || actor === target) return doc;
  const ctx = { ...(doc.assistant_context || {}) }; const rows = Array.isArray(ctx.interactions) ? ctx.interactions.filter((row) => row && row.id !== interaction.id) : [];
  const id = String(interaction.id || `interaction-${Date.now()}-${rows.length}`); rows.push({ id, actor, action, target, relation });
  const add = (idx, rel) => { doc.characters[idx].prompt_sections.action.push(normalizeEntry({ tag: action, weight: 1, relation: rel, source: "scene_interaction", bundle_name: "scene-composer-v2", provenance: "scene-composer-v2", interaction_id: id }, "action")); };
  if (relation === "mutual") { add(actor, "mutual"); add(target, "mutual"); } else { add(actor, "source"); add(target, "target"); }
  ctx.interactions = rows; doc.assistant_context = ctx; return doc;
}
function removeInteraction(document, interactionId) {
  const doc = normalize(document); const id = String(interactionId || ""); const ctx = { ...(doc.assistant_context || {}) };
  const row = (ctx.interactions || []).find((item) => String(item?.id) === id);
  if (!row) return doc;
  for (const character of doc.characters) for (const section of SECTION_IDS) character.prompt_sections[section] = (character.prompt_sections[section] || []).filter((entry) => entry.interaction_id !== id);
  ctx.interactions = (ctx.interactions || []).filter((item) => String(item?.id) !== id); doc.assistant_context = ctx; return doc;
}

// proposal 条目 -> schema v2 section map（free_text 条目从 base 中提取，不落入 section）。
function proposalListToSections(list) {
  const out = emptySections();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const tag = String(raw.tag || "").trim();
    if (!tag) continue;
    const section = SECTION_IDS.includes(raw.section) ? raw.section : "other";
    const weight = Number.isFinite(Number(raw.weight ?? raw.strength)) ? Number(raw.weight ?? raw.strength) : 1;
    out[section].push(normalizeEntry({ tag, weight, section, custom: false, source: raw.source || "auto_split", relation: ["source", "target", "mutual"].includes(raw.relation) ? raw.relation : null, brackets: Number.isFinite(Number(raw.brackets)) ? Number(raw.brackets) : 0 }, section));
  }
  return out;
}
function proposalFreeText(list) {
  const parts = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (raw && typeof raw === "object" && (raw.kind === "free_text" || (raw.text != null && !raw.tag))) parts.push(String(raw.text ?? ""));
  }
  return parts.filter(Boolean).join("\n");
}
// Auto-Split proposal（prompt/auto_split.py 输出）-> PromptDocument schema v2。
function documentFromProposal(proposal = {}) {
  const src = proposal && typeof proposal === "object" ? proposal : {};
  const baseList = Array.isArray(src.base) ? src.base : [];
  const sections = proposalListToSections(baseList);
  const globalUc = proposalListToSections(src.global_uc);
  const chars = Array.isArray(src.characters) && src.characters.length
    ? src.characters.map((c, i) => ({
        name: String((c && c.name) || `Character ${i + 1}`),
        prompt_sections: proposalListToSections(c && c.prompt),
        uc_sections: proposalListToSections(c && c.uc),
        position: (c && c.position) || null,
        enabled: enabledValue(c && c.enabled, true),
      }))
    : [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections(), position: null, enabled: true }];
  return {
    schema_version: 2,
    sections,
    characters: chars,
    global_uc_sections: globalUc,
    free_text: proposalFreeText(baseList),
    free_text_en: "",
    use_free_text_en: false,
    assistant_context: (src.assistant_context && typeof src.assistant_context === "object") ? src.assistant_context : {},
  };
}

// 严格互斥组原子处理（SET_EXCLUSIVE_GROUP）：
//   - clothing_state 作用域 = char:characterIndex（按角色）。
//   - position / primary_act 是角色动作，作用域为所有角色卡；镜头 / 环境仍为 Base。
//   - 在作用域内按 canonical members 删除旧组条目，加入 newTag（非空），更新 assistant_context。
const EXCLUSIVE_SCOPE_SECTION = { primary_act: "action", primary_scene_type: "scene", position: "action", composition: "composition", clothing_state: "clothing", expressions: "expression", character_state: "expression" };
function applyExclusiveGroup(document, payload = {}) {
  const doc = normalize(document);
  const group = String(payload.group || "");
  const key = String(payload.key || "");
  const newTag = String(payload.newTag || "").trim();
  const members = new Set((Array.isArray(payload.members) ? payload.members : []).map((t) => String(t).trim().toLocaleLowerCase()).filter(Boolean));
  const characterIndex = payload.characterIndex == null ? null : Number(payload.characterIndex);
  const characterWideAction = group === "position" || group === "primary_act";
  if (characterWideAction) {
    // 选择体位 / 主要行为时顺手修复旧 Base 归属；这样用户不必先手动清理。
    moveBasePoseStateToCharacters(doc);
    const removeMembers = (sections) => SECTION_IDS.forEach((id) => { sections[id] = (sections[id] || []).filter((entry) => !members.has(String(entry?.tag || "").trim().toLocaleLowerCase())); });
    removeMembers(doc.sections);
    doc.characters.forEach((character, index) => {
      removeMembers(character.prompt_sections);
      if (!newTag) return;
      const section = character.prompt_sections.action || (character.prompt_sections.action = []);
      if (!section.some((entry) => String(entry?.tag || "").trim().toLocaleLowerCase() === newTag.toLocaleLowerCase())) {
        section.push(normalizeEntry({ tag: newTag, section: "action", custom: false, source: "exclusive", pose_role: index }, "action"));
      }
    });
    const ctx = { ...(doc.assistant_context || {}) };
    if (key) ctx[group] = key; else delete ctx[group];
    doc.assistant_context = ctx;
    return doc;
  }
  let scopeTarget = "base";
  if (["clothing_state", "expressions", "character_state"].includes(group)) {
    const idx = characterIndex == null ? 0 : characterIndex;
    while (doc.characters.length <= idx) doc.characters.push(normalizeCharacter({}, doc.characters.length));
    scopeTarget = `char:${idx}`;
  }
  const sections = getSections(doc, scopeTarget);
  if (sections) {
    SECTION_IDS.forEach((id) => {
      sections[id] = (sections[id] || []).filter((e) => !members.has(String(e.tag).toLocaleLowerCase()));
    });
    if (newTag) {
      const section = EXCLUSIVE_SCOPE_SECTION[group] || "other";
      sections[section].push(normalizeEntry({ tag: newTag, section, custom: false, source: "exclusive" }, section));
    }
  }
  const ctx = { ...(doc.assistant_context || {}) };
  if (["clothing_state", "expressions", "character_state"].includes(group)) {
    const idx = characterIndex == null ? 0 : characterIndex;
    const values = { ...(ctx[group] || {}) };
    if (key) values[idx] = key; else delete values[idx];
    ctx[group] = values;
  } else if (key) {
    ctx[group] = key;
  } else {
    delete ctx[group];
  }
  doc.assistant_context = ctx;
  return doc;
}

// 生成视图的 Effective Free Text：勾选英文译文且译文非空时用译文，否则用中文原文。
function effectiveFreeText(document) {
  const doc = normalize(document);
  return doc.use_free_text_en && (doc.free_text_en || "").trim() ? doc.free_text_en : doc.free_text;
}

// 生成 Prompt 的唯一权威编译入口（纯函数，无 DOM / 无应用状态）。
// 返回 { basePrompt, globalUc, characters }：
//   - basePrompt = [serializeTarget(base), effectiveFreeText].filter(Boolean).join(", ")
//   - globalUc   = serializeTarget(global_uc)
//   - characters = characters.map({ name, prompt: char:i, uc: char:i:uc, position, enabled })
// 与 static/app.js 的 naiGenerate / naiUpdateEffectivePreview 共用，保证 Preview == payload。
function buildGenerationPromptState(document) {
  const doc = normalize(document);
  const basePrompt = [serializeTarget(doc, "base"), effectiveFreeText(doc)].filter((part) => part && String(part).trim()).join(", ");
  const globalUc = serializeTarget(doc, "global_uc");
  const characters = doc.characters.map((character, index) => ({
    name: character.name,
    prompt: serializeTarget(doc, `char:${index}`),
    uc: serializeTarget(doc, `char:${index}:uc`),
    position: character.position ? { ...character.position } : null,
    enabled: character.enabled !== false,
  }));
  return { basePrompt, globalUc, characters };
}

export { SECTION_IDS, emptySections, createEmpty, normalize, normalizeEntry, getTargetSections, getTargetEntries, recommendationContextTags, selectedTagKeysForTarget, serializeTarget, parseTargetText, reconcileTargetText, addTag, replaceSlotTag, removeTag, updateEntry, addCharacter, removeCharacter, renameCharacter, setCharacterEnabled, moveCharacter, setCharacterPosition, getAssistantContext, setAssistantContext, syncSceneParticipants, applyInteraction, removeInteraction, applyPoseVariation, migrateBasePoseState, characterHasContent, documentFromProposal, applyExclusiveGroup, effectiveFreeText, buildGenerationPromptState };
