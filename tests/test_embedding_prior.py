"""Embedding prior 构建期单元测试（全部 mock SiliconFlow，绝不发起真实 API 调用）。

运行前提：SILICONFLOW_API_KEY 未设置即可全部通过。
"""
import hashlib
import io
import json
import sqlite3
import sys
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.build_embedding_prior as build  # noqa: E402
from scripts.lib import semantic_slots, siliconflow_embeddings, tag_enrichment  # noqa: E402
from scripts.lib.embedding_cache import EmbeddingCache  # noqa: E402

DIM = 1024
FAKE_KEY = "sk-test-00000000000000000000000000000000"


def vec_for(text, dim=DIM):
    h = int(hashlib.sha256(str(text).encode("utf-8")).hexdigest(), 16)
    rng = np.random.default_rng(h)
    return rng.standard_normal(dim).tolist()


class FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._payload


def http_error(code, msg="err"):
    return urllib.error.HTTPError(
        "https://api.siliconflow.cn/v1/embeddings", code, msg, {},
        io.BytesIO(json.dumps({"error": msg}).encode("utf-8")),
    )


def make_urlopen(behaviors):
    """behavior：HTTPError 实例（抛错）| dict（成功响应配置）| callable(body)->response。

    成功响应 dict 支持：dim（截断维度）、shuffle（倒序）、drop（少一条）。
    """
    calls = []

    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body)
        behavior = behaviors[len(calls) - 1]
        if isinstance(behavior, urllib.error.HTTPError):
            raise behavior
        if callable(behavior):
            return behavior(body)
        inputs = body["input"]
        data = []
        for i, t in enumerate(inputs):
            v = vec_for(t)
            if behavior.get("dim"):
                v = v[: behavior["dim"]]
            data.append({"object": "embedding", "embedding": v, "index": i})
        if behavior.get("shuffle"):
            data = list(reversed(data))
        if behavior.get("drop"):
            data = data[:-1]
        payload = {
            "object": "list",
            "model": body["model"],
            "data": data,
            "usage": {"prompt_tokens": len(inputs) * 10, "completion_tokens": 0,
                      "total_tokens": len(inputs) * 10},
        }
        return FakeResponse(payload)

    return urlopen, calls


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("SILICONFLOW_API_KEY", FAKE_KEY)


@pytest.fixture
def no_sleep(monkeypatch):
    monkeypatch.setattr(siliconflow_embeddings.time, "sleep", lambda s: None)


# ---------------------------------------------------------------- client --- #
def test_batch_chunking_default_16(key, monkeypatch):
    urlopen, calls = make_urlopen([{}, {}, {}, {}, {}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    texts = [f"tag {i}" for i in range(70)]
    emb, usage = siliconflow_embeddings.embed_batch(texts, "BAAI/bge-m3", concurrency=1)
    assert len(emb) == 70
    assert all(len(e) == DIM for e in emb)
    # 默认 batch_size=16 → 4×16 + 6
    assert [len(c["input"]) for c in calls] == [16, 16, 16, 16, 6]


def test_batch_size_capped_at_32(key, monkeypatch):
    urlopen, calls = make_urlopen([{}, {}, {}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    texts = [f"tag {i}" for i in range(70)]
    emb, _ = siliconflow_embeddings.embed_batch(texts, "BAAI/bge-m3",
                                                concurrency=1, batch_size=100)
    assert len(emb) == 70
    assert [len(c["input"]) for c in calls] == [32, 32, 6]


def test_retry_on_429_then_success(key, monkeypatch, no_sleep):
    urlopen, calls = make_urlopen([http_error(429, "rate limited"), {}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    emb, usage = siliconflow_embeddings.embed_batch(["a", "b"], "BAAI/bge-m3",
                                                    concurrency=1, max_retries=5)
    assert len(emb) == 2
    assert len(calls) == 2  # 一次失败 + 一次成功


@pytest.mark.parametrize("code", [503, 504])
def test_retry_on_transient_5xx(key, monkeypatch, no_sleep, code):
    urlopen, calls = make_urlopen([http_error(code, "overloaded"), {}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    emb, _ = siliconflow_embeddings.embed_batch(["a"], "BAAI/bge-m3", concurrency=1)
    assert len(emb) == 1
    assert len(calls) == 2


def test_non_retry_on_400(key, monkeypatch, no_sleep):
    urlopen, calls = make_urlopen([http_error(400, "bad request")])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    with pytest.raises(siliconflow_embeddings.SiliconFlowHTTPError):
        siliconflow_embeddings.embed_batch(["a"], "BAAI/bge-m3", concurrency=1)
    assert len(calls) == 1  # 不重试


def test_key_missing_raises(monkeypatch):
    monkeypatch.delenv("SILICONFLOW_API_KEY", raising=False)
    with pytest.raises(siliconflow_embeddings.SiliconFlowKeyMissing):
        siliconflow_embeddings.embed_batch(["a"], "BAAI/bge-m3", concurrency=1)


def test_response_index_ordering(key, monkeypatch):
    urlopen, calls = make_urlopen([{"shuffle": True}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    texts = ["alpha", "beta", "gamma"]
    emb, _ = siliconflow_embeddings.embed_batch(texts, "BAAI/bge-m3", concurrency=1)
    for i, t in enumerate(texts):
        assert np.allclose(np.asarray(emb[i], dtype=np.float32),
                           np.asarray(vec_for(t), dtype=np.float32))


def test_response_count_mismatch_rejects(key, monkeypatch):
    urlopen, calls = make_urlopen([{"drop": True}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    with pytest.raises(siliconflow_embeddings.SiliconFlowResponseError):
        siliconflow_embeddings.embed_batch(["a", "b"], "BAAI/bge-m3", concurrency=1)


def test_dim_mismatch_rejects(key, monkeypatch):
    urlopen, calls = make_urlopen([{"dim": 512}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    with pytest.raises(siliconflow_embeddings.SiliconFlowResponseError):
        siliconflow_embeddings.embed_batch(["a"], "BAAI/bge-m3", concurrency=1)


# ---------------------------------------------------------------- cache --- #
def test_cache_hit_and_miss(tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    texts = ["tag one", "tag two"]
    cache.put_batch(texts, "m", [vec_for(t) for t in texts], "v1")
    hits, miss = cache.get_cached(["tag one", "tag three"], "m", "v1")
    assert hits[0] is not None
    assert hits[1] is None
    assert miss == [1]


def test_cache_roundtrip_and_load_all(tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    texts = ["x", "y", "z"]
    cache.put_batch(texts, "m", [vec_for(t) for t in texts], "v1")
    loaded_texts, matrix = cache.load_all_vectors("m", "v1")
    # 顺序由 input_hash 决定（确定性），但 texts 与 matrix 行严格对齐。
    assert sorted(loaded_texts) == ["x", "y", "z"]
    assert matrix.shape == (3, DIM)
    assert matrix.dtype == np.float32
    by_text = dict(zip(loaded_texts, matrix))
    for t in texts:
        assert np.allclose(np.asarray(by_text[t]),
                           np.asarray(vec_for(t), dtype=np.float32))


def test_cache_key_changes_with_pipeline_version(tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    cache.put_batch(["x"], "m", [vec_for("x")], "v1")
    hits, miss = cache.get_cached(["x"], "m", "v2")
    assert hits == [None]
    assert miss == [0]


def test_cache_hit_avoids_api(key, monkeypatch, tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    cache.put_batch(["x", "y"], "m", [vec_for(t) for t in ["x", "y"]], "v1")
    monkeypatch.setattr(
        siliconflow_embeddings.urllib.request, "urlopen",
        lambda req, timeout=None: pytest.fail("API should not be called"),
    )
    args = SimpleNamespace(pipeline_version="v1", request_concurrency=1, batch_size=16)
    stats = build.StatsCollector()
    vectors, _ = build.embed_texts_cached(["x", "y"], "m", cache, args, stats)
    assert len(vectors) == 2
    assert stats.attempts == 0


def test_cache_miss_calls_api(key, monkeypatch, tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    urlopen, calls = make_urlopen([{}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    args = SimpleNamespace(pipeline_version="v1", request_concurrency=1, batch_size=16)
    stats = build.StatsCollector()
    vectors, _ = build.embed_texts_cached(["x", "y"], "m", cache, args, stats)
    assert len(vectors) == 2
    assert len(calls) == 1
    assert stats.attempts == 1
    _, miss = cache.get_cached(["x", "y"], "m", "v1")
    assert miss == []


def test_resume_only_requests_misses(key, monkeypatch, tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    cache.put_batch(["a", "b"], "m", [vec_for(t) for t in ["a", "b"]], "v1")
    urlopen, calls = make_urlopen([{}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    args = SimpleNamespace(pipeline_version="v1", request_concurrency=1, batch_size=16)
    stats = build.StatsCollector()
    build.embed_texts_cached(["a", "b", "c", "d"], "m", cache, args, stats)
    assert len(calls) == 1
    assert calls[0]["input"] == ["c", "d"]


def test_dim_mismatch_no_cache_write(key, monkeypatch, tmp_path):
    cache = EmbeddingCache(tmp_path / "c.sqlite")
    urlopen, calls = make_urlopen([{"dim": 512}])
    monkeypatch.setattr(siliconflow_embeddings.urllib.request, "urlopen", urlopen)
    args = SimpleNamespace(pipeline_version="v1", request_concurrency=1, batch_size=16)
    stats = build.StatsCollector()
    with pytest.raises(siliconflow_embeddings.SiliconFlowResponseError):
        build.embed_texts_cached(["x"], "m", cache, args, stats)
    assert cache.count("m", "v1") == 0


# ----------------------------------------------------------- enrichment --- #
def test_enhanced_text_full_and_deterministic():
    fn = lambda: tag_enrichment.build_enhanced_text(
        "blue eyes", zh="蓝眼睛", aliases=["aqua eyes"], section="appearance",
        taxonomy="眼睛颜色/眼部",
    )
    assert fn() == fn()
    assert fn() == ("blue eyes | zh: 蓝眼睛 | aliases: aqua eyes | "
                    "section: appearance | taxonomy: 眼睛颜色/眼部")


def test_enhanced_text_field_omission():
    assert tag_enrichment.build_enhanced_text("solo") == "solo"
    assert tag_enrichment.build_enhanced_text("solo", zh="单人") == "solo | zh: 单人"
    assert tag_enrichment.build_enhanced_text("solo", aliases=[]) == "solo"
    assert tag_enrichment.build_enhanced_text("solo", aliases=["one"]) == "solo | aliases: one"


# ------------------------------------------------------------ slots --- #
def test_slot_assign_unambiguous():
    slot_vectors = {"char_eyes": np.array([1.0, 0.0]), "char_hair": np.array([0.0, 1.0])}
    node, score, src = semantic_slots.assign_slot(np.array([0.99, 0.14]), slot_vectors)
    assert node == "char_eyes"
    assert src == "embedding"


def test_slot_assign_ambiguous_low_similarity():
    slot_vectors = {"a": np.array([1.0, 0.0]), "b": np.array([0.0, 1.0])}
    node, score, src = semantic_slots.assign_slot(np.array([-1.0, 0.0]), slot_vectors)
    assert node is None
    assert src == "embedding_ambiguous"


def test_slot_assign_ambiguous_low_margin():
    slot_vectors = {"a": np.array([1.0, 0.0]), "b": np.array([0.0, 1.0])}
    # 与 a/b 等距 → margin≈0 → ambiguous
    node, score, src = semantic_slots.assign_slot(np.array([0.7071, 0.7071]), slot_vectors)
    assert src == "embedding_ambiguous"


def test_node_to_family_mapping():
    slots = [
        {"node_id": "env_indoor", "family": "scene"},
        {"node_id": "char_eyes", "family": "eyes"},
    ]
    assert semantic_slots.node_to_family(slots) == {"env_indoor": "scene", "char_eyes": "eyes"}


# ---------------------------------------------------------- neighbors --- #
def test_neighbor_topk_excludes_self():
    matrix = np.array([
        [1.0, 0.0],
        [0.9, 0.1],
        [0.0, 1.0],
    ], dtype=np.float32)
    keys = ["a", "b", "c"]
    neighbors = build.compute_neighbors(matrix, keys, k=2)
    for k in keys:
        assert k not in [d for d, _ in neighbors[k]]
    assert len(neighbors["a"]) == 2


def test_relation_type_classification():
    parent_map = {
        "char_eyes": "char_appearance", "char_hair": "char_appearance",
        "env_indoor": "base_environment", "env_outdoor": "base_environment",
    }
    assert build.classify_relation("char_eyes", "char_eyes", parent_map) == "same_slot"
    assert build.classify_relation("char_eyes", "char_hair", parent_map) == "same_parent"
    assert build.classify_relation("char_eyes", "env_indoor", parent_map) == "cross_slot"
    assert build.classify_relation("unknown", "char_eyes", parent_map) == "unknown"


def test_taxonomy_l1_mapping_known():
    assert tag_enrichment.TAXONOMY_L1_TO_NODE["眼睛颜色"] == "char_eyes"
    assert tag_enrichment.TAXONOMY_L1_TO_NODE["光照"] == "base_lighting"


# ---------------------------------------------------- node decision (§27) --- #
def test_resolve_node_source_priority():
    slot_vectors = {
        "char_eyes": np.array([1.0, 0.0], dtype=np.float32),
        "char_hair": np.array([0.0, 1.0], dtype=np.float32),
    }
    seed_map = {"blue eyes": "char_eyes"}
    adult_set = set()
    eyes_vec = np.array([0.99, 0.01], dtype=np.float32)
    tie_vec = np.array([0.7071, 0.7071], dtype=np.float32)

    # 1. manual（tag_section_override）压过 seed / taxonomy
    meta = {"taxonomy_l1": "眼睛颜色", "category": 0, "section": "composition"}
    node, conf, src, escore, safety = build.resolve_node(
        "blue eyes", meta, eyes_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert (node, src, conf) == ("base_composition", "manual", 0.95)

    # 2. seed 压过 taxonomy
    meta = {"taxonomy_l1": "眼睛颜色", "category": 0, "section": None}
    node, conf, src, _, _ = build.resolve_node(
        "blue eyes", meta, eyes_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert (node, src, conf) == ("char_eyes", "seed", 0.90)

    # 3. taxonomy 压过 category
    meta = {"taxonomy_l1": "眼睛颜色", "category": 4, "section": None}
    node, conf, src, _, _ = build.resolve_node(
        "green eyes", meta, eyes_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert (node, src, conf) == ("char_eyes", "taxonomy", 0.85)

    # 4. category → char_identity
    meta = {"taxonomy_l1": None, "category": 4, "section": None}
    node, conf, src, _, _ = build.resolve_node(
        "hatsune miku", meta, tie_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert (node, src, conf) == ("char_identity", "category", 0.75)

    # 5. embedding（无更强来源，且非歧义）
    meta = {"taxonomy_l1": None, "category": 0, "section": None}
    node, conf, src, escore, _ = build.resolve_node(
        "green eyes", meta, eyes_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert (node, src, conf) == ("char_eyes", "embedding", 0.60)
    assert escore is not None

    # 6. unknown fallback（embedding 歧义且无任何确定性来源）
    meta = {"taxonomy_l1": None, "category": 0, "section": None}
    node, conf, src, escore, _ = build.resolve_node(
        "weird", meta, tie_vec, slot_vectors, seed_map, adult_set, 0.35, 0.03)
    assert node == "unknown"
    assert src == "unknown"


def test_load_navigation_prefers_deepest_seed():
    seed_map, parent_map = build.load_navigation()
    # 同一 tag 出现在父/子多节点时，取更深（更具体）的节点
    assert seed_map["blue eyes"] == "char_eyes"        # 而非 char_appearance
    assert seed_map["long hair"] == "char_hair"        # 而非 char_appearance
    assert seed_map["masterpiece"] == "base_style"
    assert seed_map["1girl"] == "char_identity"
    # 父节点仍保留
    assert "char_appearance" in parent_map.values()


def test_retain_tags_keeps_low_post_count_quality():
    conn = build.db.get_conn()
    try:
        keys = [k for k, _ in tag_enrichment.iter_canonical_tags(
            conn, retain_tags={"masterpiece", "best quality"})]
    finally:
        conn.close()
    # post_count=0 的画质标签仍被保留（§ REPO FACTS：retain masterpiece 等）
    assert "masterpiece" in keys
    assert "best quality" in keys
    # 高热度标签仍保留
    assert "1girl" in keys
    assert "solo" in keys


# ------------------------------------------------------------ prior runtime --- #
# § embedding standalone artifact：tag_semantic_node 存在但 prior_tag_assoc（NPMI 表）
# 缺失或为空时，semantic_node_for_tag() 仍应直接查询 tag_semantic_node 并返回节点
# （回归：is_available() 由 prior_tag_assoc 驱动，曾被误用于抑制对本表的读取）。
def _make_embedding_only_db(path):
    import sqlite3

    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE tag_semantic_node (
            tag TEXT PRIMARY KEY,
            node_id TEXT,
            confidence REAL,
            rule_source TEXT,
            embedding_score REAL,
            model_id TEXT,
            model_revision TEXT,
            safety_scope TEXT
        );
        INSERT INTO tag_semantic_node
            (tag, node_id, confidence, rule_source, embedding_score, safety_scope)
        VALUES ('blue eyes', 'char_eyes', 0.6, 'embedding', 0.92, 'general');
        """
    )
    conn.commit()
    conn.close()


def test_embedding_prior_standalone_no_assoc_table(tmp_path):
    # prior_tag_assoc 完全缺失 → is_available()=False，但 tag_semantic_node 仍可读
    from prompt import prior as prior_mod

    db_path = tmp_path / "embedding_only.sqlite"
    _make_embedding_only_db(db_path)
    p = prior_mod.PromptPrior(str(db_path))
    assert p.is_available() is False
    assert p.semantic_node_for_tag("blue eyes") == "char_eyes"


def test_embedding_prior_standalone_empty_assoc_table(tmp_path):
    # prior_tag_assoc 存在但为空 → is_available()=False，语义节点仍应可见
    from prompt import prior as prior_mod

    db_path = tmp_path / "embedding_empty.sqlite"
    _make_embedding_only_db(db_path)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        "CREATE TABLE prior_tag_assoc (tag_a TEXT, tag_b TEXT, npmi REAL, "
        "support INTEGER, quality_weight REAL, is_adult INTEGER);"
    )
    conn.commit()
    conn.close()
    p = prior_mod.PromptPrior(str(db_path))
    assert p.is_available() is False
    assert p.semantic_node_for_tag("blue eyes") == "char_eyes"
    # 未命中标签与空 key 仍优雅返回 None
    assert p.semantic_node_for_tag("missing tag") is None
    assert p.semantic_node_for_tag("") is None


def test_embedding_prior_standalone_missing_db_still_none(tmp_path):
    # 库完全缺失 → 仍返回 None（优雅降级不被破坏）
    from prompt import prior as prior_mod

    missing = tmp_path / "nope.sqlite"
    p = prior_mod.PromptPrior(str(missing))
    assert p.semantic_node_for_tag("blue eyes") is None
    assert p.semantic_node_for_tag("missing tag") is None
