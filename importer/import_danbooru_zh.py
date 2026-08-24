"""从 ffdkj Danbooru 中英对照表（data/danbooru_zh.sqlite）批量导入中文名。

数据源：https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table
收录 post_count>=10 的 tag，Gemini 机翻 + 人工校对，约 32 万条。

策略：
- 我手动整理的 zh_aliases.json / zh_characters.json 中文名优先（不覆盖）；
- 本表只填充 zh_name 为空的 tag；
- 中文名作为 alias（source='danbooru-zh'）写入 tag_aliases，供中文搜索。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402

ZH_DB = db.BASE_DIR / "data" / "danbooru_zh.sqlite"


def import_danbooru_zh(conn, zh_db_path: str | Path | None = None) -> dict:
    path = Path(zh_db_path) if zh_db_path else ZH_DB
    if not path.exists():
        return {"error": f"对照表不存在：{path}"}
    attach = str(path).replace("\\", "/")

    # 1) 填充 zh_name（仅空白处，保留手动翻译优先）
    conn.execute(f"ATTACH DATABASE '{attach}' AS zhdb")
    try:
        cur = conn.execute(
            """
            UPDATE tags SET zh_name = (
                SELECT cn_name FROM zhdb.tags
                WHERE name = tags.danbooru_name AND cn_name IS NOT NULL AND cn_name != ''
            )
            WHERE zh_name IS NULL
              AND EXISTS (
                SELECT 1 FROM zhdb.tags
                WHERE name = tags.danbooru_name AND cn_name IS NOT NULL AND cn_name != ''
              )
            """
        )
        updated = cur.rowcount

        # 2) 写入中文 alias（中文搜索用），已有 alias 不覆盖
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO tag_aliases (alias, canonical_name, lang, source)
            SELECT cn_name, name, 'zh', 'danbooru-zh' FROM zhdb.tags
            WHERE name IN (SELECT danbooru_name FROM tags)
              AND cn_name IS NOT NULL AND cn_name != ''
            """
        )
        aliases = cur.rowcount
        conn.commit()
    finally:
        conn.execute("DETACH DATABASE zhdb")

    total = conn.execute("SELECT COUNT(*) c FROM tags").fetchone()["c"]
    with_zh = conn.execute("SELECT COUNT(*) c FROM tags WHERE zh_name IS NOT NULL").fetchone()["c"]
    return {"zh_updated": updated, "aliases_added": aliases, "total": total, "with_zh": with_zh}


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        s = import_danbooru_zh(conn)
        print(s)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
