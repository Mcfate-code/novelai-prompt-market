"""Phase 1：统一离线先验 schema 与构建器所有权（§1.1–§1.10）。

全部使用内存/临时 sqlite，绝不发起 SiliconFlow API 调用。覆盖 6 个命名用例：
  - public_then_embedding
  - embedding_then_public
  - manifest_has_both_sources
  - semantic_node_contract_is_single
  - embedding_rebuild_preserves_npmi
  - public_rebuild_preserves_semantic_neighbors

另附旧 schema 迁移（ALTER 只增列 / RENAME 重建）与「Copyright ≠ Character」回归。
"""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import prompt.prior_build as prior_build
from prompt.prior_schema import (  # noqa: E402
    ensure_prior_schema,
    schema_hash,
    upsert_semantic_node,
    write_manifest_row,
)

ALL_TABLES = [
    "prior_tag_assoc",
    "prior_slot_tag",
    "prior_context_tag",
    "prior_slot_transition",
    "tag_semantic_node",
    "prior_semantic_neighbor",
    "prior_manifest",
]

NAV = {
    "schema_version": 1,
    "base": {
        "id": "base", "label": "Base", "section": "scene", "seed_tags": [], "children": [
            {"id": "base_style", "label": "Style", "section": "style",
             "seed_tags": ["masterpiece"], "children": []},
        ],
    },
    "character": {
        "id": "character", "label": "Character", "section": "character", "seed_tags": [],
        "children": [
            {"id": "char_identity", "label": "Identity", "section": "character",
             "seed_tags": ["solo"], "children": []},
            {"id": "char_appearance", "label": "Appearance", "section": "appearance",
             "seed_tags": ["long hair", "blue eyes"], "children": []},
        ],
    },
}

TAG_ROWS = [
    ("blue_eyes", "blue eyes", 0, 700),
    ("long_hair", "long hair", 0, 800),
    ("solo", "solo", 0, 900),
    ("masterpiece", "masterpiece", 0, 1000),
    ("genshin_impact", "genshin impact", 3, 600),   # Copyright → 绝非身份
    ("hatsune_miku", "hatsune miku", 4, 500),        # Character → char_identity
]


def _make_tags_db(path: Path) -> None:
    conn = sqlite3.connect(str(path))
    conn.executescript(
        "CREATE TABLE tags (id INTEGER PRIMARY KEY, danbooru_name TEXT, prompt_tag TEXT, "
        "category INTEGER, post_count INTEGER, is_deprecated INTEGER DEFAULT 0, "
        "source TEXT DEFAULT 'danbooru');"
    )
    conn.executemany(
        "INSERT INTO tags (danbooru_name, prompt_tag, category, post_count) "
        "VALUES (?,?,?,?)",
        TAG_ROWS,
    )
    conn.commit()
    conn.close()


def _make_nsfw(path: Path) -> None:
    path.write_text(json.dumps({"categories": []}, ensure_ascii=False), encoding="utf-8")


def _make_nav(path: Path) -> None:
    path.write_text(json.dumps(NAV, ensure_ascii=False), encoding="utf-8")


def run_public(out: Path) -> Path:
    """跑一次真实的公共先验构建（本地回退，无 HF）。"""
    tmp = Path(tempfile.mkdtemp())
    tags_db = tmp / "tags.sqlite"
    nsfw = tmp / "nsfw.json"
    nav = tmp / "nav.json"
    _make_tags_db(tags_db)
    _make_nsfw(nsfw)
    _make_nav(nav)
    prior_build.build(
        out, use_hf=False, quiet=True,
        tags_db_path=tags_db, nsfw_path=nsfw, nav_path=nav,
    )
    return out


def run_embedding(out: Path, nodes: dict | None = None, neighbors=None) -> Path:
    """模拟 embedding 构建器写库路径（走共享 schema/upsert，不发 API）。"""
    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row
    try:
        ensure_prior_schema(conn)
        # embedding 独占表快照重建（绝不 DELETE tag_semantic_node / 公共表）
        conn.execute("DELETE FROM prior_semantic_neighbor")
        for src, dst, sim in (neighbors or []):
            conn.execute(
                "INSERT OR REPLACE INTO prior_semantic_neighbor "
                "(src_tag, dst_tag, similarity, src_node, dst_node, relation_type, "
                "safety_scope, model_id, model_revision) VALUES (?,?,?,?,?,?,?,?,?)",
                (src, dst, sim, None, None, "cross_slot", "general",
                 "BAAI/bge-m3", "provider-managed/unavailable"),
            )
        for tag, spec in (nodes or {}).items():
            upsert_semantic_node(
                conn, tag,
                node_id=spec.get("node_id"),
                confidence=spec.get("confidence"),
                rule_source=spec.get("rule_source"),
                embedding_score=spec.get("embedding_score"),
                model_id="BAAI/bge-m3",
                model_revision="provider-managed/unavailable",
                safety_scope=spec.get("safety_scope", "general"),
            )
        write_manifest_row(
            conn,
            source_id="siliconflow-embedding",
            source_type="embedding",
            revision="provider-managed/unavailable",
            license="danbooru tag corpus; SiliconFlow embedding model (build-time only)",
            retrieved_at="2026-01-01T00:00:00Z",
            pipeline_version="sf-emb-v1",
            schema_hash=schema_hash(),
            metadata_json=json.dumps({"tag_count": len(nodes or {})}, ensure_ascii=False),
        )
        conn.commit()
    finally:
        conn.close()
    return out


def _tables(conn) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def _manifest_pairs(conn) -> set[tuple[str, str]]:
    return {(r[0], r[1]) for r in conn.execute(
        "SELECT source_id, source_type FROM prior_manifest")}


# --------------------------------------------------------------------------- #
# 6 个命名用例
# --------------------------------------------------------------------------- #
def test_public_then_embedding(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_public(out)
    run_embedding(out, nodes={
        "green eyes": {"node_id": "char_eyes", "confidence": 0.6,
                       "rule_source": "embedding", "embedding_score": 0.9},
        "blue eyes": {"node_id": "char_appearance", "confidence": 0.9,
                      "rule_source": "seed", "embedding_score": 0.85},
    })
    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row
    try:
        # 7 张表齐全
        assert ALL_TABLES and _tables(conn) >= set(ALL_TABLES)
        # 公共证据保留：blue eyes 仍为 nav_seed → char_appearance
        row = conn.execute(
            "SELECT node_id, rule_source, confidence, embedding_score "
            "FROM tag_semantic_node WHERE tag='blue eyes'"
        ).fetchone()
        assert row["rule_source"] == "nav_seed"
        assert row["node_id"] == "char_appearance"
        assert row["confidence"] == 1.0
        # embedding 补充了 embedding_score（不覆盖更高优先级 node/rule_source）
        assert abs(row["embedding_score"] - 0.85) < 1e-9
        # embedding 新增行带 embedding_score
        green = conn.execute(
            "SELECT node_id, rule_source, embedding_score FROM tag_semantic_node "
            "WHERE tag='green eyes'"
        ).fetchone()
        assert green is not None
        assert green["embedding_score"] == 0.9
        # embedding 来源的 manifest 行存在
        assert ("siliconflow-embedding", "embedding") in _manifest_pairs(conn)
    finally:
        conn.close()


def test_embedding_then_public(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_embedding(out, nodes={
        "solo": {"node_id": "char_identity", "confidence": 0.6,
                 "rule_source": "embedding", "embedding_score": 0.5},
    }, neighbors=[("solo", "1girl", 0.8)])
    run_public(out)
    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row
    try:
        assert _tables(conn) >= set(ALL_TABLES)
        # 语义近邻保留
        n_nei = conn.execute("SELECT COUNT(*) FROM prior_semantic_neighbor").fetchone()[0]
        assert n_nei == 1
        # 公共构建后 solo 被更高优先级的 nav_seed 覆盖
        row = conn.execute(
            "SELECT node_id, rule_source, confidence FROM tag_semantic_node WHERE tag='solo'"
        ).fetchone()
        assert row["rule_source"] == "nav_seed"
        assert row["node_id"] == "char_identity"
    finally:
        conn.close()


def test_manifest_has_both_sources(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_public(out)
    run_embedding(out)
    conn = sqlite3.connect(str(out))
    try:
        pairs = _manifest_pairs(conn)
        assert ("public-corpus", "public") in pairs
        assert ("siliconflow-embedding", "embedding") in pairs
    finally:
        conn.close()


def test_semantic_node_contract_is_single(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_public(out)
    conn = sqlite3.connect(str(out))
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tag_semantic_node)")}
        assert "node_id" in cols
        assert "tag" in cols
        # 每个 tag 恰一行（PK 约束）
        dup = conn.execute(
            "SELECT tag, COUNT(*) c FROM tag_semantic_node GROUP BY tag HAVING c > 1"
        ).fetchall()
        assert dup == []
    finally:
        conn.close()


def test_embedding_rebuild_preserves_npmi(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_public(out)
    conn = sqlite3.connect(str(out))
    before = conn.execute("SELECT COUNT(*) FROM prior_tag_assoc").fetchone()[0]
    conn.close()
    assert before > 0
    run_embedding(out)
    run_embedding(out)  # 再次重建 embedding
    conn = sqlite3.connect(str(out))
    after = conn.execute("SELECT COUNT(*) FROM prior_tag_assoc").fetchone()[0]
    conn.close()
    assert after == before


def test_public_rebuild_preserves_semantic_neighbors(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_embedding(out, neighbors=[("blue eyes", "green eyes", 0.8)])
    run_public(out)
    run_public(out)  # 再次重建公共
    conn = sqlite3.connect(str(out))
    n = conn.execute("SELECT COUNT(*) FROM prior_semantic_neighbor").fetchone()[0]
    conn.close()
    assert n == 1


# --------------------------------------------------------------------------- #
# 迁移（只增列 / RENAME 重建，绝不 DROP）
# --------------------------------------------------------------------------- #
def test_migrate_legacy_embedding_tables(tmp_path):
    db_path = tmp_path / "legacy.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
    CREATE TABLE tag_semantic_node (
        tag TEXT PRIMARY KEY, node_id TEXT, confidence REAL, rule_source TEXT,
        embedding_score REAL, model_id TEXT, model_revision TEXT, safety_scope TEXT
    );
    INSERT INTO tag_semantic_node
        (tag, node_id, confidence, rule_source, embedding_score, safety_scope)
        VALUES ('blue eyes', 'char_eyes', 0.6, 'embedding', 0.92, 'general');
    CREATE TABLE prior_manifest (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO prior_manifest (key, value) VALUES ('pipeline_version', 'sf-emb-v1');
    """)
    conn.commit()
    conn.close()

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    ensure_prior_schema(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tag_semantic_node)")}
    assert "taxonomy_source" in cols
    assert "updated_at" in cols
    row = conn.execute(
        "SELECT node_id, rule_source, embedding_score FROM tag_semantic_node "
        "WHERE tag='blue eyes'"
    ).fetchone()
    assert row["node_id"] == "char_eyes"
    assert row["rule_source"] == "embedding"
    assert abs(row["embedding_score"] - 0.92) < 1e-9
    # manifest 从 key/value 迁移为多来源行，且旧表数据未丢
    assert ("siliconflow-embedding", "embedding") in _manifest_pairs(conn)
    assert "_prior_manifest_legacy" in _tables(conn)
    conn.close()


def test_migrate_legacy_public_tag_semantic_node(tmp_path):
    db_path = tmp_path / "legacy_public.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
    CREATE TABLE tag_semantic_node (
        tag TEXT PRIMARY KEY, semantic_node_id TEXT, confidence REAL, source TEXT
    );
    INSERT INTO tag_semantic_node (tag, semantic_node_id, confidence, source)
        VALUES ('solo', 'char_identity', 1.0, 'nav_seed');
    """)
    conn.commit()
    conn.close()

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    ensure_prior_schema(conn)
    row = conn.execute(
        "SELECT node_id, rule_source FROM tag_semantic_node WHERE tag='solo'"
    ).fetchone()
    # semantic_node_id/source 被复制到 node_id/rule_source（旧列保留，不删）
    assert row["node_id"] == "char_identity"
    assert row["rule_source"] == "nav_seed"
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tag_semantic_node)")}
    assert "semantic_node_id" in cols  # 旧列仍在（只增不删）
    assert "taxonomy_source" in cols
    conn.close()


# --------------------------------------------------------------------------- #
# Copyright ≠ Character（§1.5）
# --------------------------------------------------------------------------- #
def test_public_copyright_not_identity(tmp_path):
    out = tmp_path / "prior.sqlite"
    run_public(out)
    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT node_id, rule_source FROM tag_semantic_node WHERE tag='genshin impact'"
        ).fetchone()
        # 无 copyright/franchise 槽位 → 支持性上下文，绝不落身份节点
        assert row is None or row["node_id"] != "char_identity"
    finally:
        conn.close()


def test_embedding_resolve_copyright_not_identity():
    import numpy as np

    import scripts.build_embedding_prior as build

    slot_vectors = {
        "char_identity": np.array([1.0, 0.0], dtype=np.float32),
        "env_outdoor": np.array([0.0, 1.0], dtype=np.float32),
    }
    meta = {"taxonomy_l1": None, "category": 3, "section": None}
    node, conf, src, escore, safety = build.resolve_node(
        "genshin impact", meta, np.array([0.9, 0.1], dtype=np.float32),
        slot_vectors, {}, set(), 0.35, 0.03,
    )
    assert node != "char_identity"
    assert src == "copyright"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
