"""回填 tags.pinyin / tags.pinyin_initials（供拼音模糊搜索）。

中文名来源优先级：
  1. tags.zh_name（若非空）
  2. tag_aliases 中该 canonical 且 lang='zh' 的 alias（取第一个作为代表）

全拼用空格分词（如 'lan yan'），首字母连写（如 'ly'）。
英文名无中文名的 tag 拼音留空（NULL）。

幂等：已存在的值直接覆盖，可重复运行。
运行后打印统计：总 tag 数 / 成功生成拼音数 / 无中文名跳过数。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from importer import pinyin_util  # noqa: E402


def _zh_alias_map(conn) -> dict[str, list[str]]:
    """canonical_name -> 该 tag 的中文别名列表（按 alias 排序，第一个为主要别名）。"""
    out: dict[str, list[str]] = {}
    for r in conn.execute(
        "SELECT canonical_name, alias FROM tag_aliases "
        "WHERE lang='zh' ORDER BY canonical_name, alias"
    ).fetchall():
        out.setdefault(r["canonical_name"], []).append(r["alias"])
    return out


def backfill(conn) -> dict:
    alias_map = _zh_alias_map(conn)
    rows = conn.execute(
        "SELECT danbooru_name, zh_name FROM tags ORDER BY danbooru_name"
    ).fetchall()
    total = len(rows)
    generated = skipped = 0
    for row in rows:
        # 1) 优先 zh_name
        zh = (row["zh_name"] or "").strip()
        if not zh:
            # 2) 回退到第一个中文别名
            aliases = alias_map.get(row["danbooru_name"], [])
            if aliases:
                zh = aliases[0]
        if not zh:
            skipped += 1
            continue
        full, initials = pinyin_util.compute_pinyin(zh)
        if not full:
            skipped += 1
            continue
        conn.execute(
            "UPDATE tags SET pinyin=?, pinyin_initials=? WHERE danbooru_name=?",
            (full, initials, row["danbooru_name"]),
        )
        generated += 1
    conn.commit()
    return {"total": total, "generated": generated, "skipped": skipped}


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        stats = backfill(conn)
        print(
            f"拼音回填完成：总 tag {stats['total']}，"
            f"成功生成拼音 {stats['generated']}，无中文名跳过 {stats['skipped']}"
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
