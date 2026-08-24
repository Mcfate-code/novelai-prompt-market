"""搜索 + alias 解析 + 分类浏览 + Seed 状态解析。

搜索排序（规格 10 节）：
1. exact canonical  2. exact alias  3. canonical prefix  4. 中文/日文 alias prefix
5. substring  6. 同级按 post_count 降序。

另设「token 词序无关匹配」层：'range murata' 可直接命中 'murata range'。
difflib SequenceMatcher 对词序颠倒的匹配很差（orange hat 的 ratio 反而高于
murata range），因此引入 token 感知相似度统一处理。
"""
from __future__ import annotations

import difflib
import sqlite3

import db
from prompt import composer


def _norm(s: str) -> str:
    """统一规范化：trim + 小写 + 空白折叠。全项目 search/resolve/import 共用。"""
    return " ".join((s or "").strip().lower().split())


def _like_escape(s: str) -> str:
    """把 LIKE 模式中的 % _ 转义为字面量（用户输入不应被当成通配符）。"""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


TOKEN_LAYER_MIN = 2   # token 全等/部分覆盖至少需要的词数
TOKEN_LAYER_MAX = 8   # 超过视为整句/自然语言，不跑 token 层（防极端输入）


def _tokens_in_layer(q: str) -> list[str]:
    """token 层适用判定：词数在 [2, 8] 才跑（单 token 无词序问题，超长视为自然语言）。"""
    tokens = _norm(q).split()
    return tokens if TOKEN_LAYER_MIN <= len(tokens) <= TOKEN_LAYER_MAX else []


def token_key(s: str) -> str:
    """词序无关规范化：normalize 后按 token 排序拼接（保留重复 token）。

    'Range   Murata' / 'murata range' / 'MURATA RANGE' → 'murata range'；
    'foo foo bar' ≠ 'foo bar'（重复 token 不丢失）。
    """
    return " ".join(sorted(_norm(s).split()))


def token_similarity_keys(q: str, s: str) -> tuple:
    """token 证据多键排序键（词序无关场景专用，降序）。

    按证据强度分层，不做总分合成（字符巧合如 'orange hat' 不会盖过真实 token 命中）：
      1. token_key 是否全等（0/1）
      2. 完整 token 交集数量
      3. 查询 token 被覆盖比例
      4. 排序串序列比（difflib）
      5. 原串序列比（difflib）
    """
    qk, sk = token_key(q), token_key(s)
    qset, sset = set(qk.split()), set(sk.split())
    overlap = len(qset & sset)
    coverage = overlap / len(qset) if qset else 0.0
    return (
        int(qk == sk),
        overlap,
        coverage,
        difflib.SequenceMatcher(None, qk, sk).ratio(),
        difflib.SequenceMatcher(None, _norm(q), _norm(s)).ratio(),
    )


def _favorite_tags(conn: sqlite3.Connection) -> set[str]:
    """当前收藏的 tag（空格形式）。"""
    return {r["tag_name"] for r in conn.execute("SELECT tag_name FROM favorites")}


def _token_score_rank(r: dict) -> tuple:
    """把 token 证据元组转成升序排序键（证据越强值越小）。

    token_score 为 token_similarity_keys 返回的元组（各维越大越强）；
    无 token 证据的条目返回全 0，排在部分覆盖条目之后。
    """
    ts = r.get("token_score") or 0.0
    if isinstance(ts, tuple):
        return tuple(-x for x in ts)
    return (0, 0, 0, 0, 0)


def resolve_tag(conn: sqlite3.Connection, query: str) -> dict | None:
    """把任意检索词解析为 canonical tag。返回统一 DTO（含 favorite / via）。

    解析顺序（确定性优先，prefix/fuzzy 在后）：
      1. exact canonical
      2. exact alias
      3. token_key 词序无关全等（canonical + alias 都查）
         —— 唯一 canonical 自动解析；多个不同 canonical（collision）不自动解析，交给候选；
      4. canonical prefix
      5. alias prefix
    """
    q = _norm(query)
    if not q:
        return None
    favs = _favorite_tags(conn)
    # 1) exact canonical（下划线或空格形式）
    row = conn.execute(
        "SELECT *, 'canonical' AS via FROM tags WHERE lower(danbooru_name)=? OR lower(prompt_tag)=? LIMIT 1",
        (q, q),
    ).fetchone()
    if row:
        return db.tag_dict(row, favorite=row["prompt_tag"] in favs)
    # 2) exact alias
    row = conn.execute(
        "SELECT t.*, 'alias' AS via FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
        "WHERE lower(a.alias)=? LIMIT 1",
        (q,),
    ).fetchone()
    if row:
        return db.tag_dict(row, favorite=row["prompt_tag"] in favs)
    # 3) token_key 词序无关全等：'Range Murata' -> 'murata range'
    tokens = _tokens_in_layer(q)
    if tokens:
        tk = token_key(q)
        like = [_like_escape(t) for t in tokens]
        # 3a) canonical token_key 全等（AND LIKE 只负责召回，token_key 相等才是判定）
        cond = " AND ".join(["lower(prompt_tag) LIKE ? ESCAPE '\\'"] * len(tokens))
        hits: dict[str, sqlite3.Row] = {}
        for row in conn.execute(
            f"SELECT * FROM tags WHERE {cond} ORDER BY post_count DESC LIMIT 50",
            tuple(f"%{t}%" for t in like),
        ).fetchall():
            if token_key(row["prompt_tag"]) == tk:
                hits.setdefault(row["danbooru_name"], row)
        # 3b) alias token_key 全等（token 等价的 alias 仍解析到其 canonical）
        cond_a = " AND ".join(["lower(a.alias) LIKE ? ESCAPE '\\'"] * len(tokens))
        for row in conn.execute(
            f"SELECT t.*, a.alias AS src_alias, 'token_alias' AS via "
            f"FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
            f"WHERE {cond_a} ORDER BY t.post_count DESC LIMIT 50",
            tuple(f"%{t}%" for t in like),
        ).fetchall():
            if token_key(row["src_alias"]) == tk:
                hits.setdefault(row["danbooru_name"], row)
        # 唯一 canonical -> 自动解析；多个不同 canonical（collision）-> 不拍脑袋选，交给候选
        if len(hits) == 1:
            row = next(iter(hits.values()))
            d = db.tag_dict(row, favorite=row["prompt_tag"] in favs)
            d["via"] = row["via"] if "via" in row.keys() and row["via"] else "token_key"
            return d
    # 4) canonical prefix
    row = conn.execute(
        "SELECT *, 'canonical_prefix' AS via FROM tags WHERE lower(prompt_tag) LIKE ? ORDER BY length(prompt_tag) ASC, post_count DESC LIMIT 1",
        (f"{q}%",),
    ).fetchone()
    if row:
        return db.tag_dict(row, favorite=row["prompt_tag"] in favs)
    # 5) alias prefix（用于中文词命中，如「蓝眼」-> 蓝眼睛）
    row = conn.execute(
        "SELECT t.*, 'alias_prefix' AS via FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
        "WHERE lower(a.alias) LIKE ? ORDER BY length(a.alias) ASC LIMIT 1",
        (f"{q}%",),
    ).fetchone()
    if row:
        return db.tag_dict(row, favorite=row["prompt_tag"] in favs)
    return None


def search(
    conn: sqlite3.Connection,
    query: str,
    limit: int = 50,
    category: int | None = None,
    deprecated: bool = False,
) -> list[dict]:
    q = _norm(query)
    results: dict[str, dict] = {}
    cat_sql = "AND category = ?" if category is not None else ""
    cat_args = (category,) if category is not None else ()

    def add(row, rank: int, token_score: float = 0.0):
        if row is None:
            return
        key = row["danbooru_name"]
        if key in results and results[key]["rank"] <= rank:
            return
        d = db.tag_dict(row)
        d["rank"] = rank
        d["token_score"] = token_score
        d["category_name"] = db.CATEGORY_NAMES.get(d.get("category"), "General")
        results[key] = d

    if q:
        # 1 exact canonical
        for row in conn.execute(
            f"SELECT * FROM tags WHERE (lower(danbooru_name)=? OR lower(prompt_tag)=?) {cat_sql} LIMIT 5",
            (q, q, *cat_args),
        ).fetchall():
            add(row, 0)
        # 2 exact alias
        for row in conn.execute(
            f"SELECT t.* FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
            f"WHERE lower(a.alias)=? {cat_sql} LIMIT 10",
            (q, *cat_args),
        ).fetchall():
            add(row, 1)
        # 2.5 token_key 词序无关全等（'range murata' -> 'murata range'，确定性等价，先于 prefix）
        tokens = _tokens_in_layer(q)
        if tokens:
            tk = token_key(q)
            like = [_like_escape(t) for t in tokens]
            cond = " AND ".join(["lower(t.prompt_tag) LIKE ? ESCAPE '\\'"] * len(tokens))
            for row in conn.execute(
                f"SELECT t.* FROM tags t WHERE {cond} {cat_sql} ORDER BY t.post_count DESC LIMIT 50",
                tuple(f"%{t}%" for t in like) + cat_args,
            ).fetchall():
                if token_key(row["prompt_tag"]) == tk:
                    add(row, 1.5)
        # 3 canonical prefix
        for row in conn.execute(
            f"SELECT * FROM tags WHERE lower(prompt_tag) LIKE ? {cat_sql} "
            f"ORDER BY post_count DESC LIMIT 200",
            (f"{q}%", *cat_args),
        ).fetchall():
            add(row, 2)
        # 4 中文/日文 alias prefix
        for row in conn.execute(
            f"SELECT t.* FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
            f"WHERE lower(a.alias) LIKE ? {cat_sql} ORDER BY length(a.alias) ASC LIMIT 200",
            (f"{q}%", *cat_args),
        ).fetchall():
            add(row, 3)
        # 5 substring
        for row in conn.execute(
            f"SELECT * FROM tags WHERE lower(prompt_tag) LIKE ? {cat_sql} "
            f"ORDER BY post_count DESC LIMIT 200",
            (f"%{q}%", *cat_args),
        ).fetchall():
            add(row, 4)
        # 5.5 token 部分覆盖（仅当主路径结果不足时补跑，避免每次搜索都做全表扫描）
        if len(results) < 5 and tokens:
            cond_or = " OR ".join(["lower(t.prompt_tag) LIKE ? ESCAPE '\\'"] * len(tokens))
            for row in conn.execute(
                f"SELECT t.* FROM tags t WHERE {cond_or} {cat_sql} "
                f"ORDER BY t.post_count DESC LIMIT 500",
                tuple(f"%{t}%" for t in like) + cat_args,
            ).fetchall():
                score = token_similarity_keys(q, row["prompt_tag"])
                if score[1] >= 2:  # 至少 2 个完整 token 交集才算部分覆盖
                    add(row, 5, token_score=score)

    rows = list(results.values())
    # post_count>0 的真实 tag 优先，其次 rank，同 rank 内 token 证据强优先，最后按 post_count 降序
    rows.sort(
        key=lambda r: (
            (r.get("post_count") or 0) == 0,
            r["rank"],
            _token_score_rank(r),
            -(r.get("post_count") or 0),
            r["tag"],
        )
    )
    if not deprecated:
        rows = [r for r in rows if not r.get("is_deprecated")]
    # 统一 DTO：标记 favorite
    favs = _favorite_tags(conn)
    for r in rows:
        r["favorite"] = r["tag"] in favs
    return rows[:limit]


def taxonomy_tree(conn: sqlite3.Connection) -> list[dict]:
    """返回按 sort_order 排序的分类树，每个分类含成员标签（附 zh_name / post_count / 状态）。"""
    cur = conn.execute(
        "SELECT m.category_l1, m.tag_name, m.sort_order, t.zh_name, t.post_count, t.is_deprecated "
        "FROM taxonomy_map m LEFT JOIN tags t ON t.prompt_tag = m.tag_name "
        "ORDER BY m.sort_order, m.category_l1, m.tag_name"
    )
    cats: dict[str, dict] = {}
    for r in cur.fetchall():
        label = r["category_l1"]
        if label not in cats:
            cats[label] = {"label": label, "order": r["sort_order"], "tags": []}
        cats[label]["tags"].append(
            {
                "tag": r["tag_name"],
                "zh_name": r["zh_name"],
                "post_count": r["post_count"] or 0,
                "is_deprecated": bool(r["is_deprecated"]),
            }
        )
    return [cats[k] for k in sorted(cats, key=lambda x: cats[x]["order"])]


def seed_status(conn: sqlite3.Connection, tag_name: str) -> str:
    """规格 11 节：canonical / alias / overlay_only / unresolved。"""
    overlay = composer.overlay_tags()
    if tag_name in overlay:
        return "overlay_only"
    row = conn.execute(
        "SELECT 1 FROM tags WHERE lower(danbooru_name)=? OR lower(prompt_tag)=? LIMIT 1",
        (_norm(tag_name), _norm(tag_name)),
    ).fetchone()
    if row:
        return "canonical"
    row = conn.execute(
        "SELECT 1 FROM tag_aliases WHERE lower(alias)=? LIMIT 1", (_norm(tag_name),)
    ).fetchone()
    if row:
        return "alias"
    return "unresolved"
