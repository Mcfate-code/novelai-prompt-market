"""Offline Prompt Prior 运行时（只读、零重型依赖）。

只从 data/offline_prompt_prior.sqlite 读取预计算的 NPMI 关联 / 语义槽位 / 槽位转移先验。
运行时不依赖 HuggingFace datasets / PyArrow / Polars；先验库不存在时优雅降级为空模式
（返回空列表，is_available()=False）。安全过滤（青少年模式 / 受限标签）由上层 serving
层负责，本模块不内置任何 tag 黑名单。

并行扩展（SiliconFlow Embedding Prior）约定：
  本模块现已实现 ``semantic_neighbors()``（读 ``prior_semantic_neighbor``）与
  ``semantic_node()``（读 ``tag_semantic_node.node_id`` 多来源映射），二者在对应
  表缺失时优雅降级（复用 ``_fetch``，catch sqlite3.OperationalError 返回空）。
  ``semantic_node_for_tag()``（离线 taxonomy/nav 版本）也读 ``tag_semantic_node``
  （``node_id`` 列）并与之并存。
  PromptPrior 类结构保持简洁、可追加方法，不引入任何冲突；本模块绝不 import
  numpy / faiss / 构建期 client，运行时不依赖任何 ML 框架。
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
        self._indexes_ensured = False

    def _ensure_indexes(self, conn: sqlite3.Connection) -> None:
        """幂等建立本任务表的查询索引（§71）；失败静默（只读文件系统也不崩）。"""
        try:
            conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_psn_src ON prior_semantic_neighbor(src_tag);
            CREATE INDEX IF NOT EXISTS idx_psn_srcnode ON prior_semantic_neighbor(src_node);
            CREATE INDEX IF NOT EXISTS idx_tsn_node ON tag_semantic_node(node_id);
            CREATE INDEX IF NOT EXISTS idx_tsn_tag ON tag_semantic_node(tag);
            """)
            conn.commit()
        except sqlite3.Error:
            pass

    def _conn(self) -> sqlite3.Connection | None:
        if not self.db_path.is_file():
            return None
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            if not self._indexes_ensured:
                self._ensure_indexes(conn)
                self._indexes_ensured = True
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

    def _safety_clause(self, adult: bool) -> str:
        """prior_semantic_neighbor / tag_semantic_node 用 safety_scope 标注（§37/§38）。"""
        return "" if adult else "AND (safety_scope IS NULL OR safety_scope != 'adult')"

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

    def slot_candidates(self, slot, context=None, limit: int = 20, adult: bool = False) -> list[dict]:
        """返回某语义槽位节点的候选标签（按频率降序，§69）。

        ``slot`` 为语义节点 id（对应 prior_slot_tag.semantic_node_id）。
        ``context`` 预留（当前未使用）。adult=False 只返回一般向 is_adult=0。
        """
        if not self.is_available():
            return []
        node_id = (slot or "").strip()
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

        读 ``tag_semantic_node.node_id``（§28）。这是非 embedding 的离线映射；
        ``semantic_node()`` 提供带证据字段的完整版本，二者都读 ``tag_semantic_node``。
        本方法直接查询该表，不依赖 ``prior_tag_assoc``（NPMI 表缺失/为空不影响语义节点）；
        表缺失或用例不存在时返回 None（绝不抛错）。
        """
        key = _norm(tag)
        if not key:
            return None
        row = self._fetchone(
            "SELECT node_id FROM tag_semantic_node WHERE tag=?", (key,)
        )
        return row["node_id"] if row else None

    def semantic_node(self, tag: str) -> dict | None:
        """返回标签的语义节点完整信息（多来源，§28）。

        返回 ``{tag, node_id, confidence, rule_source, embedding_score}``；
        表缺失或标签不存在时返回 None（绝不抛错）。
        """
        key = _norm(tag)
        if not key:
            return None
        row = self._fetchone(
            "SELECT node_id, confidence, rule_source, embedding_score "
            "FROM tag_semantic_node WHERE tag=?",
            (key,),
        )
        if row is None:
            return None
        escore = row["embedding_score"]
        return {
            "tag": key,
            "node_id": row["node_id"],
            "confidence": float(row["confidence"] or 0),
            "rule_source": row["rule_source"],
            "embedding_score": float(escore) if escore is not None else None,
        }

    def semantic_neighbors(self, tag: str, limit: int = 20, adult: bool = False) -> list[dict]:
        """返回 tag 的语义近邻（embedding 相似度 Top-K，§25）。

        读 ``prior_semantic_neighbor``（src_tag, dst_tag, similarity, relation_type,
        safety_scope）；adult=False 时过滤 safety_scope='adult' 的行（§37/§38）。
        表缺失时返回空列表（绝不抛错）。
        """
        key = _norm(tag)
        if not key:
            return []
        limit = max(0, int(limit))
        rows = self._fetch(
            f"SELECT dst_tag, similarity, relation_type, src_node, dst_node, safety_scope "
            f"FROM prior_semantic_neighbor WHERE src_tag=? {self._safety_clause(adult)} "
            f"ORDER BY similarity DESC LIMIT ?",
            (key, limit),
        )
        return [{
            "tag": r["dst_tag"],
            "similarity": float(r["similarity"] or 0),
            "relation_type": r["relation_type"],
            "src_node": r["src_node"],
            "dst_node": r["dst_node"],
            "safety_scope": r["safety_scope"],
        } for r in rows]

    def tag_associations(self, tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
        """别名：委托 ``related_tags``（NPMI 关联先验）。"""
        return self.related_tags(tag, limit=limit, adult=adult)

    def status(self) -> dict:
        """PHASE 8 交付契约：返回 ``{available, path, node_count, source_count, note}``。

        - ``node_count``：``tag_semantic_node`` 行数（文件/表缺失为 0）。
        - ``source_count``：``prior_manifest`` 中不同 ``(source_id, source_type)`` 数。
        - ``available``：文件存在且 ``node_count > 0``。
        任何 SQLite 错误一律降级为计数 0 / available=False，绝不抛错。
        """
        path = str(self.db_path)
        conn = self._conn()
        if conn is None:
            return {
                "available": False,
                "path": path,
                "node_count": 0,
                "source_count": 0,
                "note": "offline prior DB missing — running degraded fallback; see README 'Offline Prior'",
            }
        node_count = 0
        source_count = 0
        try:
            row = conn.execute("SELECT COUNT(*) AS c FROM tag_semantic_node").fetchone()
            node_count = int(row["c"] or 0) if row else 0
        except sqlite3.Error:
            pass
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM (SELECT DISTINCT source_id, source_type FROM prior_manifest)"
            ).fetchone()
            source_count = int(row["c"] or 0) if row else 0
        except sqlite3.Error:
            # 旧版 key/value 形状的 prior_manifest（无 source_id 列）：退化为总行数。
            try:
                row = conn.execute("SELECT COUNT(*) AS c FROM prior_manifest").fetchone()
                source_count = int(row["c"] or 0) if row else 0
            except sqlite3.Error:
                source_count = 0
        finally:
            conn.close()
        available = node_count > 0
        return {
            "available": available,
            "path": path,
            "node_count": node_count,
            "source_count": source_count,
            "note": "offline prior DB present" if available else "offline prior DB present but empty",
        }


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


def tag_associations(tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
    return get_prior().tag_associations(tag, limit=limit, adult=adult)


def slot_candidates(slot, context=None, limit: int = 20, adult: bool = False) -> list[dict]:
    return get_prior().slot_candidates(slot, context=context, limit=limit, adult=adult)


def context_candidates(context_tag: str, limit: int = 32, adult: bool = False) -> list[dict]:
    return get_prior().context_candidates(context_tag, limit=limit, adult=adult)


def semantic_node_for_tag(tag: str) -> str | None:
    return get_prior().semantic_node_for_tag(tag)


def semantic_node(tag: str) -> dict | None:
    return get_prior().semantic_node(tag)


def semantic_neighbors(tag: str, limit: int = 20, adult: bool = False) -> list[dict]:
    return get_prior().semantic_neighbors(tag, limit=limit, adult=adult)


__all__ = [
    "PromptPrior", "get_prior",
    "related_tags", "tag_associations", "slot_candidates", "context_candidates",
    "semantic_node_for_tag", "semantic_node", "semantic_neighbors",
]
