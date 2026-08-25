"""SQLite 数据底座。

按规格第 9 节建表：tags / tag_aliases / taxonomy_map / favorites / recent_tags / presets。
本模块是 app、importer、prompt 三个层共享的唯一 DB 访问入口。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "tags.sqlite"

# Danbooru category -> 名称
CATEGORY_NAMES = {
    0: "General",
    1: "Artist",
    3: "Copyright",
    4: "Character",
    5: "Meta",
}
CATEGORY_IDS = {v: k for k, v in CATEGORY_NAMES.items()}

SCHEMA = """
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY,
    danbooru_name TEXT NOT NULL UNIQUE,
    prompt_tag TEXT NOT NULL,
    category INTEGER NOT NULL DEFAULT 0,
    post_count INTEGER NOT NULL DEFAULT 0,
    is_deprecated INTEGER NOT NULL DEFAULT 0,
    zh_name TEXT,
    ja_name TEXT,
    ko_name TEXT,
    source TEXT NOT NULL DEFAULT 'danbooru',
    created_at TEXT,
    updated_at TEXT,
    synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(danbooru_name);
CREATE INDEX IF NOT EXISTS idx_tags_prompt ON tags(prompt_tag);
CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count);
CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category);

CREATE TABLE IF NOT EXISTS tag_aliases (
    alias TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    lang TEXT,
    source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alias_canonical ON tag_aliases(canonical_name);

CREATE TABLE IF NOT EXISTS taxonomy_map (
    tag_name TEXT NOT NULL,
    category_l1 TEXT NOT NULL,
    category_l2 TEXT,
    category_l3 TEXT,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY(tag_name, category_l1, category_l2, category_l3)
);

CREATE INDEX IF NOT EXISTS idx_taxonomy_l1 ON taxonomy_map(category_l1);

CREATE TABLE IF NOT EXISTS favorites (
    tag_name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_tags (
    tag_name TEXT PRIMARY KEY,
    last_used_at TEXT NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_catalog (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    nsfw INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    group_id TEXT,
    config_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_catalog_group ON tag_catalog(group_id);

CREATE TABLE IF NOT EXISTS restricted_taxonomy_map (
    section_id TEXT NOT NULL,
    section_label TEXT NOT NULL,
    seed TEXT NOT NULL,
    status TEXT NOT NULL,
    canonical_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (section_id, seed)
);

CREATE INDEX IF NOT EXISTS idx_restricted_section ON restricted_taxonomy_map(section_id);

CREATE TABLE IF NOT EXISTS user_zh (
    tag_name TEXT PRIMARY KEY,
    zh TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_thumbs (
    tag_name TEXT PRIMARY KEY,
    thumb_url TEXT NOT NULL,
    thumb_large_url TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_novelai_examples (
    tag_name TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    file_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    steps INTEGER NOT NULL,
    seed INTEGER,
    status TEXT NOT NULL DEFAULT 'ready',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tag_novelai_examples_status ON tag_novelai_examples(status);

CREATE TABLE IF NOT EXISTS user_tags (
    tag_name TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dir_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    negative_prompt TEXT NOT NULL DEFAULT '',
    parameters_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_gallery_dir ON gallery(dir_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_file ON gallery(dir_name, file_name);

CREATE TABLE IF NOT EXISTS gallery_favorites (
    dir_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (dir_name, file_name)
);

CREATE TABLE IF NOT EXISTS tag_section_override (
    tag_name TEXT PRIMARY KEY,
    section TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_bundle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_bundle_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id INTEGER NOT NULL REFERENCES tag_bundle(id) ON DELETE CASCADE,
    tag_name TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    section TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bundle_item_bundle ON tag_bundle_item(bundle_id, sort_order, id);

CREATE TABLE IF NOT EXISTS tag_cooccurrence (
    tag_a TEXT NOT NULL,
    tag_b TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tag_a, tag_b),
    CHECK (tag_a < tag_b)
);

CREATE TABLE IF NOT EXISTS tag_conflict (
    tag_a TEXT NOT NULL,
    tag_b TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (tag_a, tag_b),
    CHECK (tag_a < tag_b)
);

CREATE TABLE IF NOT EXISTS prompt_snapshot (
    id TEXT PRIMARY KEY,
    positive_prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    structured_state_json TEXT NOT NULL,
    generation_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT REFERENCES prompt_snapshot(id) ON DELETE SET NULL,
    gallery_id INTEGER REFERENCES gallery(id) ON DELETE SET NULL,
    source_asset_id TEXT,
    parameters_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_snapshot ON generation(snapshot_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_conn(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: str | Path | None = None) -> None:
    conn = get_conn(db_path)
    try:
        conn.executescript(SCHEMA)
        # 迁移：为新版本补列（用 PRAGMA 检测，避免 ALTER 已存在列报错）
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tag_thumbs)")}
        if cols and "thumb_large_url" not in cols:
            conn.execute(
                "ALTER TABLE tag_thumbs ADD COLUMN thumb_large_url TEXT NOT NULL DEFAULT ''"
            )
        gcols = {r["name"] for r in conn.execute("PRAGMA table_info(gallery)")}
        if gcols and "negative_prompt" not in gcols:
            conn.execute("ALTER TABLE gallery ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT ''")
        if gcols and "parameters_json" not in gcols:
            conn.execute("ALTER TABLE gallery ADD COLUMN parameters_json TEXT")
        if gcols and "snapshot_id" not in gcols:
            conn.execute("ALTER TABLE gallery ADD COLUMN snapshot_id TEXT REFERENCES prompt_snapshot(id)")
        if gcols and "source_asset_id" not in gcols:
            conn.execute("ALTER TABLE gallery ADD COLUMN source_asset_id TEXT")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_source_asset "
            "ON gallery(source_asset_id) WHERE source_asset_id IS NOT NULL"
        )
        for a, b, reason in (
            ("long hair", "short hair", "发长描述互斥"),
            ("closed eyes", "open eyes", "眼睛开合互斥"),
            ("looking at viewer", "looking away", "视线方向互斥"),
        ):
            tag_a, tag_b = sorted((a, b))
            conn.execute(
                "INSERT OR IGNORE INTO tag_conflict (tag_a, tag_b, reason, created_at) VALUES (?,?,?,?)",
                (tag_a, tag_b, reason, now_iso()),
            )
        conn.execute("PRAGMA user_version=3")
        conn.commit()
    finally:
        conn.close()


def underscore(tag: str) -> str:
    """prompt_tag（空格形式）-> Danbooru 下划线形式。"""
    return tag.replace(" ", "_")


def prompt_form(tag: str) -> str:
    """Danbooru 下划线形式 -> prompt 空格形式。"""
    return tag.replace("_", " ")


def serialize_tag(row, favorite: bool = False) -> dict | None:
    """把 tag 行统一转换为公开 API DTO。

    公开字段（规格 Stage 1）：
        tag       最终写入 Prompt 的字符串（空格形式，前端英文显示名）
        canonical 数据库 canonical（下划线形式，alias 解析 / 调试）
        zh        中文显示名
        category  Danbooru category 编号
        post_count 热度
        favorite  是否已收藏

    消除 prompt_tag / tag_name / zh_name / danbooru_name 与 tag / zh / canonical 的双轨命名。
    """
    if row is None:
        return None
    d = dict(row)
    out: dict = {}

    # tag
    if "prompt_tag" in d:
        out["tag"] = d["prompt_tag"]
    elif "tag_name" in d:
        out["tag"] = d["tag_name"]
    elif "tag" in d:
        out["tag"] = d["tag"]

    # canonical
    if "danbooru_name" in d:
        out["canonical"] = d["danbooru_name"]
    elif "name" in d:
        out["canonical"] = d["name"]
    elif "canonical" in d:
        out["canonical"] = d["canonical"]

    # zh
    if "zh_name" in d:
        out["zh"] = d["zh_name"]
    elif "zh" in d:
        out["zh"] = d["zh"]
    else:
        out["zh"] = ""

    out["category"] = d.get("category", 0)
    out["post_count"] = d.get("post_count", 0)
    out["favorite"] = bool(favorite) or bool(d.get("favorite") or d.get("fav"))

    # 透传其余有意义字段
    for k in (
        "is_deprecated", "ja_name", "ko_name", "created_at", "updated_at",
        "rank", "via", "category_name", "status", "section_id", "section_label",
    ):
        if k in d:
            out[k] = d[k]
    return out


# 兼容旧调用名（resolve_tag / search 等仍在用）
def tag_dict(row, favorite: bool = False) -> dict | None:
    return serialize_tag(row, favorite)


def upsert_tags(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """upsert tags 表。rows 中每项至少含 danbooru_name / prompt_tag / category。

    返回写入条数。可覆盖字段：post_count / is_deprecated / zh_name / ja_name /
    ko_name / source / created_at / updated_at / synced_at。
    """
    n = 0
    for r in rows:
        name = r["danbooru_name"]
        prompt = r.get("prompt_tag") or prompt_form(name)
        conn.execute(
            """
            INSERT INTO tags (
                danbooru_name, prompt_tag, category, post_count, is_deprecated,
                zh_name, ja_name, ko_name, source, created_at, updated_at, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(danbooru_name) DO UPDATE SET
                prompt_tag = excluded.prompt_tag,
                category = excluded.category,
                post_count = excluded.post_count,
                is_deprecated = excluded.is_deprecated,
                zh_name = COALESCE(excluded.zh_name, tags.zh_name),
                ja_name = COALESCE(excluded.ja_name, tags.ja_name),
                ko_name = COALESCE(excluded.ko_name, tags.ko_name),
                source = excluded.source,
                created_at = COALESCE(excluded.created_at, tags.created_at),
                updated_at = COALESCE(excluded.updated_at, tags.updated_at),
                synced_at = excluded.synced_at
            """,
            (
                name,
                prompt,
                r.get("category", 0),
                r.get("post_count", 0),
                int(bool(r.get("is_deprecated", 0))),
                r.get("zh_name"),
                r.get("ja_name"),
                r.get("ko_name"),
                r.get("source", "danbooru"),
                r.get("created_at"),
                r.get("updated_at"),
                r.get("synced_at"),
            ),
        )
        n += 1
    conn.commit()
    return n


def upsert_aliases(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """upsert tag_aliases。rows: {alias, canonical_name, lang, source}。"""
    n = 0
    for r in rows:
        conn.execute(
            """
            INSERT INTO tag_aliases (alias, canonical_name, lang, source)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(alias) DO UPDATE SET
                canonical_name = excluded.canonical_name,
                lang = excluded.lang,
                source = excluded.source
            """,
            (r["alias"], r["canonical_name"], r.get("lang"), r.get("source", "curated")),
        )
        n += 1
    conn.commit()
    return n


def load_json(path: str | Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
