"use strict";

// Canonical JS Prompt syntax codec — mirrors prompt/import_parser.py (split_tags / parse_entry)
// and prompt/novelai_export.py (format_entry / format_number). Both static/prompt-document.js
// and static/prompt-compiler.js route through this module so there is exactly one codec.

const RELATIONS = ["source", "target", "mutual"];

// Split commas while preserving balanced NovelAI weight wrappers: 1.5::tag, night::.
// Mirrors Python split_tags EXACTLY: toggle an inWeight boolean on each "::" pair; split on
// "," only when !inWeight; trim; drop empty tokens.
export function splitPromptTokens(text) {
  const source = String(text == null ? "" : text);
  const tokens = [];
  let start = 0;
  let inWeight = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === ":" && source[i + 1] === ":") {
      inWeight = !inWeight;
      i += 1;
      continue;
    }
    if (source[i] === "," && !inWeight) {
      const t = source.slice(start, i).trim();
      if (t) tokens.push(t);
      start = i + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) tokens.push(last);
  return tokens;
}

// Mirror Python format_number: .8 -> "0.8", 1.35 -> "1.35", -1 -> "-1", 1 -> "1".
export function formatNumber(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
}

// Mirror Python parse_entry. Extends the legacy shape {raw, tag, weight, weighted} with
// relation, brackets, and a strength alias (= weight).
export function parsePromptToken(token) {
  const raw = String(token == null ? "" : token).trim();
  let t = raw;
  let relation = null;
  const rel = t.match(/^(source|target|mutual)#\s*/i);
  if (rel) { relation = rel[1].toLowerCase(); t = t.slice(rel[0].length).trim(); }
  let weight = 1;
  let weighted = false;
  const w = t.match(/^(-?\d+(?:\.\d+)?|\.\d+)::([\s\S]*)::$/);
  if (w) { weighted = true; weight = Number(w[1]); t = w[2].trim(); }
  let brackets = 0;
  let inner = t;
  while (inner.startsWith("{") && inner.endsWith("}")) { brackets += 1; inner = inner.slice(1, -1); }
  while (inner.startsWith("[") && inner.endsWith("]")) { brackets -= 1; inner = inner.slice(1, -1); }
  const tag = inner.trim();
  return { raw, tag, weight, weighted, relation, brackets, strength: weight };
}

// Serialize one entry back to NovelAI syntax. Relation prefix is applied FIRST (leftmost),
// then weight wrap (brackets ignored in that case), else {}/[] emphasis, else plain tag.
// Clamp n = min(8, abs(brackets)). This mirrors Python format_entry for the relation-only /
// weight-only / brackets-only cases, and emits the round-trippable `source#1.5::hug::` form
// (relation leftmost) so that parsePromptToken(serializePromptToken(x)) is lossless.
export function serializePromptToken(entry, opts = {}) {
  const e = entry || {};
  const tag = String(e.tag == null ? "" : e.tag).trim();
  if (!tag) return "";
  const relation = RELATIONS.includes(e.relation) ? e.relation : null;
  const weight = Number.isFinite(Number(e.weight != null ? e.weight : e.strength)) ? Number(e.weight != null ? e.weight : e.strength) : 1;
  const brackets = Number.isFinite(Number(e.brackets)) ? Number(e.brackets) : 0;
  let out = tag;
  if (weight !== 1) {
    out = `${formatNumber(weight)}::${out}::`;
  } else if (brackets > 0) {
    const n = Math.min(8, brackets);
    out = "{".repeat(n) + out + "}".repeat(n);
  } else if (brackets < 0) {
    const n = Math.min(8, -brackets);
    out = "[".repeat(n) + out + "]".repeat(n);
  }
  if (relation) out = `${relation}#${out}`;
  return out;
}

// Token range at caret. Mirrors splitPromptTokens to compute INCLUSIVE [start, end] ranges
// (end = comma index or string length). Caret exactly on a comma belongs to the LEFT token.
export function tokenRangeAtCaret(text, caret) {
  const source = String(text == null ? "" : text);
  const n = Number(caret);
  const c = Number.isInteger(n) ? n : source.length;
  if (!source) return null;
  const ranges = [];
  let start = 0;
  let inWeight = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === ":" && source[i + 1] === ":") {
      inWeight = !inWeight;
      i += 1;
      continue;
    }
    if (source[i] === "," && !inWeight) {
      ranges.push({ start, end: i, raw: source.slice(start, i), token: source.slice(start, i).trim() });
      start = i + 1;
    }
  }
  ranges.push({ start, end: source.length, raw: source.slice(start), token: source.slice(start).trim() });
  for (let idx = 0; idx < ranges.length; idx++) {
    const r = ranges[idx];
    if (c >= r.start && c <= r.end) {
      return { index: idx, start: r.start, end: r.end, token: r.token, raw: r.raw, parsed: parsePromptToken(r.raw) };
    }
  }
  return null;
}

export function joinPromptTokens(tokens) { return (tokens || []).map((t) => String(t == null ? "" : t).trim()).filter(Boolean).join(", "); }
