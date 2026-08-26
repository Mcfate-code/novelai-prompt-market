"use strict";

// Split commas while preserving balanced NovelAI weight wrappers: 1.5::tag, night::.
export function splitPromptTokens(text) {
  const source = String(text || "");
  const tokens = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const rest = source.slice(i);
    const opening = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)::/);
    if (opening) { depth += 1; i += opening[0].length - 1; continue; }
    else if (source[i] === ':' && source[i + 1] === ':' && depth > 0) { depth -= 1; i += 1; continue; }
    if (source[i] === ',' && depth === 0) { tokens.push(source.slice(start, i).trim()); start = i + 1; }
  }
  tokens.push(source.slice(start).trim());
  return tokens.filter(Boolean);
}

// 定位 caret 所在 token 的原始 span（{start,end}，未 trim），是 caret-range 的唯一权威来源。
// 分割规则与 splitPromptTokens 完全一致：仅按逗号切分，同时尊重 `weight::tag::` 包裹（`::` 深度）。
export function tokenRangeAtCaret(text, caret) {
  const source = String(text || "");
  const at = Math.max(0, Math.min(Number(caret) || 0, source.length));
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const rest = source.slice(i);
    const opening = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)::/);
    if (opening) { depth += 1; i += opening[0].length - 1; continue; }
    else if (source[i] === ":" && source[i + 1] === ":" && depth > 0) { depth -= 1; i += 1; continue; }
    if (source[i] === "," && depth === 0) {
      if (at >= start && at <= i) return { start, end: i };
      start = i + 1;
    }
  }
  return { start, end: source.length };
}

export function parsePromptToken(token) {
  const raw = String(token || "").trim();
  const weighted = raw.match(/^((?:\d+(?:\.\d+)?|\.\d+))::(.+?)::$/);
  return { raw, tag: (weighted ? weighted[2] : raw).trim(), weight: weighted ? Number(weighted[1]) : 1, weighted: !!weighted };
}
export function joinPromptTokens(tokens) { return (tokens || []).map((token) => String(token || "").trim()).filter(Boolean).join(", "); }
