"""把中文别名层（通用 tag + 角色名）导入 tag_aliases 并回填 tags.zh_name。

- data/zh_aliases.json   通用 tag 中文名（key 为 prompt 空格形式，精确匹配）
- data/zh_characters.json 角色裸名中文名（key 为裸名，如 nahida，需解析到规范 tag：
  nahida -> nahida_(genshin_impact)）

中文搜索时经 alias 解析命中英文 canonical。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from importer import pinyin_util  # noqa: E402

ZH_PATH = db.BASE_DIR / "data" / "zh_aliases.json"
ZH_CHAR_PATH = db.BASE_DIR / "data" / "zh_characters.json"


def load_zh(path: str | Path | None = None, include_characters: bool = True) -> dict[str, str]:
    merged: dict[str, str] = {}
    for p in ([ZH_PATH, ZH_CHAR_PATH] if include_characters else [ZH_PATH]):
        if not p.exists():
            continue
        data = db.load_json(p)
        if not isinstance(data, dict):
            continue
        for k, v in data.items():
            k = str(k).strip()
            if not k or k.startswith("_"):
                continue
            merged[k] = str(v).strip()
    if path:
        extra = db.load_json(path)
        if isinstance(extra, dict):
            for k, v in extra.items():
                k = str(k).strip()
                if k and not k.startswith("_"):
                    merged[k] = str(v).strip()
    return merged


def resolve_zh_target(conn, key: str) -> str | None:
    """把检索词 key 解析为规范的 danbooru_name。

    优先级：
    1. 精确匹配 category in (1,3,4) 且 post_count>0（角色/画师/版权规范名）
    2. 精确匹配 category=0 且 post_count>0（通用 tag）
    3. 前缀匹配 category=4（角色裸名 -> 带版权后缀，取 post_count 最高）
    4. 精确匹配任意（兜底：post_count=0 的 seed / 生僻 tag）
    """
    row = conn.execute(
        "SELECT danbooru_name FROM tags WHERE prompt_tag=? AND category IN (1,3,4) AND post_count>0 "
        "ORDER BY post_count DESC LIMIT 1",
        (key,),
    ).fetchone()
    if row:
        return row["danbooru_name"]
    row = conn.execute(
        "SELECT danbooru_name FROM tags WHERE prompt_tag=? AND category=0 AND post_count>0 "
        "ORDER BY post_count DESC LIMIT 1",
        (key,),
    ).fetchone()
    if row:
        return row["danbooru_name"]
    row = conn.execute(
        "SELECT danbooru_name FROM tags WHERE category=4 AND prompt_tag LIKE ? AND post_count>0 "
        "ORDER BY post_count DESC LIMIT 1",
        (key + " (%",),
    ).fetchone()
    if row:
        return row["danbooru_name"]
    row = conn.execute(
        "SELECT danbooru_name FROM tags WHERE prompt_tag=? ORDER BY post_count DESC LIMIT 1", (key,)
    ).fetchone()
    if row:
        return row["danbooru_name"]
    return None


def import_zh(conn, zh: dict[str, str] | None = None) -> dict:
    zh = zh if zh is not None else load_zh()
    alias_rows = []
    unresolved = []
    for key, name in zh.items():
        canonical = resolve_zh_target(conn, key)
        if not canonical:
            unresolved.append(key)
            continue
        alias_rows.append(
            {"alias": name, "canonical_name": canonical, "lang": "zh", "source": "curated"}
        )
        full, initials = pinyin_util.compute_pinyin(name)
        conn.execute(
            "UPDATE tags SET zh_name=COALESCE(?, zh_name), "
            "pinyin=COALESCE(?, pinyin), pinyin_initials=COALESCE(?, pinyin_initials) "
            "WHERE danbooru_name=?",
            (name, full or None, initials or None, canonical),
        )
    db.upsert_aliases(conn, alias_rows)
    conn.commit()
    return {"zh_entries": len(zh), "resolved": len(alias_rows), "unresolved": unresolved}


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        s = import_zh(conn)
        print(f"中文别名导入完成：{s['resolved']}/{s['zh_entries']} 条，未解析 {len(s['unresolved'])} 个")
        if s["unresolved"]:
            print("未解析：", s["unresolved"][:30])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
