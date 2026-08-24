"""目录（catalog）初始化：从 data/navigation.json 生成 tag_catalog 表（一级导航 + 子目录）。

navigation.json = UI 导航（一级折叠目录 + 二级引用）；taxonomy_seed.json = 数据分类（底层不重写）。
子目录类型：
- favorites / recent            我的偏好
- danbooru_category             按 Danbooru category 浏览
- taxonomy_category             标签超市分类（引用 taxonomy_map.category_l1）
- restricted_taxonomy           受限标签（引用 restricted_taxonomy_map.section_id）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402

NAV_PATH = db.BASE_DIR / "data" / "navigation.json"


def load_navigation() -> dict:
    return db.load_json(NAV_PATH)


def build_catalog(conn) -> dict:
    """建表 + 从 navigation.json 导入一级导航与子目录。"""
    conn.executescript(db.SCHEMA)  # 确保表存在
    nav = load_navigation()

    conn.execute("DELETE FROM tag_catalog")
    conn.commit()

    sort = 0
    groups = 0
    children_count = 0

    for group in nav.get("nav", []):
        gid = group["id"]
        sort += 1
        groups += 1
        conn.execute(
            "INSERT INTO tag_catalog (id, kind, label, nsfw, sort_order, group_id, config_json) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                gid, "group", group["label"], int(bool(group.get("nsfw"))), sort, None,
                json.dumps({"icon": group.get("icon", ""), "collapsed": bool(group.get("collapsed"))},
                           ensure_ascii=False),
            ),
        )

        # 1) 特殊子目录（favorites / recent / danbooru_category）
        for child in group.get("children", []):
            sort += 1
            children_count += 1
            config = {k: v for k, v in child.items() if k not in ("id", "kind", "label")}
            conn.execute(
                "INSERT INTO tag_catalog (id, kind, label, nsfw, sort_order, group_id, config_json) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    child["id"], child.get("kind", "danbooru_category"), child["label"],
                    int(bool(child.get("nsfw"))), sort, gid,
                    json.dumps(config, ensure_ascii=False),
                ),
            )

        # 2) 标签超市分类（引用 taxonomy_map.category_l1）
        for label in group.get("taxonomy", []):
            sort += 1
            children_count += 1
            cid = f"tax_{label}"
            conn.execute(
                "INSERT INTO tag_catalog (id, kind, label, nsfw, sort_order, group_id, config_json) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    cid, "taxonomy_category", label,
                    int(bool("NSFW" in label or "成人" in label)), sort, gid,
                    json.dumps({"taxonomy_label": label}, ensure_ascii=False),
                ),
            )

        # 3) 受限标签子目录（引用 restricted_taxonomy_map 的 24 个 section）
        if group.get("restricted"):
            sections = conn.execute(
                "SELECT DISTINCT section_id, section_label, sort_order "
                "FROM restricted_taxonomy_map "
                "ORDER BY CAST(sort_order AS INTEGER), CAST(section_id AS INTEGER)"
            ).fetchall()
            for s in sections:
                sort += 1
                children_count += 1
                cid = f"restricted_{s['section_id']}"
                conn.execute(
                    "INSERT INTO tag_catalog (id, kind, label, nsfw, sort_order, group_id, config_json) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (
                        cid, "restricted_taxonomy", s["section_label"], 1, sort, gid,
                        json.dumps({"section_id": s["section_id"]}, ensure_ascii=False),
                    ),
                )

    conn.commit()
    return {"groups": groups, "children": children_count}


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        print(build_catalog(conn))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
