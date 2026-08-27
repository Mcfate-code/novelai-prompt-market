"""共享离线先验 schema（单一来源，§1.1）。

两个构建器（``prompt/prior_build.py`` 公共先验、``scripts/build_embedding_prior.py``
Embedding 先验）此前对 ``tag_semantic_node`` / ``prior_manifest`` 存在两套不一致的
建表语句，是发布阻断项。本模块提供唯一的 ``ensure_prior_schema(conn)``：创建 7 张表
并做只增不删（``ALTER TABLE ... ADD COLUMN`` / RENAME+重建迁移）的幂等迁移，绝不
DROP 任何一张表，绝不 DELETE 其它构建器拥有的数据。

所有权约定：
  - 公共先验独占：``prior_tag_assoc`` / ``prior_slot_tag`` / ``prior_context_tag`` /
    ``prior_slot_transition``
  - Embedding 独占：``prior_semantic_neighbor``
  - 共享：``tag_semantic_node``（多来源融合）、``prior_manifest``（多来源共存）

规则源优先级（高者胜，embedding 只补证据、绝不覆盖更高优先级行）：
  ``manual > navigation seed > taxonomy exact > Danbooru character category >
  embedding > fallback``

Danbooru category 语义（§1.5）：category 4 = Character → ``char_identity``；
category 3 = Copyright → 支持性上下文（``copyright``），绝非 ``char_identity``。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

# --------------------------------------------------------------------------- #
# 统一 schema
# --------------------------------------------------------------------------- #
# tag_semantic_node 最终列（embedding 字段可空），node_id 供 prompt/prior.py 读取。
TAG_SEMANTIC_NODE_COLUMNS = (
    "tag", "node_id", "confidence", "rule_source", "embedding_score",
    "model_id", "model_revision", "safety_scope", "taxonomy_source", "updated_at",
)

# 公共先验写出的 rule_source 集合（snapshot 重建时只清自身行，不碰 embedding 行）。
PUBLIC_RULE_SOURCES = ("nav_seed", "category", "sections_rules", "nsfw_taxonomy")

# 规则源优先级（高者胜）。所有公共来源均高于 embedding；embedding 仅作补充证据。
PRIORITY_RANK = {
    "manual": 100,
    "navigation_seed": 95,
    "nav_seed": 95,
    "seed": 95,
    "navigation": 95,
    "taxonomy": 90,
    "taxonomy_exact": 90,
    "category": 80,
    "copyright": 80,
    "sections_rules": 70,
    "section": 70,
    "nsfw_taxonomy": 70,
    "embedding": 60,
    "embedding_ambiguous": 60,
    "unknown": 0,
    "fallback": 0,
}

PRIOR_MANIFEST_DDL = """
CREATE TABLE IF NOT EXISTS prior_manifest (
    source_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    revision TEXT,
    license TEXT,
    retrieved_at TEXT,
    pipeline_version TEXT,
    schema_hash TEXT,
    metadata_json TEXT,
    PRIMARY KEY (source_id, source_type)
);
"""

CREATE_TABLES_SQL = PRIOR_MANIFEST_DDL + """
CREATE TABLE IF NOT EXISTS prior_tag_assoc (
    tag_a TEXT NOT NULL,
    tag_b TEXT NOT NULL,
    npmi REAL NOT NULL DEFAULT 0,
    support INTEGER NOT NULL DEFAULT 0,
    quality_weight REAL NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tag_a, tag_b, is_adult),
    CHECK (tag_a < tag_b)
);
CREATE TABLE IF NOT EXISTS prior_slot_tag (
    semantic_node_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (semantic_node_id, tag, is_adult)
);
CREATE TABLE IF NOT EXISTS prior_context_tag (
    context_tag TEXT NOT NULL,
    related_tag TEXT NOT NULL,
    npmi REAL NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prior_slot_transition (
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_node_id, to_node_id)
);
CREATE TABLE IF NOT EXISTS tag_semantic_node (
    tag TEXT PRIMARY KEY,
    node_id TEXT,
    confidence REAL,
    rule_source TEXT,
    embedding_score REAL,
    model_id TEXT,
    model_revision TEXT,
    safety_scope TEXT,
    taxonomy_source TEXT,
    updated_at TEXT
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
    PRIMARY KEY (src_tag, dst_tag)
);
"""

CREATE_INDEXES_SQL = """
CREATE INDEX IF NOT EXISTS idx_prior_tag_assoc_a ON prior_tag_assoc(tag_a, is_adult);
CREATE INDEX IF NOT EXISTS idx_prior_tag_assoc_b ON prior_tag_assoc(tag_b, is_adult);
CREATE INDEX IF NOT EXISTS idx_prior_slot_node ON prior_slot_tag(semantic_node_id, is_adult);
CREATE INDEX IF NOT EXISTS idx_prior_context ON prior_context_tag(context_tag, is_adult);
CREATE INDEX IF NOT EXISTS idx_tsn_node ON tag_semantic_node(node_id);
CREATE INDEX IF NOT EXISTS idx_tsn_tag ON tag_semantic_node(tag);
CREATE INDEX IF NOT EXISTS idx_psn_src ON prior_semantic_neighbor(src_tag);
CREATE INDEX IF NOT EXISTS idx_psn_srcnode ON prior_semantic_neighbor(src_node);
"""

# 旧 schema → 规范 schema 的缺列补齐（ALTER 用，只增不删）。
TAG_SEMANTIC_NODE_ALTER_TYPES = {
    "node_id": "TEXT",
    "confidence": "REAL",
    "rule_source": "TEXT",
    "embedding_score": "REAL",
    "model_id": "TEXT",
    "model_revision": "TEXT",
    "safety_scope": "TEXT",
    "taxonomy_source": "TEXT",
    "updated_at": "TEXT",
}

# upsert 参数未提供的哨兵（区分「embedding 未提供」与「embedding 显式提供 NULL」）。
_UNSET = object()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def schema_hash() -> str:
    """规范 schema 的短哈希（写入 prior_manifest.schema_hash）。"""
    return hashlib.sha256(CREATE_TABLES_SQL.encode("utf-8")).hexdigest()[:16]


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_missing_columns(conn: sqlite3.Connection, table: str, columns: dict) -> None:
    existing = _table_columns(conn, table)
    for name, typ in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {typ}")


def _migrate_tag_semantic_node(conn: sqlite3.Connection) -> None:
    """把旧 tag_semantic_node 补到规范列（只增列 + 复制旧列，绝不 DROP/DELETE）。"""
    cols = _table_columns(conn, "tag_semantic_node")
    if not cols:
        return
    _add_missing_columns(conn, "tag_semantic_node", TAG_SEMANTIC_NODE_ALTER_TYPES)
    cols = _table_columns(conn, "tag_semantic_node")  # 刷新
    # 旧公共 schema：semantic_node_id/source → node_id/rule_source（保留旧列，只复制）
    if "semantic_node_id" in cols and "node_id" in cols:
        conn.execute(
            "UPDATE tag_semantic_node SET node_id = COALESCE(node_id, semantic_node_id) "
            "WHERE node_id IS NULL AND semantic_node_id IS NOT NULL"
        )
    if "source" in cols and "rule_source" in cols:
        conn.execute(
            "UPDATE tag_semantic_node SET rule_source = COALESCE(rule_source, source) "
            "WHERE rule_source IS NULL AND source IS NOT NULL"
        )


def _migrate_prior_manifest(conn: sqlite3.Connection) -> None:
    """把旧 prior_manifest（key/value 或 source/revision 形状）迁移为多来源共存形状。

    用 RENAME 保留旧数据 + 重建规范表（绝不 DROP）；只把旧行合并成对应来源的一行。
    """
    cols = _table_columns(conn, "prior_manifest")
    if not cols:
        return
    if "source_id" in cols and "source_type" in cols:
        return  # 已是规范形状
    conn.execute("ALTER TABLE prior_manifest RENAME TO _prior_manifest_legacy")
    conn.executescript(PRIOR_MANIFEST_DDL)
    legacy = _table_columns(conn, "_prior_manifest_legacy")
    if "key" in legacy and "value" in legacy:
        rows = conn.execute("SELECT key, value FROM _prior_manifest_legacy").fetchall()
        kv = {row[0]: row[1] for row in rows}
        conn.execute(
            "INSERT INTO prior_manifest (source_id, source_type, revision, license, "
            "retrieved_at, pipeline_version, schema_hash, metadata_json) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                "siliconflow-embedding", "embedding",
                kv.get("embedding_revision"), kv.get("licenses"),
                kv.get("built_at") or _now_iso(), kv.get("pipeline_version"),
                None, json.dumps(kv, ensure_ascii=False),
            ),
        )
    elif "source" in legacy:
        rows = conn.execute("SELECT * FROM _prior_manifest_legacy").fetchall()
        colnames = [d[0] for d in conn.execute("PRAGMA table_info(_prior_manifest_legacy)")]
        for row in rows:
            d = dict(zip(colnames, row))
            meta = {k: d[k] for k in ("tag_count", "pair_count") if d.get(k) is not None}
            conn.execute(
                "INSERT INTO prior_manifest (source_id, source_type, revision, license, "
                "retrieved_at, pipeline_version, schema_hash, metadata_json) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    "public-corpus", "public",
                    d.get("revision"), d.get("license"),
                    d.get("retrieved_at") or _now_iso(),
                    d.get("pipeline_version"), d.get("schema_hash"),
                    json.dumps(meta, ensure_ascii=False) if meta else None,
                ),
            )


def ensure_prior_schema(conn: sqlite3.Connection) -> None:
    """创建 7 张先验表 + 幂等迁移（§1.1/§1.6/§1.7）。两个构建器都必须调用。"""
    conn.executescript(CREATE_TABLES_SQL)
    _migrate_tag_semantic_node(conn)
    _migrate_prior_manifest(conn)
    conn.executescript(CREATE_INDEXES_SQL)
    conn.commit()


def upsert_semantic_node(
    conn: sqlite3.Connection,
    tag: str,
    *,
    node_id: str | None = None,
    confidence: float | None = None,
    rule_source: str | None = None,
    embedding_score: float | None = _UNSET,
    model_id: str | None = _UNSET,
    model_revision: str | None = _UNSET,
    safety_scope: str | None = None,
    taxonomy_source: str | None = None,
    updated_at: str | None = None,
) -> None:
    """按 tag 合并 upsert（§1.3）。

    仅当新行 ``rule_source`` 优先级高于已存在行（或无行存在）时才覆盖
    ``node_id``/``confidence``/``rule_source``；embedding 证据列
    （``embedding_score``/``model_id``/``model_revision``）由 embedding 构建器
    显式提供时才写入（可为 NULL，表示未嵌入），绝不抹除 navigation/taxonomy/
    category/section 更高优先级证据。
    """
    updated_at = updated_at or _now_iso()
    rank = PRIORITY_RANK.get(rule_source or "", 0)
    emb_score = None if embedding_score is _UNSET else embedding_score
    emb_model = None if model_id is _UNSET else model_id
    emb_rev = None if model_revision is _UNSET else model_revision
    provides_embedding = embedding_score is not _UNSET or model_id is not _UNSET

    row = conn.execute(
        "SELECT rule_source FROM tag_semantic_node WHERE tag=?", (tag,)
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO tag_semantic_node (tag, node_id, confidence, rule_source, "
            "embedding_score, model_id, model_revision, safety_scope, taxonomy_source, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (tag, node_id, confidence, rule_source, emb_score, emb_model, emb_rev,
             safety_scope, taxonomy_source, updated_at),
        )
        return

    existing_source = row[0]
    existing_rank = PRIORITY_RANK.get(existing_source or "", 0)
    if rank > existing_rank:
        conn.execute(
            "UPDATE tag_semantic_node SET node_id=?, confidence=?, rule_source=?, "
            "taxonomy_source=?, updated_at=? WHERE tag=?",
            (node_id, confidence, rule_source, taxonomy_source, updated_at, tag),
        )
    if provides_embedding:
        conn.execute(
            "UPDATE tag_semantic_node SET embedding_score=?, model_id=?, "
            "model_revision=?, updated_at=? WHERE tag=?",
            (emb_score, emb_model, emb_rev, updated_at, tag),
        )


def write_manifest_row(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    source_type: str,
    revision: str | None = None,
    license: str | None = None,
    retrieved_at: str | None = None,
    pipeline_version: str | None = None,
    schema_hash: str | None = None,
    metadata_json: str | None = None,
) -> None:
    """写入 / 覆盖某个来源的 prior_manifest 行（§1.4，多来源共存）。"""
    conn.execute(
        "INSERT INTO prior_manifest (source_id, source_type, revision, license, "
        "retrieved_at, pipeline_version, schema_hash, metadata_json) "
        "VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(source_id, source_type) DO UPDATE SET "
        "revision=excluded.revision, license=excluded.license, "
        "retrieved_at=excluded.retrieved_at, pipeline_version=excluded.pipeline_version, "
        "schema_hash=excluded.schema_hash, metadata_json=excluded.metadata_json",
        (source_id, source_type, revision, license, retrieved_at or _now_iso(),
         pipeline_version, schema_hash, metadata_json),
    )


__all__ = [
    "ensure_prior_schema",
    "upsert_semantic_node",
    "write_manifest_row",
    "schema_hash",
    "PRIORITY_RANK",
    "PUBLIC_RULE_SOURCES",
    "TAG_SEMANTIC_NODE_COLUMNS",
]
