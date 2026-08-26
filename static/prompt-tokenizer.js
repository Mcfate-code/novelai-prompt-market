"use strict";

// Split commas while preserving balanced NovelAI weight wrappers: 1.5::tag, night::.
export function splitPromptTokens(text) {
  const source = String(text || "");
  const tokens = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const rest = source.slice(i);
    if (/^\d+(?:\.\d+)?::/.test(rest) || /^\.\d+::/.test(rest)) depth += 1;
    else if (source[i] === ':' && source[i + 1] === ':' && depth > 0) { depth -= 1; i += 1; continue; }
    if (source[i] === ',' && depth === 0) { tokens.push(source.slice(start, i).trim()); start = i + 1; }
  }
  tokens.push(source.slice(start).trim());
  return tokens.filter(Boolean);
}

export function parsePromptToken(token) {
  const raw = String(token || "").trim();
  const weighted = raw.match(/^((?:\d+(?:\.\d+)?|\.\d+))::(.+?)::$/);
  return { raw, tag: (weighted ? weighted[2] : raw).trim(), weight: weighted ? Number(weighted[1]) : 1, weighted: !!weighted };
}
