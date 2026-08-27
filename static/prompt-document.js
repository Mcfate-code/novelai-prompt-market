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
function normalizeCharacter(raw, index) {
  const ch = raw || {};
  const prompt = ch.prompt_sections || ch.prompt || {};
  const uc = ch.uc_sections || ch.uc || {};
  return { name: String(ch.name || `Character ${index + 1}`), prompt_sections: Array.isArray(prompt) ? sectionsFromList(prompt) : normalizeSections(prompt), uc_sections: Array.isArray(uc) ? sectionsFromList(uc) : normalizeSections(uc), position: ch.position || null };
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
  const chars = Array.isArray(value.characters) && value.characters.length ? value.characters.map(normalizeCharacter) : [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections(), position: null }];
  const globalSource = value.global_uc_sections ?? value.global_uc ?? [];
  const global = Array.isArray(globalSource) ? sectionsFromList(globalSource) : normalizeSections(globalSource);
  const freeText = typeof value.free_text === "string" ? value.free_text : "";
  const freeTextEn = typeof value.free_text_en === "string" ? value.free_text_en : "";
  const assistantContext = value.assistant_context && typeof value.assistant_context === "object" ? value.assistant_context : {};
  return { schema_version: 2, sections: base, characters: chars, global_uc_sections: global, free_text: freeText, free_text_en: freeTextEn, use_free_text_en: value.use_free_text_en === true && (v2 || !!freeTextEn), assistant_context: assistantContext };
}
function createEmpty() { return normalize({ schema_version: 2, sections: emptySections(), characters: [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections() }], global_uc_sections: emptySections(), assistant_context: {} }); }
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
function removeTag(document, target, entryId) { const doc = normalize(document); const sections = getSections(doc, target); if (!sections) return doc; SECTION_IDS.forEach((id) => { sections[id] = sections[id].filter((e) => e.id !== entryId); }); return doc; }
function characterHasContent(character, index) {
  if (!character || typeof character !== "object") return false;
  if (String(character.name || "") && String(character.name) !== `Character ${index + 1}`) return true;
  if (character.position) return true;
  return [character.prompt_sections, character.uc_sections].some((sections) => getSectionEntries(sections).some((entry) => String(entry.tag || "").trim()));
}
function getSectionEntries(sections) {
  if (!sections || typeof sections !== "object") return [];
  return SECTION_IDS.flatMap((id) => Array.isArray(sections[id]) ? sections[id] : []);
}
function addCharacter(document, character = {}) {
  const doc = normalize(document);
  if (doc.characters.length >= 3) return doc;
  doc.characters.push(normalizeCharacter(character, doc.characters.length));
  return doc;
}
function removeCharacter(document, index) {
  const doc = normalize(document); const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= doc.characters.length || characterHasContent(doc.characters[idx], idx)) return doc;
  doc.characters.splice(idx, 1); if (!doc.characters.length) doc.characters.push(normalizeCharacter({}, 0)); return doc;
}
function renameCharacter(document, index, name) { const doc = normalize(document); if (doc.characters[Number(index)]) doc.characters[Number(index)].name = String(name || `Character ${Number(index) + 1}`); return doc; }
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
  if (!Number.isInteger(requested) || requested < 1 || requested > 3) return { document: doc, ok: false, blockedIndices: [] };
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
      }))
    : [{ name: "Character 1", prompt_sections: emptySections(), uc_sections: emptySections(), position: null }];
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
//   - clothing_state 作用域 = char:characterIndex（按角色）；其余组作用域 = base。
//   - 在作用域内按 canonical members 删除旧组条目，加入 newTag（非空），更新 assistant_context。
const EXCLUSIVE_SCOPE_SECTION = { primary_act: "action", primary_scene_type: "scene", position: "composition", composition: "composition", clothing_state: "clothing", expressions: "expression", character_state: "expression" };
function applyExclusiveGroup(document, payload = {}) {
  const doc = normalize(document);
  const group = String(payload.group || "");
  const key = String(payload.key || "");
  const newTag = String(payload.newTag || "").trim();
  const members = new Set((Array.isArray(payload.members) ? payload.members : []).map((t) => String(t).trim().toLocaleLowerCase()).filter(Boolean));
  const characterIndex = payload.characterIndex == null ? null : Number(payload.characterIndex);
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
//   - characters = characters.map({ name, prompt: char:i, uc: char:i:uc, position })
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
  }));
  return { basePrompt, globalUc, characters };
}

export { SECTION_IDS, emptySections, createEmpty, normalize, normalizeEntry, getTargetSections, getTargetEntries, recommendationContextTags, selectedTagKeysForTarget, serializeTarget, parseTargetText, reconcileTargetText, addTag, removeTag, updateEntry, addCharacter, removeCharacter, renameCharacter, moveCharacter, setCharacterPosition, getAssistantContext, setAssistantContext, syncSceneParticipants, applyInteraction, removeInteraction, characterHasContent, documentFromProposal, applyExclusiveGroup, effectiveFreeText, buildGenerationPromptState };
