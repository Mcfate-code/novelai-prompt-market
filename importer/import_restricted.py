"""把受限标签 taxonomy（用户预置的 adult curated seed）程序化接入。

数据文件由用户预置，本模块只负责工程接入，不生成 / 扩写 / 逐条解释标签值。

解析顺序（文件 policy.resolution_order）：
1. exact_canonical    prompt_tag / danbooru_name 精确命中 tags
2. exact_alias        tag_aliases.alias 精确命中
3. normalized_canonical  下划线 ↔ 空格互转后精确命中
4. unresolved_seed    保留原始值、标记未解析（不猜、不静默修改、不 LLM 补词）

curated 与 raw 分开：raw canonical（tags 全库）可搜索；受限 taxonomy 是独立人工目录层，
raw 命中 ≠ 自动进入 curated 分类。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402

# 默认文件名（先看 config，再看 data/，再看项目上级目录）
_FILENAME = "adult_curated_taxonomy_seed.json"

_CJK = re.compile(r"[\u4e00-\u9fff]")


def _is_anomalous(seed: str) -> bool:
    """识别明显不是 tag 的脏条目（如误粘贴的中文说明文本）：含中文 / 换行 / 超长。

    这类条目保留在 DB（不静默丢弃），但标记为 anomalous，不进 UI 展示，交由用户清理源文件。
    """
    s = seed.strip()
    return bool(s) and (
        "\n" in s or "\r" in s or bool(_CJK.search(s)) or len(s) > 80
    )


def locate_seed() -> Path | None:
    """定位用户预置的受限 taxonomy 文件。不硬编码、不复制第二份数据。"""
    settings = db.load_json(db.BASE_DIR / "config" / "app_settings.json")
    cfg = settings.get("restricted_taxonomy_path")
    candidates: list[Path] = []
    if cfg:
        p = Path(cfg)
        candidates.append(p if p.is_absolute() else db.BASE_DIR / p)
    candidates.append(db.BASE_DIR / "data" / _FILENAME)
    candidates.append(db.BASE_DIR.parent / _FILENAME)
    for cand in candidates:
        if cand.exists():
            return cand
    return None


def load_restricted(path: str | Path | None = None) -> dict:
    p = Path(path) if path else locate_seed()
    if p is None or not p.exists():
        raise FileNotFoundError("受限 taxonomy 数据文件未找到（adult_curated_taxonomy_seed.json）")
    seed = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(seed, dict) or not isinstance(seed.get("sections"), list):
        raise ValueError("受限 taxonomy 文件缺少 sections 数组")
    return seed


def resolve_seed(conn, seed: str) -> tuple[str | None, str]:
    """按 resolution_order 解析单个 seed，返回 (canonical_name | None, status)。"""
    s = str(seed).strip()
    if not s:
        return None, "empty"
    low = s.lower()

    # 1) exact canonical（空格或下划线形式）
    row = conn.execute(
        "SELECT danbooru_name FROM tags WHERE lower(prompt_tag)=? OR lower(danbooru_name)=? LIMIT 1",
        (low, low),
    ).fetchone()
    if row:
        return row["danbooru_name"], "resolved_canonical"

    # 2) exact alias
    row = conn.execute(
        "SELECT t.danbooru_name FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
        "WHERE lower(a.alias)=? LIMIT 1",
        (low,),
    ).fetchone()
    if row:
        return row["danbooru_name"], "resolved_alias"

    # 3) normalized canonical（下划线 ↔ 空格互转）
    alt = db.prompt_form(s) if "_" in s else db.underscore(s)
    alt_low = alt.lower()
    if alt_low != low:
        row = conn.execute(
            "SELECT danbooru_name FROM tags WHERE lower(prompt_tag)=? OR lower(danbooru_name)=? LIMIT 1",
            (alt_low, alt_low),
        ).fetchone()
        if row:
            return row["danbooru_name"], "resolved_canonical"

    return None, "unresolved_seed"


def import_restricted(conn, seed: dict | None = None) -> dict:
    """逐条解析受限 taxonomy 并写入 restricted_taxonomy_map，返回统计（不含全量值）。"""
    seed = seed if seed is not None else load_restricted()
    sections = seed["sections"]

    conn.executescript(db.SCHEMA)  # 确保 restricted_taxonomy_map 存在
    conn.execute("DELETE FROM restricted_taxonomy_map")
    conn.commit()

    rows: list[tuple] = []
    seen_seed: set[str] = set()
    canonical_owner: dict[str, str] = {}  # canonical -> 首个解析出它的 seed
    stats = {
        "categories": 0,
        "memberships": 0,
        "resolved_canonical": 0,
        "resolved_alias": 0,
        "unresolved_seed": 0,
        "duplicates": 0,
        "anomalous": 0,
        "unique_seed_strings": 0,
    }

    for sec in sections:
        sid = str(sec.get("id", ""))
        label = str(sec.get("title", sid))
        stats["categories"] += 1
        order = stats["categories"]  # section 顺序（1 起）
        for tag in sec.get("tags", []):
            tag = str(tag).strip()
            if not tag:
                continue
            stats["memberships"] += 1

            # 脏条目：不是 tag，保留但单独归类，不进 UI
            if _is_anomalous(tag):
                stats["anomalous"] += 1
                rows.append((sid, label, tag, "anomalous", None, order))
                continue

            canonical, status = resolve_seed(conn, tag)
            if status == "resolved_canonical":
                stats["resolved_canonical"] += 1
            elif status == "resolved_alias":
                stats["resolved_alias"] += 1
            else:
                stats["unresolved_seed"] += 1

            # duplicate：不同 seed 解析到同一 canonical
            if canonical and canonical in canonical_owner and canonical_owner[canonical] != tag:
                stats["duplicates"] += 1
            elif canonical:
                canonical_owner[canonical] = tag

            if tag not in seen_seed:
                seen_seed.add(tag)
                stats["unique_seed_strings"] += 1

            rows.append((sid, label, tag, status, canonical, order))

    conn.executemany(
        "INSERT OR REPLACE INTO restricted_taxonomy_map "
        "(section_id, section_label, seed, status, canonical_name, sort_order) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return stats


def main() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        print(json.dumps(import_restricted(conn), ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
