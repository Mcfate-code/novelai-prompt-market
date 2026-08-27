"""构建期持久化 embedding 缓存。

向量以 numpy float32 序列化为 BLOB 存于 ``.build-cache/embedding-cache.sqlite``。
原始向量只允许存在于本缓存（§53 —— 绝不写入最终制品 data/offline_prompt_prior.sqlite）。

缓存键：SHA256(model_id + "\\x1f" + normalized_input_text + "\\x1f" + pipeline_version)，
其中 normalized_input_text 即「实际发给 API 的文本」strip 后的结果（§16）。
"""
from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path

import numpy as np

SEP = "\x1f"

DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent.parent / ".build-cache"
DEFAULT_CACHE_PATH = DEFAULT_CACHE_DIR / "embedding-cache.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS embedding_cache (
    input_hash TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    input_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dim INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    pipeline_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ec_model ON embedding_cache(model_id, pipeline_version);
"""


def cache_key(model_id: str, normalized_text: str, pipeline_version: str) -> str:
    """normalized_text 应为 strip 后的实际发送文本。"""
    raw = SEP.join([model_id, normalized_text, str(pipeline_version)])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_input(text: str) -> str:
    return str(text or "").strip()


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.executescript(SCHEMA)
    return conn


def _serialize(vector) -> bytes:
    return np.asarray(vector, dtype=np.float32).tobytes()


def _deserialize(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


class EmbeddingCache:
    """SQLite 持久缓存（构建期专用）。"""

    def __init__(self, path=None):
        self.path = Path(path) if path else DEFAULT_CACHE_PATH

    def get_cached(self, texts, model_id, pipeline_version):
        """返回 (hits: list[vector|None], miss_indices: list[int])。

        命中返回 numpy float32 向量；未命中返回 None 且下标进入 miss_indices。
        """
        normalized = [normalize_input(t) for t in texts]
        hashes = [cache_key(model_id, t, pipeline_version) for t in normalized]
        conn = _connect(self.path)
        try:
            found = {}
            for h in hashes:
                row = conn.execute(
                    "SELECT embedding, dim FROM embedding_cache WHERE input_hash=?",
                    (h,),
                ).fetchone()
                if row is not None:
                    found[h] = _deserialize(bytes(row["embedding"]))
            hits = [found.get(h) for h in hashes]
            miss_indices = [i for i, v in enumerate(hits) if v is None]
            return hits, miss_indices
        finally:
            conn.close()

    def put_batch(self, texts, model_id, vectors, pipeline_version):
        """原子写入整批（单事务），崩溃安全（§47）。"""
        normalized = [normalize_input(t) for t in texts]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        conn = _connect(self.path)
        try:
            conn.execute("BEGIN")
            for text, vec in zip(normalized, vectors):
                arr = np.asarray(vec, dtype=np.float32)
                h = cache_key(model_id, text, pipeline_version)
                conn.execute(
                    "INSERT OR IGNORE INTO embedding_cache "
                    "(input_hash, model_id, input_text, embedding, dim, created_at, pipeline_version) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (h, model_id, text, arr.tobytes(), int(arr.shape[0]), now, pipeline_version),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def load_all_vectors(self, model_id, pipeline_version):
        """返回 (texts: list[str], matrix: np.ndarray float32 [N, dim])，按 input_hash 稳定排序。"""
        conn = _connect(self.path)
        try:
            rows = conn.execute(
                "SELECT input_text, embedding, dim FROM embedding_cache "
                "WHERE model_id=? AND pipeline_version=? ORDER BY input_hash",
                (model_id, pipeline_version),
            ).fetchall()
        finally:
            conn.close()
        if not rows:
            return [], np.zeros((0, 0), dtype=np.float32)
        texts = [r["input_text"] for r in rows]
        matrix = np.vstack([_deserialize(bytes(r["embedding"])) for r in rows]).astype(np.float32)
        return texts, matrix

    def count(self, model_id, pipeline_version):
        conn = _connect(self.path)
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM embedding_cache WHERE model_id=? AND pipeline_version=?",
                (model_id, pipeline_version),
            ).fetchone()
            return int(row["c"]) if row else 0
        finally:
            conn.close()


__all__ = [
    "EmbeddingCache",
    "cache_key",
    "normalize_input",
    "DEFAULT_CACHE_PATH",
]
