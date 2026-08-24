"""把 data/taxonomy_seed.json（人工浏览层）导入 taxonomy_map，并把 Seed 标签作为
基础条目写入 tags 表（source='seed'），保证断网也能浏览与拼装。

Danbooru 全量同步（sync_danbooru.py）会随后 enrich / 纠偏这些条目。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402

SEED_PATH = db.BASE_DIR / "data" / "taxonomy_seed.json"


def parse_category(key: str) -> tuple[int, str]:
    m = re.match(r"^(\d+)\s*(.*)$", key.strip())
    if m:
        return int(m.group(1)), m.group(2).strip()
    return 0, key.strip()


def load_seed(path: str | Path | None = None) -> dict:
    seed = db.load_json(path or SEED_PATH)
    assert isinstance(seed, dict) and "taxonomy" in seed, "种子文件缺少 taxonomy"
    return seed


def import_taxonomy(conn, seed: dict | None = None) -> dict:
    seed = seed or load_seed()
    taxonomy = seed["taxonomy"]
    categories: list[dict] = []
    tag_rows: list[dict] = []
    seen: set[str] = set()

    for key, tags in taxonomy.items():
        order, label = parse_category(key)
        categories.append({"order": order, "label": label, "count": len(tags)})
        for tag in tags:
            tag = str(tag).strip()
            if not tag:
                continue
            conn.execute(
                """
                INSERT INTO taxonomy_map (tag_name, category_l1, category_l2, category_l3, sort_order)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(tag_name, category_l1, category_l2, category_l3) DO NOTHING
                """,
                (tag, label, None, None, order),
            )
            if tag not in seen:
                seen.add(tag)
                tag_rows.append(
                    {
                        "danbooru_name": db.underscore(tag),
                        "prompt_tag": tag,
                        "category": 0,
                        "post_count": 0,
                        "source": "seed",
                        "synced_at": db.now_iso(),
                    }
                )

    db.upsert_tags(conn, tag_rows)
    conn.commit()
    return {
        "categories": len(categories),
        "memberships": sum(c["count"] for c in categories),
        "unique_tags": len(seen),
    }


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        summary = import_taxonomy(conn)
        print(
            f"taxonomy 导入完成：{summary['categories']} 类 / "
            f"{summary['memberships']} 成员 / {summary['unique_tags']} 去重标签"
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
