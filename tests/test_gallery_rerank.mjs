/**
 * Gallery Preference Memory：autocomplete 个性化重排（static/gallery-rerank.js 纯函数）。
 *
 * 验证排序契约：
 *   - 搜索层级（rank）与相似度优先级绝不被偏好覆盖（blue ha → blue hair 先于 forest）。
 *   - 近等相关度内：角色历史 > 当前共现 > 全局 strong > 全局普通 > use_count > post_count。
 *   - 无偏好数据时保持原顺序（稳定）。
 *
 * 运行方式: node --test tests/test_gallery_rerank.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rerankResults } from "../static/gallery-rerank.js";

function item(tag, { rank = 3, similarity = 0.9, post_count = 100, use_count = 0 } = {}) {
  return { tag, rank, similarity, post_count, use_count, match_reason: "匹配标签或别名前缀" };
}

test("搜索层级优先：blue ha → blue hair 先于 forest（即使 forest 被收藏）", () => {
  const results = [
    item("forest", { rank: 7, similarity: 0.2 }),     // fuzzy，弱相关
    item("blue hair", { rank: 3, similarity: 0.93 }), // prefix，强相关
  ];
  const prefs = {
    global_tags: {
      forest: { count: 5, strong: 5 },
      "blue hair": { count: 1, strong: 0 },
    },
    character_tags: {},
    cooccurrence: {},
  };
  const out = rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "forest"]);
});

test("近等相关度内：strong 优先于普通出现", () => {
  const results = [
    item("blue eyes", { rank: 3, similarity: 0.85, post_count: 999 }),
    item("blue hair", { rank: 3, similarity: 0.85, post_count: 10 }),
  ];
  const prefs = {
    global_tags: {
      "blue hair": { count: 3, strong: 3 },
      "blue eyes": { count: 3, strong: 0 },
    },
    character_tags: {},
    cooccurrence: {},
  };
  const out = rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "blue eyes"]);
});

test("相似度千分位桶内才允许偏好排序", () => {
  const results = [
    item("ordinary", { rank: 3, similarity: 0.8504, post_count: 1 }),
    item("strong", { rank: 3, similarity: 0.8501, post_count: 999 }),
  ];
  const prefs = { global_tags: { strong: { count: 2, strong: 2 } }, character_tags: {}, cooccurrence: {} };
  assert.deepEqual(rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() }).map((x) => x.tag), ["strong", "ordinary"]);
});

test("角色历史优先于全局频率（当前角色身份命中）", () => {
  const results = [
    item("long hair", { rank: 3, similarity: 0.85 }),
    item("blue hair", { rank: 3, similarity: 0.85 }),
  ];
  const prefs = {
    global_tags: {
      "long hair": { count: 20, strong: 5 },
      "blue hair": { count: 2, strong: 0 },
    },
    character_tags: {
      "citlali (genshin impact)": { count: 3, tags: { "blue hair": 3 } },
    },
    cooccurrence: {},
  };
  const out = rerankResults(results, prefs, {
    charIdentities: new Set(["citlali (genshin impact)"]),
    promptTags: new Set(),
  });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "long hair"]);
});

test("当前共现优先于全局频率", () => {
  const results = [
    item("blonde hair", { rank: 3, similarity: 0.85 }),
    item("blue eyes", { rank: 3, similarity: 0.85 }),
  ];
  const prefs = {
    global_tags: {
      "blonde hair": { count: 20, strong: 0 },
      "blue eyes": { count: 5, strong: 0 },
    },
    character_tags: {},
    cooccurrence: {
      "blue hair": { "blue eyes": 4 },
    },
  };
  const out = rerankResults(results, prefs, {
    charIdentities: new Set(),
    promptTags: new Set(["blue hair"]),
  });
  assert.deepEqual(out.map((x) => x.tag), ["blue eyes", "blonde hair"]);
});

test("相似度更高者仍保持在前（近等桶边界外）", () => {
  const results = [
    item("forest", { rank: 3, similarity: 0.5 }),
    item("blue hair", { rank: 3, similarity: 0.95 }),
  ];
  const prefs = {
    global_tags: { forest: { count: 100, strong: 100 } },
    character_tags: {},
    cooccurrence: {},
  };
  const out = rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "forest"]);
});

test("无偏好数据时保持原顺序（稳定）", () => {
  const results = [
    item("blue hair", { rank: 3, similarity: 0.9 }),
    item("blue eyes", { rank: 3, similarity: 0.9 }),
  ];
  const out = rerankResults(results, null, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "blue eyes"]);
});

test("回归：无 preference 命中时 use_count 优先于 post_count（对齐 search.py 契约）", () => {
  const results = [
    item("blue eyes", { rank: 3, similarity: 0.9, post_count: 999, use_count: 0 }),
    item("blue hair", { rank: 3, similarity: 0.9, post_count: 100, use_count: 5 }),
  ];
  const prefs = { global_tags: {}, character_tags: {}, cooccurrence: {} };
  const out = rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["blue hair", "blue eyes"]);
});

test("delete 事件不进入偏好（无 delete 信号字段参与排序）", () => {
  const results = [item("forest", { rank: 3, similarity: 0.9 })];
  const prefs = { global_tags: { forest: { count: 1, strong: 0 } }, character_tags: {}, cooccurrence: {}, totals: { deletes: 3 } };
  const out = rerankResults(results, prefs, { charIdentities: new Set(), promptTags: new Set() });
  assert.deepEqual(out.map((x) => x.tag), ["forest"]);
});
