"""构建期流水线：SiliconFlow Embedding 语义先验（§41/§42）。

离线构建两种语义先验 + manifest，写入 data/offline_prompt_prior.sqlite：

- ``prior_semantic_neighbor``：tag↔tag 语义近邻（embedding 相似度 TopK）。
- ``tag_semantic_node``：tag → 语义槽位 node（多来源：seed/taxonomy/section/embedding）。
- ``prior_manifest``：构建元信息。

运行时不依赖本脚本、不依赖 SiliconFlow API / numpy / faiss —— 只读适配层在
prompt/prior.py。本脚本仅构建期使用。

用法（示例）：
    SILICONFLOW_API_KEY=sk-... python scripts/build_embedding_prior.py \
        --model BAAI/bge-m3 --compare-model BAAI/bge-large-zh-v1.5 \
        --benchmark-first --batch-size 16
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import db  # noqa: E402
from scripts.lib import (  # noqa: E402
    embedding_cache,
    semantic_slots,
    siliconflow_embeddings,
    tag_enrichment,
)
from scripts.lib.embedding_cache import EmbeddingCache  # noqa: E402
from scripts.lib.siliconflow_embeddings import embed_batch, l2_normalize  # noqa: E402

CONFIG_DIR = REPO_ROOT / "config"
DATA_DIR = REPO_ROOT / "data"
REPORTS_DIR = REPO_ROOT / "reports"
NAV_PATH = CONFIG_DIR / "prompt_navigation.json"
SLOTS_PATH = CONFIG_DIR / "semantic_slots.json"
BENCHMARK_FIXTURE = REPO_ROOT / "tests" / "fixtures" / "embedding_benchmark.json"
DEFAULT_OUTPUT = DATA_DIR / "offline_prompt_prior.sqlite"
DEFAULT_PIPELINE_VERSION = "sf-emb-v1"
EMBEDDING_REVISION = "provider-managed/unavailable"

SECTION_TO_NODE = {
    "composition": "base_composition",
    "style": "base_style",
    "quality": "quality",
    "character": "char_identity",
    "clothing": "char_clothing",
    "expression": "char_expression",
    "action": "char_action",
    # "scene" / "appearance" 有歧义 → 交还 embedding
}


class StatsCollector:
    """累计请求级统计（用于 benchmark / 成本核算）。"""

    def __init__(self):
        self.attempts = 0
        self.ok_attempts = 0
        self.failed_attempts = 0
        self.total_latency = 0.0
        self.total_prompt_tokens = 0

    def on_request(self, duration, ok, status, tokens):
        self.attempts += 1
        if ok:
            self.ok_attempts += 1
            self.total_latency += float(duration)
            self.total_prompt_tokens += int(tokens or 0)
        else:
            self.failed_attempts += 1

    @property
    def avg_latency(self):
        return (self.total_latency / self.ok_attempts) if self.ok_attempts else 0.0

    @property
    def error_rate(self):
        return (self.failed_attempts / self.attempts) if self.attempts else 0.0


def probe_live(model, args, n_texts=512):
    """用随机 nonce 文本做一次真实延迟/吞吐探测（直接调 API，绕过缓存）。

    返回 stats dict（avg_latency_s / error_rate / total_requests / ok_requests /
    failed_requests / total_prompt_tokens / total_inputs）。用于在缓存命中时仍能
    给出真实的延迟 / 错误率 / token 用量（否则二次运行的 stats 恒为 0）。
    """
    stats = StatsCollector()
    nonce = time.strftime("%Y%m%d%H%M%S")
    texts = [f"__probe_{nonce}_{i}__ semantic prior latency probe" for i in range(int(n_texts))]
    _, usage = embed_batch(
        texts, model,
        concurrency=args.request_concurrency,
        batch_size=args.batch_size,
        on_request=stats.on_request,
    )
    return {
        "avg_latency_s": round(stats.avg_latency, 4),
        "error_rate": round(stats.error_rate, 4),
        "total_requests": stats.attempts,
        "ok_requests": stats.ok_attempts,
        "failed_requests": stats.failed_attempts,
        "total_prompt_tokens": stats.total_prompt_tokens,
        "total_inputs": len(texts),
        "probe_inputs": len(texts),
    }


def load_navigation(path=NAV_PATH):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    seed_map = {}
    parent_map = {}
    depth_map = {}  # tag_key -> (node_id, depth)

    def walk(node, parent=None, depth=0):
        nid = node.get("id")
        if not nid:
            return
        if parent:
            parent_map[nid] = parent
        for t in node.get("seed_tags") or []:
            key = tag_enrichment.normalize_tag(t)
            cur = depth_map.get(key)
            # 同一 tag 出现在父/子多节点时，优先取更深（更具体）的节点。
            if cur is None or depth > cur[1]:
                depth_map[key] = (nid, depth)
        for c in node.get("children") or []:
            walk(c, nid, depth + 1)

    for root_key in ("base", "character"):
        root = data.get(root_key)
        if root:
            walk(root)
    seed_map = {k: v[0] for k, v in depth_map.items()}
    return seed_map, parent_map


def classify_relation(src_node, dst_node, parent_map):
    if src_node == "unknown" or dst_node == "unknown":
        return "unknown"
    if src_node == dst_node:
        return "same_slot"
    sp = parent_map.get(src_node)
    dp = parent_map.get(dst_node)
    if sp and dp and sp == dp:
        return "same_parent"
    return "cross_slot"


def enumerate_corpus(limit, retain_tags=None):
    conn = db.get_conn()
    try:
        records = list(tag_enrichment.iter_canonical_tags(conn, limit=limit, retain_tags=retain_tags))
    finally:
        conn.close()
    return records  # [(tag_key, meta), ...]


def enhanced_text_of(meta):
    return tag_enrichment.build_enhanced_text(
        meta["prompt_tag"],
        zh=meta["zh_name"],
        aliases=meta["aliases"],
        section=meta["section"],
        taxonomy=meta["taxonomy"],
    )


def embed_texts_cached(texts, model, cache, args, stats):
    """缓存优先 embedding。返回 (list[np.ndarray normalized], usage dict)。"""
    hits, miss_idx = cache.get_cached(texts, model, args.pipeline_version)
    vectors = list(hits)
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if miss_idx:
        miss_texts = [texts[i] for i in miss_idx]
        emb, u = embed_batch(
            miss_texts, model,
            concurrency=args.request_concurrency,
            batch_size=args.batch_size,
            on_request=stats.on_request if stats else None,
        )
        for k in usage:
            usage[k] = int(u.get(k) or 0)
        norm = [l2_normalize(v) for v in emb]
        cache.put_batch(miss_texts, model, norm, args.pipeline_version)
        for pos, i in enumerate(miss_idx):
            vectors[i] = np.asarray(norm[pos], dtype=np.float32)
    else:
        vectors = [np.asarray(v, dtype=np.float32) for v in vectors]
    return vectors, usage


def compute_neighbors(matrix, tag_keys, k):
    """matrix (N,D) 已归一 → 逐标签 Top-K 近邻（排除自身）。"""
    N = matrix.shape[0]
    kk = min(k, N - 1)
    out = []
    query_batch = 256
    for start in range(0, N, query_batch):
        end = min(start + query_batch, N)
        sim = matrix[start:end] @ matrix.T  # (b, N)
        for b in range(end - start):
            sim[b, start + b] = -1e30  # 排除自身
        if kk <= 0:
            for b in range(end - start):
                out.append((tag_keys[start + b], []))
            continue
        idx = np.argpartition(sim, -kk, axis=1)[:, -kk:]
        rows = np.arange(end - start)
        vals = sim[rows[:, None], idx]
        order = np.argsort(-vals, axis=1)
        idx_sorted = idx[rows[:, None], order]
        vals_sorted = vals[rows[:, None], order]
        for b in range(end - start):
            src = tag_keys[start + b]
            neigh = []
            for j in range(kk):
                dst = tag_keys[int(idx_sorted[b, j])]
                s = float(vals_sorted[b, j])
                if dst == src:
                    continue
                neigh.append((dst, s))
            out.append((src, neigh))
    return dict(out)


def _table_columns(conn, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def create_output_schema(conn):
    """建立本任务的表（仅 tag_semantic_node / prior_semantic_neighbor / prior_manifest）。

    并行主任务（prompt/prior_build.py）可能已建过同名的旧版表：
      - 旧 ``tag_semantic_node`` 用 ``semantic_node_id``/``source``（本任务 §28 用
        ``node_id``/``rule_source`` + embedding 证据列）。
      - 旧 ``prior_manifest`` 用 ``source/revision/license/...`` 列（本任务用 key/value）。
    这两种表都属于本任务（§28/§40 明确列为本任务表，且不在「不得删改」清单内），
    故检测到旧版 schema 时 DROP 后按本任务 schema 重建。绝不触碰
    prior_tag_assoc / prior_slot_tag / prior_context_tag / prior_slot_transition。
    """
    existing = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}

    if "tag_semantic_node" in existing:
        cols = _table_columns(conn, "tag_semantic_node")
        if "node_id" not in cols and "semantic_node_id" in cols:
            conn.execute("DROP TABLE tag_semantic_node")

    if "prior_manifest" in existing:
        cols = _table_columns(conn, "prior_manifest")
        if "key" not in cols or "value" not in cols:
            conn.execute("DROP TABLE prior_manifest")

    conn.executescript("""
    CREATE TABLE IF NOT EXISTS tag_semantic_node (
        tag TEXT PRIMARY KEY,
        node_id TEXT,
        confidence REAL,
        rule_source TEXT,
        embedding_score REAL,
        model_id TEXT,
        model_revision TEXT,
        safety_scope TEXT
    );
    CREATE TABLE IF NOT EXISTS prior_semantic_neighbor (
        src_tag TEXT,
        dst_tag TEXT,
        similarity REAL,
        src_node TEXT,
        dst_node TEXT,
        relation_type TEXT,
        safety_scope TEXT,
        model_id TEXT,
        model_revision TEXT,
        PRIMARY KEY(src_tag, dst_tag)
    );
    CREATE TABLE IF NOT EXISTS prior_manifest (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tsn_node ON tag_semantic_node(node_id);
    CREATE INDEX IF NOT EXISTS idx_tsn_tag ON tag_semantic_node(tag);
    CREATE INDEX IF NOT EXISTS idx_psn_src ON prior_semantic_neighbor(src_tag);
    CREATE INDEX IF NOT EXISTS idx_psn_srcnode ON prior_semantic_neighbor(src_node);
    """)
    conn.commit()


def write_manifest(conn, manifest: dict):
    for k, v in manifest.items():
        conn.execute(
            "INSERT OR REPLACE INTO prior_manifest (key, value) VALUES (?,?)",
            (k, str(v)),
        )
    conn.commit()


def resolve_node(tag_key, meta, vector, slot_vectors, seed_map, adult_set,
                 min_similarity, min_margin):
    """tag → 语义节点（§27 多来源，embedding 仅作辅助证据）。

    优先级（§27 明确顺序，确定性来源在前，embedding 垫底；confidence 为非校准值）：
      1. manual     tag_section_override → SECTION_TO_NODE（人类显式覆盖，最高）conf 0.95
      2. seed       prompt_navigation.json seed_tags                        conf 0.90
      3. taxonomy   taxonomy_map.category_l1 → node                         conf 0.85
      4. category   tags.category 4/3（角色/版权身份）→ char_identity        conf 0.75
      5. embedding  槽位质心相似度 + 歧义保护（§30/§31，仅辅助）              conf 0.60
      否则 node_id='unknown'，rule_source='unknown'（§27 末尾 fallback）。

    embedding 只有在没有更强元数据时才会被采用；有更强来源时 embedding 分数不参与
    决策（作为证据字段单独记录）。relation_type 一律由 node/taxonomy 派生，绝不由
    相似度直接判定（见 classify_relation）。
    """
    safety = "adult" if tag_key in adult_set else "general"
    # 1. explicit/manual mapping（tag_section_override 人类显式覆盖，最高优先）
    node = SECTION_TO_NODE.get(meta.get("section")) if meta.get("section") else None
    if node:
        return node, 0.95, "manual", None, safety
    # 2. prompt_navigation seed_tags
    if tag_key in seed_map:
        return seed_map[tag_key], 0.90, "seed", None, safety
    # 3. existing taxonomy（taxonomy_map.category_l1）
    node = tag_enrichment.TAXONOMY_L1_TO_NODE.get(meta.get("taxonomy_l1")) if meta.get("taxonomy_l1") else None
    if node:
        return node, 0.85, "taxonomy", None, safety
    # 4. Danbooru category / known category
    if meta.get("category") in (4, 3):
        return "char_identity", 0.75, "category", None, safety
    # 5. embedding slot similarity（辅助，带最小相似度/边际歧义保护）
    node_id, score, src = semantic_slots.assign_slot(
        vector, slot_vectors, min_similarity=min_similarity, min_margin=min_margin
    )
    if src == "embedding":
        return node_id, 0.60, "embedding", score, safety
    # 6. unknown fallback
    return "unknown", score, "unknown", score, safety


# --------------------------------------------------------------------------- #
# Benchmark
# --------------------------------------------------------------------------- #
def _rank_topk(query_vec, corpus_matrix, corpus_keys, k, exclude_idx=None):
    sims = corpus_matrix @ np.asarray(query_vec, dtype=np.float32).reshape(-1, 1)
    sims = sims.ravel()
    if exclude_idx is not None:
        sims = sims.copy()
        sims[exclude_idx] = -1e30
    k = min(k, len(sims) - (1 if exclude_idx is not None else 0))
    idx = np.argpartition(sims, -k)[-k:]
    idx = idx[np.argsort(-sims[idx])]
    return [corpus_keys[int(i)] for i in idx]


def _family_ranks(query_vec, slot_vectors, node_family, families):
    """返回按相似度降序排列的 family 列表（每个 family 取其内部节点最大相似度）。"""
    v = np.asarray(query_vec, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    if n == 0.0:
        return []
    v = v / n
    best = {}
    for nid, fvec in slot_vectors.items():
        fam = node_family.get(nid, nid)
        s = float(np.dot(np.asarray(fvec, dtype=np.float32).reshape(-1), v))
        best[fam] = max(best.get(fam, -1.0), s)
    ranked = sorted(best.items(), key=lambda kv: -kv[1])
    return [f for f, _ in ranked]


def run_benchmark(model, args, corpus_keys, corpus_matrix, slot_defs, embed_fn):
    fixture = json.loads(Path(BENCHMARK_FIXTURE).read_text(encoding="utf-8"))
    # 槽位向量
    slot_vectors, _ = semantic_slots.embed_slot_vectors(slot_defs, embed_fn)
    node_family = semantic_slots.node_to_family(slot_defs)

    # Task A: zh → en
    a_entries = fixture.get("A_zh_to_en", [])
    a_queries = [e["query_zh"] for e in a_entries]
    a_vecs, _ = embed_fn(a_queries) if a_queries else ([], {})
    recalls = {1: 0, 5: 0, 10: 0}
    corpus_set = set(corpus_keys)
    missing_a = 0
    for i, entry in enumerate(a_entries):
        accepted = [tag_enrichment.normalize_tag(t) for t in entry["accepted_targets"]]
        accepted = [t for t in accepted if t in corpus_set]
        if not accepted:
            missing_a += 1
            continue
        top10 = _rank_topk(a_vecs[i], corpus_matrix, corpus_keys, 10)
        for k in (1, 5, 10):
            if any(t in top10[:k] for t in accepted):
                recalls[k] += 1
    n_a = max(1, len(a_entries) - missing_a)
    for k in recalls:
        recalls[k] /= n_a

    # Task B: slot
    b_entries = fixture.get("B_tag_to_slot", [])
    b_tags = [tag_enrichment.normalize_tag(e["tag"]) for e in b_entries]
    b_vecs, _ = embed_fn(b_tags) if b_tags else ([], {})
    top1 = top3 = 0
    n_b = 0
    for i, entry in enumerate(b_entries):
        expected = entry["expected_slot"]
        fams = _family_ranks(b_vecs[i], slot_vectors, node_family, None)
        if not fams:
            continue
        n_b += 1
        if fams[0] == expected:
            top1 += 1
        if expected in fams[:3]:
            top3 += 1
    if n_b:
        top1 /= n_b
        top3 /= n_b

    # Task C: neighbors（查询向量用该 tag 在 corpus 中的增强文本向量，排除自身）
    c_entries = fixture.get("C_tag_neighbors", [])
    c_tags = [tag_enrichment.normalize_tag(e["tag"]) for e in c_entries]
    corpus_index = {k: i for i, k in enumerate(corpus_keys)}
    prec_sum = 0.0
    avoid_violations = 0
    n_c = 0
    missing_c = 0
    for i, entry in enumerate(c_entries):
        qi = corpus_index.get(c_tags[i])
        if qi is None:
            missing_c += 1
            continue
        must_include = [tag_enrichment.normalize_tag(t) for t in entry.get("must_include", [])]
        must_avoid = [tag_enrichment.normalize_tag(t) for t in entry.get("must_avoid", [])]
        top10 = _rank_topk(corpus_matrix[qi], corpus_matrix, corpus_keys, 10, exclude_idx=qi)
        top10_set = set(top10)
        found = sum(1 for t in must_include if t in top10_set)
        prec_sum += found / 10.0
        if any(t in top10_set for t in must_avoid):
            avoid_violations += 1
        n_c += 1
    precision10 = (prec_sum / n_c) if n_c else 0.0
    avoid_rate = (avoid_violations / n_c) if n_c else 0.0

    return {
        "zh_to_en": {"recall_1": round(recalls[1], 4), "recall_5": round(recalls[5], 4),
                     "recall_10": round(recalls[10], 4)},
        "slot": {"top1": round(top1, 4), "top3": round(top3, 4)},
        "neighbor": {"precision_10": round(precision10, 4), "must_avoid_violation_rate": round(avoid_rate, 4)},
        "fixtures": {"A_entries": len(a_entries), "B_entries": len(b_entries),
                     "C_entries": len(c_entries), "A_missing_targets": missing_a,
                     "C_missing_targets": missing_c},
    }


def model_decision(results, keys):
    """§15 决策规则：加权复合分，平局比延迟。"""
    def composite(r):
        zh = r["metrics"]["zh_to_en"]["recall_10"]
        slot = r["metrics"]["slot"]["top1"]
        neigh = r["metrics"]["neighbor"]["precision_10"]
        return 0.4 * zh + 0.3 * slot + 0.3 * neigh

    def latency(r):
        live = r.get("live_probe") or {}
        return live.get("avg_latency_s", r["stats"].avg_latency)

    best = None
    for k in keys:
        r = results[k]
        score = composite(r)
        lat = latency(r)
        if best is None:
            best = (k, score, lat)
        elif score > best[1] + 1e-9:
            best = (k, score, lat)
        elif abs(score - best[1]) <= 1e-9 and lat < best[2]:
            best = (k, score, lat)
    return best


def write_benchmark_reports(per_model, decision, decision_reason):
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "decision": {"model": decision, "reason": decision_reason},
        "models": {},
    }
    for k, r in per_model.items():
        live = r.get("live_probe") or {}
        stats = {
            "avg_latency_s": live.get("avg_latency_s", round(r["stats"].avg_latency, 4)),
            "error_rate": live.get("error_rate", round(r["stats"].error_rate, 4)),
            "total_requests": live.get("total_requests", r["stats"].attempts),
            "ok_requests": live.get("ok_requests", r["stats"].ok_attempts),
            "failed_requests": live.get("failed_requests", r["stats"].failed_attempts),
            "total_prompt_tokens": live.get("total_prompt_tokens", r["stats"].total_prompt_tokens),
            "total_inputs": live.get("total_inputs"),
        }
        report["models"][k] = {
            "metrics": r["metrics"],
            "stats": stats,
            "corpus_size": r["corpus_size"],
        }
    (REPORTS_DIR / "embedding_model_benchmark.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    lines = ["# Embedding Model Benchmark", "",
             f"- Generated: {report['generated_at']}",
             f"- Decision: **{decision}** — {decision_reason}", ""]
    for k, r in per_model.items():
        m = r["metrics"]
        s = report["models"][k]["stats"]
        lines += [
            f"## {k}",
            f"- corpus_size: {r['corpus_size']}",
            f"- zh→en Recall@1/5/10: {m['zh_to_en']['recall_1']} / {m['zh_to_en']['recall_5']} / {m['zh_to_en']['recall_10']}",
            f"- slot Top1 / Top3: {m['slot']['top1']} / {m['slot']['top3']}",
            f"- neighbor Precision@10: {m['neighbor']['precision_10']} (must_avoid violation {m['neighbor']['must_avoid_violation_rate']})",
            f"- avg latency: {s['avg_latency_s']:.4f}s | error rate: {s['error_rate']:.4f} | requests: {s['total_requests']} (ok {s['ok_requests']}) | prompt tokens: {s['total_prompt_tokens']}",
            "",
        ]
    (REPORTS_DIR / "embedding_model_benchmark.md").write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Full build
# --------------------------------------------------------------------------- #
def write_review_report(tag_rows, neighbors, sample_tags, validation_tags, bad_neighbor_tags,
                        node_family, slot_defs):
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    lines = ["# Embedding Prior Review", ""]

    lines += ["## 1. Semantic Neighbor Top-10 Validation (§49)", ""]
    for t in validation_tags:
        key = tag_enrichment.normalize_tag(t)
        neigh = neighbors.get(key, [])
        top = ", ".join(f"{d}({s:.3f})" for d, s in neigh[:10])
        lines.append(f"- **{t}**: {top if top else '(not in corpus)'}")
    lines.append("")

    lines += ["## 2. Bad-Neighbor Check (§50)", ""]
    for t in bad_neighbor_tags:
        key = tag_enrichment.normalize_tag(t)
        neigh = neighbors.get(key, [])
        top = ", ".join(f"{d}({s:.3f})" for d, s in neigh[:10])
        lines.append(f"- **{t}**: {top if top else '(not in corpus)'}")
    lines.append("")

    lines += ["## 3. Slot Validation Table (§51)", ""]
    lines.append("| tag | node | family | rule_source | confidence | embedding_score |")
    lines.append("|---|---|---|---|---|---|")
    for t in validation_tags + ["1girl", "masterpiece", "full body", "glasses", "beach", "sunset"]:
        key = tag_enrichment.normalize_tag(t)
        row = tag_rows.get(key)
        if row is None:
            lines.append(f"| {t} | - | - | - | - | - |")
            continue
        fam = node_family.get(row["node_id"], "?")
        lines.append(f"| {t} | {row['node_id']} | {fam} | {row['rule_source']} | "
                     f"{row['confidence']:.2f} | {row['embedding_score'] if row['embedding_score'] is not None else '-'} |")
    lines.append("")

    lines += ["## 4. Stratified Sample (§52)", ""]
    lines.append("| tag | node | rule_source | Top5 neighbors |")
    lines.append("|---|---|---|---|")
    for t in sample_tags:
        key = tag_enrichment.normalize_tag(t)
        row = tag_rows.get(key)
        neigh = neighbors.get(key, [])
        top = ", ".join(d for d, _ in neigh[:5])
        lines.append(f"| {t} | {row['node_id'] if row else '-'} | "
                     f"{row['rule_source'] if row else '-'} | {top} |")
    lines.append("")
    (REPORTS_DIR / "embedding_prior_review.md").write_text("\n".join(lines), encoding="utf-8")


def stratified_sample(tag_keys, metas, n=160):
    """按 post_count 分桶抽样（含长尾，§80）。"""
    import math
    if not tag_keys:
        return []
    counts = [metas[k]["post_count"] for k in tag_keys]
    logs = [math.log10(max(1, c)) for c in counts]
    lo, hi = min(logs), max(logs)
    buckets = [[] for _ in range(4)]
    for k, lv in zip(tag_keys, logs):
        bi = int((lv - lo) / (hi - lo + 1e-9) * 4)
        bi = min(3, bi)
        buckets[bi].append(k)
    out = []
    per = max(1, n // 4)
    for bucket in buckets:
        step = max(1, len(bucket) // per)
        out.extend(bucket[::step][:per])
    return out[:n]


def run_full_build(model, args, slot_defs, seed_map, parent_map, adult_set):
    cache = EmbeddingCache(args.cache_path)
    stats = StatsCollector()
    t0 = time.time()

    print(f"[build] enumerating canonical tags (limit={args.limit or 'full'}) ...", flush=True)
    records = enumerate_corpus(args.limit, retain_tags=set(seed_map))
    tag_keys = [k for k, _ in records]
    metas = {k: m for k, m in records}
    print(f"[build] {len(tag_keys)} canonical tags", flush=True)

    enhanced = [enhanced_text_of(metas[k]) for k in tag_keys]

    # 缓存命中断言（resume 场景）
    hits, miss_idx = cache.get_cached(enhanced, model, args.pipeline_version)
    print(f"[build] cache: {len(enhanced) - len(miss_idx)} hit / {len(miss_idx)} miss", flush=True)

    vectors, _ = embed_texts_cached(enhanced, model, cache, args, stats)
    matrix = np.vstack([np.asarray(v, dtype=np.float32) for v in vectors]).astype(np.float32)
    print(f"[build] embedded {len(tag_keys)} tags ({len(miss_idx)} new) in {time.time()-t0:.1f}s", flush=True)

    # 槽位向量
    slot_vectors, _ = semantic_slots.embed_slot_vectors(slot_defs, lambda texts: embed_texts_cached(texts, model, cache, args, stats))
    print(f"[build] embedded {len(slot_vectors)} slot vectors", flush=True)

    # 近邻
    neighbors = compute_neighbors(matrix, tag_keys, args.neighbor_k)
    print(f"[build] computed neighbors (k={args.neighbor_k})", flush=True)

    # 节点解析
    tag_rows = {}
    for i, k in enumerate(tag_keys):
        node_id, conf, source, escore, safety = resolve_node(
            k, metas[k], matrix[i], slot_vectors, seed_map, adult_set,
            args.min_similarity, args.min_margin,
        )
        tag_rows[k] = {
            "node_id": node_id, "confidence": conf, "rule_source": source,
            "embedding_score": escore, "safety_scope": safety,
        }

    # 写库
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    conn = db.get_conn(output)
    try:
        create_output_schema(conn)
        # 快照式全量重建本任务拥有的表（避免残留旧行；绝不触碰并行任务的表）
        conn.execute("DELETE FROM tag_semantic_node")
        conn.execute("DELETE FROM prior_semantic_neighbor")
        node_family = semantic_slots.node_to_family(slot_defs)
        for k in tag_keys:
            r = tag_rows[k]
            conn.execute(
                "INSERT OR REPLACE INTO tag_semantic_node "
                "(tag, node_id, confidence, rule_source, embedding_score, model_id, model_revision, safety_scope) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (k, r["node_id"], r["confidence"], r["rule_source"], r["embedding_score"],
                 model, EMBEDDING_REVISION, r["safety_scope"]),
            )
        n_neighbor = 0
        for src in tag_keys:
            for dst, sim in neighbors.get(src, []):
                src_node = tag_rows[src]["node_id"]
                dst_node = tag_rows[dst]["node_id"]
                rel = classify_relation(src_node, dst_node, parent_map)
                safety = "adult" if dst in adult_set else "general"
                conn.execute(
                    "INSERT OR REPLACE INTO prior_semantic_neighbor "
                    "(src_tag, dst_tag, similarity, src_node, dst_node, relation_type, safety_scope, model_id, model_revision) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (src, dst, sim, src_node, dst_node, rel, safety, model, EMBEDDING_REVISION),
                )
                n_neighbor += 1
        write_manifest(conn, {
            "artifact_version": "1",
            "pipeline_version": args.pipeline_version,
            "provider": "siliconflow",
            "embedding_model": model,
            "embedding_revision": EMBEDDING_REVISION,
            "embedding_dimension": siliconflow_embeddings.EXPECTED_DIM,
            "normalized": "true",
            "tag_count": len(tag_keys),
            "neighbor_k": args.neighbor_k,
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_datasets": "data/tags.sqlite (tags, tag_aliases, taxonomy_map, tag_section_override); config/prompt_navigation.json; config/semantic_slots.json",
            "source_revisions": "git:" + _git_rev(),
            "licenses": "danbooru tag corpus; SiliconFlow embedding model (build-time only)",
            "min_similarity": args.min_similarity,
            "min_margin": args.min_margin,
            "neighbor_rows": n_neighbor,
        })
        conn.commit()
        n_tag = conn.execute("SELECT COUNT(*) FROM tag_semantic_node").fetchone()[0]
        n_nei = conn.execute("SELECT COUNT(*) FROM prior_semantic_neighbor").fetchone()[0]
    finally:
        conn.close()

    print(f"[build] wrote {output}: tag_semantic_node={n_tag}, prior_semantic_neighbor={n_nei}", flush=True)

    # 校验 + 报告
    validation_tags = ["blue eyes", "ponytail", "blush", "kneeling", "bedroom",
                       "night", "moonlight", "white dress"]
    bad_tags = ["1girl", "solo", "masterpiece", "looking at viewer"]
    sample = stratified_sample(tag_keys, metas, n=160)
    write_review_report(tag_rows, neighbors, sample, validation_tags, bad_tags,
                        node_family, slot_defs)
    print(f"[build] wrote reports/embedding_prior_review.md in {time.time()-t0:.1f}s", flush=True)

    # 控制台校验摘要
    print("\n=== §49 Semantic Neighbor Top-10 ===", flush=True)
    for t in validation_tags:
        key = tag_enrichment.normalize_tag(t)
        neigh = neighbors.get(key, [])
        print(f"  {t}: " + ", ".join(f"{d}({s:.3f})" for d, s in neigh[:10]), flush=True)
    print("\n=== §50 Bad-Neighbor Check ===", flush=True)
    for t in bad_tags:
        key = tag_enrichment.normalize_tag(t)
        neigh = neighbors.get(key, [])
        print(f"  {t}: " + ", ".join(f"{d}({s:.3f})" for d, s in neigh[:10]), flush=True)
    return tag_rows, neighbors, stats, n_tag, n_nei


def _git_rev():
    import subprocess
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT,
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def dry_run(args):
    conn = db.get_conn()
    try:
        seed_map, _ = load_navigation()
        records = list(tag_enrichment.iter_canonical_tags(
            conn, limit=args.limit, retain_tags=set(seed_map)))
    finally:
        conn.close()
    tag_keys = [k for k, _ in records]
    metas = {k: m for k, m in records}
    enhanced = [enhanced_text_of(metas[k]) for k in tag_keys]
    cache = EmbeddingCache(args.cache_path)
    hits, miss_idx = cache.get_cached(enhanced, args.model, args.pipeline_version)
    print(f"[dry-run] model={args.model} pipeline={args.pipeline_version}")
    print(f"[dry-run] canonical tags: {len(tag_keys)}")
    print(f"[dry-run] cache hit: {len(tag_keys) - len(miss_idx)} / miss: {len(miss_idx)}")
    print(f"[dry-run] no API call made (dry-run)")
    if tag_keys:
        print("[dry-run] sample enhanced text:")
        for k in tag_keys[:3]:
            print(f"    {enhanced_text_of(metas[k])}")
    return


def main():
    ap = argparse.ArgumentParser(description="SiliconFlow embedding semantic prior build")
    ap.add_argument("--model", default="BAAI/bge-m3")
    ap.add_argument("--compare-model", default=None)
    ap.add_argument("--benchmark-first", action="store_true")
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--neighbor-k", type=int, default=32)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--cache-path", default=str(embedding_cache.DEFAULT_CACHE_PATH))
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT))
    ap.add_argument("--limit", type=int, default=0, help="0=full corpus; N>0=top-N by post_count")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--request-concurrency", type=int, default=3)
    ap.add_argument("--pipeline-version", default=DEFAULT_PIPELINE_VERSION)
    ap.add_argument("--min-similarity", type=float, default=semantic_slots.DEFAULT_MIN_SIMILARITY)
    ap.add_argument("--min-margin", type=float, default=semantic_slots.DEFAULT_MIN_MARGIN)
    args = ap.parse_args()

    print(f"[init] SiliconFlow key: {siliconflow_embeddings.key_status()}", flush=True)

    if args.dry_run:
        dry_run(args)
        return

    slot_defs = semantic_slots.load_slots(SLOTS_PATH)
    seed_map, parent_map = load_navigation()
    conn = db.get_conn()
    try:
        adult_set = tag_enrichment.build_adult_set(conn)
    finally:
        conn.close()
    print(f"[init] {len(slot_defs)} slots, {len(seed_map)} seed tags, {len(adult_set)} adult tags", flush=True)

    build_model = args.model

    if args.benchmark_first:
        models = [args.model] + ([args.compare_model] if args.compare_model else [])
        per_model = {}
        for model in models:
            print(f"\n[benchmark] preparing corpus for {model} ...", flush=True)
            cache = EmbeddingCache(args.cache_path)
            stats = StatsCollector()
            records = enumerate_corpus(args.limit, retain_tags=set(seed_map))
            tag_keys = [k for k, _ in records]
            metas = {k: m for k, m in records}
            enhanced = [enhanced_text_of(metas[k]) for k in tag_keys]
            vectors, _ = embed_texts_cached(enhanced, model, cache, args, stats)
            matrix = np.vstack([np.asarray(v, dtype=np.float32) for v in vectors]).astype(np.float32)

            def embed_fn(texts):
                return embed_texts_cached(texts, model, cache, args, stats)

            metrics = run_benchmark(model, args, tag_keys, matrix, slot_defs, embed_fn)
            live = probe_live(model, args)
            per_model[model] = {"metrics": metrics, "stats": stats,
                                "live_probe": live, "corpus_size": len(tag_keys)}
            print(f"[benchmark] {model}: {metrics}", flush=True)
            print(f"[benchmark] {model} live probe: {live}", flush=True)

        decision, score, latency = model_decision(per_model, models)
        reason = (f"composite={score:.4f} (0.4*zh_recall10 + 0.3*slot_top1 + 0.3*neighbor_prec10), "
                  f"avg_latency={latency:.4f}s")
        if args.compare_model:
            write_benchmark_reports(per_model, decision, reason)
            print(f"\n[MODEL DECISION] {decision} — {reason}", flush=True)
        else:
            write_benchmark_reports(per_model, decision, reason)
            print(f"\n[MODEL DECISION] {decision} — {reason}", flush=True)
        build_model = decision
        if decision != args.model:
            print(f"[notice] decision model {decision} != --model {args.model}; using decision model", flush=True)

    run_full_build(build_model, args, slot_defs, seed_map, parent_map, adult_set)


if __name__ == "__main__":
    main()
