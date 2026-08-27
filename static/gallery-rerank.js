"use strict";

// 纯函数：autocomplete 个性化重排（只在近等搜索相关度内生效）。
// 无 DOM / app.js 全局依赖，可在 Node 直接单测。
// 排序键：rank（搜索层级）→ 相似度千分位桶（近等）→ 角色历史 → 当前共现 →
// 全局正向历史（strong 优先）→ use_count → post_count → 标签名 → 原序（稳定）。
// 绝不改变搜索层级 / 相似度优先级：跨查询相关度差异由 rank/similarity 主导。

export function tagKey(tag) {
  return String(tag ?? "").toLocaleLowerCase().trim();
}

export function rerankResults(results, prefs, ctx) {
  if (!prefs || !results || results.length < 2) return results || [];
  const { charIdentities = new Set(), promptTags = new Set() } = ctx || {};
  const co = prefs.cooccurrence || {};
  const globalTags = prefs.global_tags || {};
  const charTags = prefs.character_tags || {};
  const scored = (results || []).map((item, i) => {
    const key = tagKey(item.tag);
    let charBoost = 0;
    for (const id of charIdentities) {
      const v = charTags[id]?.tags?.[key] || 0;
      if (v > charBoost) charBoost = v;
    }
    let cooccur = 0;
    for (const t of promptTags) {
      const partners = co[t];
      if (partners && partners[key]) cooccur += partners[key];
    }
    const g = globalTags[key];
    const sortKey = [
      Number(item.rank ?? 0),
      -Math.round(Number(item.similarity ?? 0) * 1000),
      -charBoost,
      -cooccur,
      -(g ? g.strong : 0),
      -(g ? g.count : 0),
      -(Number(item.use_count) || 0),
      -(Number(item.post_count) || 0),
      key,
      i,
    ];
    return { item, sortKey };
  });
  scored.sort((a, b) => {
    const ka = a.sortKey, kb = b.sortKey;
    for (let j = 0; j < ka.length; j++) {
      if (ka[j] < kb[j]) return -1;
      if (ka[j] > kb[j]) return 1;
    }
    return 0;
  });
  return scored.map((s) => s.item);
}
