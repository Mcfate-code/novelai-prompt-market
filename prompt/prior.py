"""Offline Prompt Prior 运行时（只读、零重型依赖）。

只从 data/offline_prompt_prior.sqlite 读取预计算的 NPMI 关联 / 语义槽位 / 槽位转移先验。
运行时不依赖 HuggingFace datasets / PyArrow / Polars；先验库不存在时优雅降级为空模式
（返回空列表，is_available()=False）。安全过滤（青少年模式 / 受限标签）由上层 serving
层负责，本模块不内置任何 tag 黑名单。

并行扩展（SiliconFlow Embedding Prior）约定：
  本模块刻意不实现 ``semantic_neighbors()`` / ``semantic_node()``（embedding 版本），
  这两个方法由并行任务后续添加。它们应：
    - 读取同一 data/offline_prompt_prior.sqlite 中并行任务自建的
      ``prior_semantic_neighbor`` 表；
    - 在表缺失时优雅降级（catch sqlite3.OperationalError，返回空）；
    - 与这里的 ``semantic_node_for_tag()``（离线 taxonomy/nav 版本）并存，
      二者都从 ``tag_semantic_node`` 表读取节点映射。
  PromptPrior 类结构保持简洁、可追加方法，不引入任何冲突。
"""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PRIOR_PATH = BASE_DIR / "data" / "offline_prompt_prior.sqlite"


def _norm(tag: str) -> str:
    return " ".join(str(tag or "").strip().lower().replace("_", " ").split())


class PromptPrior:
    """只读离线先验访问层。

    所有方法在数据库缺失 / 表缺失时返回空（或 None），绝不抛错。
    """

    def __init__(self, db_path=None):
        self.db_path = Path(db_path) if db_path else DEFAULT_PRIOR_PATH
        self._lock = threading.Lock()
        self._available: bool | None = None

    def _conn(self) -> sqlite3.Connection | None:
        if not self.db_path.is_file():
            return None
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.Error:
            return None

    def _fetch(self, sql: str, params=()) -> list[sqlite3.Row]:
        """执行只读查询；文件/表/列缺失或其它 SQLite 错误一律返回空列表。"""
        conn = self._conn()
        if conn is None:
            return []
        try:
            return list(conn.execute(sql, params).fetchall())
        except sqlite3.Error:
            return []
        finally:
            conn.close()

    def _fetchone(self, sql: str, params=()) -> sqlite3.Row | None:
        conn = self._conn()
        if conn is None:
            return None
        try:
            return conn.execute(sql, params).fetchone()
        except sqlite3.Error:
            return None
        finally:
            conn.close()

    def is_available(self) -> bool:
        """先验库存在且含关联数据时为 True。"""
        if self._available is not None:
            return self._available
        row = self._fetchone("SELECT COUNT(*) AS c FROM prior_tag_assoc")
        self._available = bool(row and row["c"] > 0)
        return self._available

    def _adult_clause(self, adult: bool) -> str:
        return "" if adult else "AND is_adult = 0"

    def related_tags(self, tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
        """返回与 tag 的 NPMI 关联标签（adult=False 只返回一般向 is_adult=0）。"""
        if not self.is_available():
            return []
        key = _norm(tag)
        if not key:
            return []
        limit = max(0, int(limit))
        rows = self._fetch(
            f"SELECT tag_a, tag_b, npmi, support, quality_weight, is_adult "
            f"FROM prior_tag_assoc WHERE (tag_a=? OR tag_b=?) {self._adult_clause(adult)} "
            f"ORDER BY npmi DESC LIMIT ?",
            (key, key, limit),
        )
        out = []
        for row in rows:
            other = row["tag_b"] if row["tag_a"] == key else row["tag_a"]
            out.append({
                "tag": other,
                "npmi": float(row["npmi"]),
                "support": int(row["support"] or 0),
                "quality_weight": float(row["quality_weight"] or 0),
                "is_adult": int(row["is_adult"]),
            })
        return out

    def slot_candidates(self, node_id: str, limit: int = 64, adult: bool = False) -> list[dict]:
        """返回某语义槽位节点的候选标签（按频率降序）。"""
        if not self.is_available():
            return []
        node_id = (node_id or "").strip()
        if not node_id:
            return []
        limit = max(0, int(limit))
        rows = self._fetch(
            f"SELECT tag, frequency, is_adult FROM prior_slot_tag "
            f"WHERE semantic_node_id=? {self._adult_clause(adult)} "
            f"ORDER BY frequency DESC LIMIT ?",
            (node_id, limit),
        )
        return [{"tag": r["tag"], "frequency": int(r["frequency"] or 0),
                 "is_adult": int(r["is_adult"])} for r in rows]

    def context_candidates(self, context_tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
        """返回某上下文标签的关联标签。"""
        if not self.is_available():
            return []
        key = _norm(context_tag)
        if not key:
            return []
        limit = max(0, int(limit))
        rows = self._fetch(
            f"SELECT related_tag, npmi, is_adult FROM prior_context_tag "
            f"WHERE context_tag=? {self._adult_clause(adult)} "
            f"ORDER BY npmi DESC LIMIT ?",
            (key, limit),
        )
        return [{"tag": r["related_tag"], "npmi": float(r["npmi"]),
                 "is_adult": int(r["is_adult"])} for r in rows]

    def next_slot_prior(self, filled_slots, all_slots=None, adult: bool = False) -> list[dict]:
        """基于槽位转移先验推荐下一个待填槽位。

        filled_slots：已填写的 node_id 列表；返回从任一已填节点出发、未填的转移目标。
        """
        if not self.is_available() or not filled_slots:
            return []
        filled = {str(n or "").strip() for n in filled_slots if str(n or "").strip()}
        if not filled:
            return []
        placeholders = ",".join("?" for _ in filled)
        rows = self._fetch(
            f"SELECT from_node_id, to_node_id, frequency FROM prior_slot_transition "
            f"WHERE from_node_id IN ({placeholders}) ORDER BY frequency DESC",
            tuple(filled),
        )
        out = []
        seen = set()
        for row in rows:
            to_node = row["to_node_id"]
            if to_node in filled or to_node in seen:
                continue
            seen.add(to_node)
            out.append({"node_id": to_node, "from_node_id": row["from_node_id"],
                        "frequency": int(row["frequency"] or 0)})
        return out

    def semantic_node_for_tag(self, tag: str) -> str | None:
        """返回标签的语义节点 id（离线版本：taxonomy/nav-seed 基础）。

        这是非 embedding 的离线映射。并行 SiliconFlow 任务会补充 ``semantic_node()``
        （embedding 版本），两者都读 ``tag_semantic_node`` 表。
        """
        if not self.is_available():
            return None
        key = _norm(tag)
        if not key:
            return None
        row = self._fetchone(
            "SELECT semantic_node_id FROM tag_semantic_node WHERE tag=?", (key,)
        )
        return row["semantic_node_id"] if row else None

    # NOTE: 并行 SiliconFlow 任务将在此类追加以下方法（本实现刻意不提供）：
    #   def semantic_node(self, tag) -> str | None: ...   # embedding 版本
    #   def semantic_neighbors(self, tag, limit=20) -> list[dict]: ...
    # 它们读取 prior_semantic_neighbor 表；表缺失时应返回空而非抛错（复用 _fetch）。


_singleton: PromptPrior | None = None
_singleton_lock = threading.Lock()


def get_prior() -> PromptPrior:
    """模块级单例：懒加载并缓存。"""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = PromptPrior()
    return _singleton


# 模块级便捷函数：委托给 get_prior() 单例。
def related_tags(tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
    return get_prior().related_tags(tag, limit=limit, adult=adult)


def slot_candidates(node_id: str, limit: int = 64, adult: bool = False) -> list[dict]:
    return get_prior().slot_candidates(node_id, limit=limit, adult=adult)


def context_candidates(context_tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
    return get_prior().context_candidates(context_tag, limit=limit, adult=adult)


def semantic_node_for_tag(tag: str) -> str | None:
    return get_prior().semantic_node_for_tag(tag)


__all__ = [
    "PromptPrior", "get_prior",
    "related_tags", "slot_candidates", "context_candidates", "semantic_node_for_tag",
]
