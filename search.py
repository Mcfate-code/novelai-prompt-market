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
import re
import sqlite3

import db
from prompt import composer


def _norm(s: str) -> str:
    """统一大小写、下划线、连字符、标点和连续空白。"""
    value = (s or "").strip().lower().replace("_", " ")
    value = re.sub(r"[-‐‑‒–—―]+", " ", value)
    value = re.sub(r"[^\w\s]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


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
    # 1) exact canonical。SQL 只召回两种标准存储写法，最终用 _norm 判定，
    # 避免为了规范化精确匹配而扫描全表。
    variants = tuple(dict.fromkeys((q, q.replace(" ", "_"))))
    placeholders = ",".join("?" for _ in variants)
    row = next(
        (
            candidate
            for candidate in conn.execute(
                f"SELECT *, 'canonical' AS via FROM tags "
                f"WHERE lower(danbooru_name) IN ({placeholders}) "
                f"OR lower(prompt_tag) IN ({placeholders}) "
                "ORDER BY post_count DESC LIMIT 20",
                (*variants, *variants),
            ).fetchall()
            if _norm(candidate["danbooru_name"]) == q or _norm(candidate["prompt_tag"]) == q
        ),
        None,
    )
    if row:
        return db.tag_dict(row, favorite=row["prompt_tag"] in favs)
    # 2) exact alias。别名也使用有限候选 + Python 规范化判定。
    row = next(
        (
            candidate
            for candidate in conn.execute(
                f"SELECT t.*, a.alias AS src_alias, 'alias' AS via "
                f"FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
                f"WHERE lower(a.alias) IN ({placeholders}) "
                "ORDER BY t.post_count DESC LIMIT 20",
                variants,
            ).fetchall()
            if _norm(candidate["src_alias"]) == q
        ),
        None,
    )
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
    # 6) 自定义标签（user_tags）：精确或前缀命中。
    row = conn.execute(
        "SELECT tag_name FROM user_tags "
        "WHERE lower(tag_name)=? OR lower(tag_name) LIKE ? ESCAPE '\\' "
        "ORDER BY length(tag_name) ASC LIMIT 1",
        (q, f"{_like_escape(q)}%"),
    ).fetchone()
    if row:
        tag_name = row["tag_name"]
        return {
            "tag": tag_name,
            "canonical": db.underscore(tag_name),
            "zh": "",
            "category": 0,
            "post_count": 0,
            "favorite": tag_name in favs,
            "via": "user_tags",
        }
    return None


MATCH_RANK = {
    "exact": 0,
    "token_exact": 1,
    "token_unordered": 2,
    "prefix": 3,
    "substring": 4,
    "fuzzy": 5,
}

MATCH_REASON = {
    "exact": "与标签或别名完全一致",
    "token_exact": "规范化后与标签或别名一致",
    "token_unordered": "词元完全一致，仅顺序不同",
    "prefix": "匹配标签或别名前缀",
    "substring": "包含查询文本",
    "fuzzy": "与标签或别名相似",
}


def _simple_norm(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def match_evidence(query: str, candidate: str) -> tuple[str, float] | None:
    q_simple, c_simple = _simple_norm(query), _simple_norm(candidate)
    q, c = _norm(query), _norm(candidate)
    if not q or not c:
        return None
    similarity = difflib.SequenceMatcher(None, q, c).ratio()
    if q_simple == c_simple:
        return "exact", 1.0
    if q == c:
        return "token_exact", 1.0
    qt, ct = q.split(), c.split()
    if len(qt) >= 2 and sorted(qt) == sorted(ct):
        return "token_unordered", 1.0
    if c.startswith(q):
        return "prefix", similarity
    if q in c:
        return "substring", similarity
    qset, cset = set(qt), set(ct)
    token_overlap = len(qset & cset) / max(1, len(qset | cset))
    score = max(similarity, token_overlap)
    if score >= 0.35:
        return "fuzzy", score
    return None


def _search_candidates(
    conn: sqlite3.Connection,
    query: str,
    category: int | None,
    deprecated: bool,
    limit: int,
) -> tuple[dict[str, sqlite3.Row], dict[str, list[str]]]:
    """用 SQL 做有限召回，统一匹配判定仍由 match_evidence 完成。"""
    normalized = _norm(query)
    raw = _simple_norm(query)
    tokens = normalized.split()
    candidate_limit = max(200, min(2000, limit * 30))
    tag_conditions = ["lower(t.prompt_tag)=?", "lower(t.danbooru_name)=?"]
    tag_args: list = [raw, raw]
    alias_conditions = ["lower(a.alias)=?"]
    alias_args: list = [raw]
    for token in tokens:
        pattern = f"%{_like_escape(token)}%"
        tag_conditions.extend((
            "lower(t.prompt_tag) LIKE ? ESCAPE '\\'",
            "lower(t.danbooru_name) LIKE ? ESCAPE '\\'",
        ))
        tag_args.extend((pattern, pattern))
        alias_conditions.append("lower(a.alias) LIKE ? ESCAPE '\\'")
        alias_args.append(pattern)

    filters = []
    filter_args: list = []
    if category is not None:
        filters.append("t.category=?")
        filter_args.append(category)
    if not deprecated:
        filters.append("t.is_deprecated=0")
    suffix = (" AND " + " AND ".join(filters)) if filters else ""
    rows: dict[str, sqlite3.Row] = {}
    for row in conn.execute(
        "SELECT t.*, COALESCE(r.use_count, 0) use_count FROM tags t "
        "LEFT JOIN recent_tags r ON r.tag_name=t.prompt_tag "
        f"WHERE ({' OR '.join(tag_conditions)}){suffix} "
        "ORDER BY t.post_count DESC, t.prompt_tag LIMIT ?",
        (*tag_args, *filter_args, candidate_limit),
    ):
        rows[row["danbooru_name"]] = row

    aliases: dict[str, list[str]] = {}
    for row in conn.execute(
        "SELECT t.*, COALESCE(r.use_count, 0) use_count, a.alias matched_alias FROM tag_aliases a "
        "JOIN tags t ON t.danbooru_name=a.canonical_name "
        "LEFT JOIN recent_tags r ON r.tag_name=t.prompt_tag "
        f"WHERE ({' OR '.join(alias_conditions)}){suffix} "
        "ORDER BY t.post_count DESC, a.alias LIMIT ?",
        (*alias_args, *filter_args, candidate_limit),
    ):
        canonical = row["danbooru_name"]
        rows.setdefault(canonical, row)
        aliases.setdefault(canonical, []).append(row["matched_alias"])

    # 自定义标签召回（user_tags）：不受 category / deprecated 过滤（自定义标签无分类/废弃元数据）。
    # 条件 = 整体子串 或 逐 token（AND）命中，交由 match_evidence 做最终匹配判定。
    user_conditions = ["lower(tag_name) LIKE ? ESCAPE '\\'"]
    user_args: list = [f"%{_like_escape(raw)}%"]
    if tokens:
        user_conditions.append(
            "(" + " AND ".join(["lower(tag_name) LIKE ? ESCAPE '\\'"] * len(tokens)) + ")"
        )
        user_args.extend(f"%{_like_escape(token)}%" for token in tokens)
    for row in conn.execute(
        "SELECT tag_name, note, created_at FROM user_tags "
        f"WHERE ({' OR '.join(user_conditions)}) LIMIT ?",
        (*user_args, candidate_limit),
    ):
        tag_name = row["tag_name"]
        key = db.underscore(tag_name)
        if key in rows:
            continue  # 与内置标签同名时内置优先，避免重复/覆盖
        rows[key] = {
            "prompt_tag": tag_name,
            "danbooru_name": key,
            "category": 0,
            "post_count": 0,
            "is_deprecated": 0,
            "zh_name": "",
            "use_count": 0,
            "via": "user_tags",
        }

    # 没有文本召回时，以有限热门集合支持拼写模糊匹配，避免扫描整个词库。
    if len(rows) < limit:
        fallback_where = ("WHERE " + " AND ".join(filters)) if filters else ""
        for row in conn.execute(
            "SELECT t.*, COALESCE(r.use_count, 0) use_count FROM tags t "
            "LEFT JOIN recent_tags r ON r.tag_name=t.prompt_tag "
            f"{fallback_where} ORDER BY t.post_count DESC, t.prompt_tag LIMIT ?",
            (*filter_args, candidate_limit),
        ):
            rows.setdefault(row["danbooru_name"], row)
        for row in conn.execute(
            "SELECT t.*, COALESCE(r.use_count, 0) use_count, a.alias matched_alias FROM tag_aliases a "
            "JOIN tags t ON t.danbooru_name=a.canonical_name "
            "LEFT JOIN recent_tags r ON r.tag_name=t.prompt_tag "
            f"{fallback_where} ORDER BY t.post_count DESC, a.alias LIMIT ?",
            (*filter_args, candidate_limit),
        ):
            canonical = row["danbooru_name"]
            rows.setdefault(canonical, row)
            aliases.setdefault(canonical, []).append(row["matched_alias"])
    return rows, aliases


def search(
    conn: sqlite3.Connection,
    query: str,
    limit: int = 50,
    category: int | None = None,
    deprecated: bool = False,
) -> list[dict]:
    if not _norm(query):
        return []
    rows, aliases = _search_candidates(conn, query, category, deprecated, limit)
    results = []
    for row in rows.values():
        names = [row["prompt_tag"], row["danbooru_name"], *aliases.get(row["danbooru_name"], [])]
        best = None
        best_name = ""
        for name in names:
            evidence = match_evidence(query, name)
            if evidence is None:
                continue
            key = (MATCH_RANK[evidence[0]], -evidence[1])
            if best is None or key < (MATCH_RANK[best[0]], -best[1]):
                best, best_name = evidence, name
        if best is None:
            continue
        match_type, similarity = best
        item = db.tag_dict(row)
        item.update({
            "rank": MATCH_RANK[match_type],
            "match_type": match_type,
            "match_reason": MATCH_REASON[match_type] + ("（通过别名）" if best_name not in (row["prompt_tag"], row["danbooru_name"]) else ""),
            "similarity": round(similarity, 6),
            "use_count": row["use_count"],
            "category_name": db.CATEGORY_NAMES.get(row["category"], "General"),
        })
        results.append(item)

    results.sort(key=lambda item: (
        item["rank"], -item["similarity"], -item["use_count"],
        -(item.get("post_count") or 0), item["tag"].lower(),
    ))
    favs = _favorite_tags(conn)
    for item in results:
        item["favorite"] = item["tag"] in favs
    return results[:limit]


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
