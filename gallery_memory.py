"""Gallery Preference Memory v1 —— 本地事件 + 可重建偏好聚合。

只从「当前图库元数据 + gallery_events」重建全局/角色偏好，供 autocomplete 个性化重排
与 Smart Collections 使用。原则：
  - 无 ML / embedding / LLM / 聚类 / 魔法分值；只用可解释的计数与有序元组。
  - 只学用户亲手写的正向 Base 与 Character 标签；排除 Negative/UC 与自动追加的
    effective-only 质量档位 token（quality preset / transparent background）。
  - 全局与角色分离；角色身份用角色 prompt 里的稳定 canonical 标签（Danbooru
    Character/Copyright 类），绝不把「Character 1/2」当长期身份。
  - 数据永远只在本机 SQLite，绝不外发。

本模块是独立纯逻辑层（不 import app），便于单测；app.py 在路由层调用它。
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from pathlib import Path

import db

# 首个事件集合（规格冻结）：收藏 / 取消收藏 / 继续生成 / 恢复 / 删除。
# 不含 hover / open / scroll / render 事件。
EVENT_TYPES = frozenset(
    {"favorite", "unfavorite", "continue_generate", "restore", "delete"}
)

PRESET_CONFIG_PATH = Path(__file__).resolve().parent / "static" / "prompt-presets.json"

# 角色身份识别的 Danbooru 类别优先级：Character 优先，其次 Copyright（系列）。
IDENTITY_CATEGORIES = (4, 3)

WEIGHT_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)?|\.\d+)::(.+?)::\s*$")


def split_tags(text: str) -> list[str]:
    """把逗号分隔的 prompt 文本拆成标签（保留 NovelAI weight::tag:: 包裹，去掉权重）。

    与前端 prompt-tokenizer.splitPromptTokens 对齐：只按逗号切分，不解析花括号强调等。
    """
    if not text:
        return []
    out: list[str] = []
    for raw in str(text).split(","):
        token = raw.strip()
        if not token:
            continue
        m = WEIGHT_RE.match(token)
        if m:
            token = m.group(1).strip()
        if token:
            out.append(token)
    return out


def normalize_key(tag: str) -> str:
    """聚合键：小写 + 去首尾空白（与搜索 item.tag 的 prompt 空格形式对齐）。"""
    return (tag or "").strip().lower()


def _structured_entry_tags(value) -> list[str]:
    """收集 PromptState V2 entry 的 tag 字段。

    与 app._collect_structured_tags 同语义：只取 entry.tag 字符串，不把 section 元数据
    或普通字符串当标签；非 entry 结构（自由文本）不计入。
    """
    found: list[str] = []
    if isinstance(value, dict):
        tag = value.get("tag")
        if isinstance(tag, str) and tag.strip():
            found.append(tag.strip())
        for child in value.values():
            if isinstance(child, (dict, list)):
                found.extend(_structured_entry_tags(child))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                found.extend(_structured_entry_tags(child))
    return found


def _json_object(raw):
    try:
        value = json.loads(raw) if raw else None
        return value if isinstance(value, dict) else None
    except (TypeError, json.JSONDecodeError):
        return None


def _clean_authored(tags: list[str], extra_negative: set[str] | None = None) -> list[str]:
    """去重 authored tokens；不按名称屏蔽用户明确写入的 token。"""
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        key = normalize_key(tag)
        if not key:
            continue
        if extra_negative and key in extra_negative:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(tag.strip())
    return out


def _preset_quality_tags(meta: dict) -> set[str] | None:
    """Return auto positive tags only when legacy generation provenance is reliable."""
    try:
        config = json.loads(PRESET_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    model = meta.get("model")
    tier = meta.get("positiveTier", meta.get("quality_preset"))
    if not isinstance(model, str) or not model.strip() or not isinstance(tier, str):
        return None
    if tier == "off":
        # 可靠档位：不注入任何自动 positive（与前端 POSITIVE_TIERS.off 一致），
        # effective prompt 里的标签全部视为亲手写的。
        return set()
    quality = config.get("quality", {}).get(tier)
    if not isinstance(quality, list):
        return None
    tags = {normalize_key(t) for t in quality if isinstance(t, str)}
    if meta.get("transparentBackground") is True:
        tag = config.get("transparentBackgroundTag")
        if isinstance(tag, str):
            tags.add(normalize_key(tag))
    return tags


def _legacy_auto_tags(meta: dict, prompt_sources: dict) -> set[str] | None:
    """Resolve automatic positive provenance without guessing from token names."""
    if "autoPositive" in prompt_sources:
        values = prompt_sources.get("autoPositive")
        if not isinstance(values, list) or not all(isinstance(t, str) for t in values):
            return None
        return {normalize_key(t) for t in values if normalize_key(t)}
    return _preset_quality_tags(meta)


def _structured_positive_tags(snapshot_state: dict) -> list[str]:
    sections = snapshot_state.get("sections")
    if not isinstance(sections, dict):
        return []
    tags: list[str] = []
    for name, value in sections.items():
        key = str(name).lower()
        if any(word in key for word in ("negative", "uc", "effective", "auto")):
            continue
        tags.extend(_structured_entry_tags(value))
    return tags


def _character_identity(char_tags: list[str], known_categories: dict[str, int]) -> str | None:
    """从角色标签里挑稳定 canonical 身份：Danbooru Character(4) 优先，其次 Copyright(3)。

    找不到稳定身份时返回 None（这些标签只计入全局，不用 Character N 当身份）。
    """
    for tag in char_tags:
        category = known_categories.get(normalize_key(tag))
        if category in IDENTITY_CATEGORIES:
            return tag.strip()
    return None


def _tag_category_map(conn: sqlite3.Connection) -> dict[str, int]:
    """prompt_tag（小写）-> Danbooru category，仅载入角色身份识别所需的 Character/Copyright 类。"""
    mapping: dict[str, int] = {}
    for row in conn.execute(
        "SELECT prompt_tag, category FROM tags WHERE category IN (4, 3)"
    ):
        mapping[(row["prompt_tag"] or "").strip().lower()] = row["category"]
    return mapping


def extract_asset_preferences(
    conn: sqlite3.Connection,
    row,
    snapshot_state: dict | None = None,
    known_categories: dict[str, int] | None = None,
) -> tuple[list[str], list[dict]]:
    """从单条图库行提取 (base_positive_tags, characters[{identity, tags}])。

    优先级（正向 Base）：
      meta.promptSources.userPositive → meta.rawPrompt → structured authored sections →
      legacy effectivePrompt（仅可靠 generation config）。
    优先级（角色正向）：
      meta.characterPrompts → recipe.characters → structured_state characters。
      全部只学正向；Negative/UC 永不读取。只有 provenance 缺失的 legacy effective fallback
      才减去共享 preset 中可确认的自动 token。
    """
    if known_categories is None:
        known_categories = _tag_category_map(conn)
    params = _json_object(row["parameters_json"]) if "parameters_json" in row.keys() else None
    params = params if isinstance(params, dict) else {}
    meta = params.get("meta") if isinstance(params.get("meta"), dict) else {}

    negative_keys: set[str] = set()
    for field in ("rawNegative", "effectiveNegative"):
        value = meta.get(field)
        if isinstance(value, str) and value:
            negative_keys.update(normalize_key(t) for t in split_tags(value))
    if "negative_prompt" in row.keys() and row["negative_prompt"]:
        negative_keys.update(normalize_key(t) for t in split_tags(row["negative_prompt"]))

    # ---- Base 正向 ----
    base_tags: list[str] = []
    prompt_sources = meta.get("promptSources") if isinstance(meta.get("promptSources"), dict) else {}
    user_positive = prompt_sources.get("userPositive")
    if isinstance(user_positive, list) and user_positive:
        base_tags = [str(t) for t in user_positive if isinstance(t, str) and t.strip()]
    else:
        raw_prompt = meta.get("rawPrompt")
        if isinstance(raw_prompt, str) and raw_prompt.strip():
            base_tags = split_tags(raw_prompt)
        elif isinstance(snapshot_state, dict):
            base_tags = _structured_positive_tags(snapshot_state)
            if not base_tags:
                effective = meta.get("effectivePrompt")
                if isinstance(effective, str) and effective.strip():
                    base_tags = split_tags(effective)
                    auto_tags = _legacy_auto_tags(meta, prompt_sources)
                    base_tags = ([t for t in base_tags if normalize_key(t) not in auto_tags]
                                 if auto_tags is not None else [])
        elif isinstance(meta.get("effectivePrompt"), str) and meta["effectivePrompt"].strip():
            base_tags = split_tags(meta["effectivePrompt"])
            auto_tags = _legacy_auto_tags(meta, prompt_sources)
            if auto_tags is None:
                base_tags = []
            else:
                base_tags = [t for t in base_tags if normalize_key(t) not in auto_tags]
        elif "prompt" in row.keys() and row["prompt"]:
            # Old rows store effective prompt in gallery.prompt; only use it with reliable config.
            base_tags = split_tags(row["prompt"])
            auto_tags = _legacy_auto_tags(meta, prompt_sources)
            base_tags = ([t for t in base_tags if normalize_key(t) not in auto_tags]
                         if auto_tags is not None else [])
    base_tags = _clean_authored(base_tags, negative_keys)

    # ---- Character 正向 ----
    characters: list[dict] = []
    char_prompts: list[str] = []
    character_prompts = meta.get("characterPrompts")
    if not (isinstance(character_prompts, list) and character_prompts):
        character_prompts = params.get("characters")
    if isinstance(character_prompts, list):
        for ch in character_prompts:
            if isinstance(ch, dict) and isinstance(ch.get("prompt"), str) and ch["prompt"].strip():
                char_prompts.append(ch["prompt"].strip())
    if not char_prompts and isinstance(snapshot_state, dict):
        for ch in snapshot_state.get("characters") or []:
            if isinstance(ch, dict) and isinstance(ch.get("prompt_sections"), dict):
                tags = _structured_entry_tags(ch["prompt_sections"])
                if tags:
                    char_prompts.append(", ".join(tags))
    for prompt in char_prompts:
        tags = _clean_authored(split_tags(prompt), negative_keys)
        identity = _character_identity(tags, known_categories)
        characters.append({"identity": identity, "tags": tags})

    return base_tags, characters


def compact_delete_context(
    conn: sqlite3.Connection,
    row,
    snapshot_state: dict | None = None,
    known_categories: dict[str, int] | None = None,
) -> dict:
    """删除前的紧凑分析上下文：只保留正向 Base/Character 标签，不含完整元数据。"""
    base_tags, characters = extract_asset_preferences(conn, row, snapshot_state, known_categories)
    return {
        "positive_base": base_tags[:60],
        "characters": [
            {"identity": ch["identity"], "tags": ch["tags"][:60]} for ch in characters
        ],
    }


def load_snapshot_state(conn: sqlite3.Connection, snapshot_id: str | None) -> dict | None:
    if not snapshot_id:
        return None
    row = conn.execute(
        "SELECT structured_state_json FROM prompt_snapshot WHERE id=?", (snapshot_id,)
    ).fetchone()
    if not row:
        return None
    return _json_object(row["structured_state_json"])


def parent_payload(parent: dict | None, parameters: dict | None) -> dict | None:
    """把显式 parent 或 recipe.meta.parent 规整为可跨 API 边界的稳定身份对象。

    只保留 {dir_name, file_name, source_asset_id}；空/缺字段一律丢弃，绝不复用
    source_asset_id 之外的含义。返回 None 表示无父级（空白工作区生图）。
    """
    candidate = parent if isinstance(parent, dict) else None
    if not candidate and isinstance(parameters, dict):
        meta = parameters.get("meta")
        if isinstance(meta, dict):
            candidate = meta.get("parent") if isinstance(meta.get("parent"), dict) else None
    if not candidate:
        return None
    clean = {}
    for key in ("dir_name", "file_name", "source_asset_id"):
        value = candidate.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()
    if "dir_name" not in clean or "file_name" not in clean:
        return None
    return clean


def record_event(
    conn: sqlite3.Connection,
    dir_name: str,
    file_name: str,
    source_asset_id: str | None = None,
    event_type: str = "continue_generate",
    context: dict | None = None,
) -> None:
    """幂等地写入一条图库事件。event_type 白名单校验，未知类型直接报错。"""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown gallery event type: {event_type}")
    conn.execute(
        "INSERT INTO gallery_events (dir_name, file_name, source_asset_id, event_type, created_at, context_json) "
        "VALUES (?,?,?,?,?,?)",
        (
            dir_name,
            file_name,
            source_asset_id,
            event_type,
            db.now_iso(),
            json.dumps(context, ensure_ascii=False) if context else None,
        ),
    )


def _event_asset_sets(conn: sqlite3.Connection) -> dict[str, set[tuple[str, str]]]:
    """按事件类型返回 (dir_name, file_name) 集合（continue/restore/delete）。"""
    sets: dict[str, set[tuple[str, str]]] = {
        "continue_generate": set(),
        "restore": set(),
        "delete": set(),
    }
    for row in conn.execute(
        "SELECT dir_name, file_name, event_type FROM gallery_events"
    ):
        key = (row["dir_name"], row["file_name"])
        bucket = sets.get(row["event_type"])
        if bucket is not None:
            bucket.add(key)
    return sets


def build_preferences(
    conn: sqlite3.Connection,
    global_limit: int = 300,
    char_limit: int = 50,
    char_tag_limit: int = 100,
    cooccur_tag_limit: int = 200,
    cooccur_partner_limit: int = 20,
) -> dict:
    """从当前图库元数据 + 事件重建全局/角色/共现偏好。可随时重算，无缓存依赖。"""
    known_categories = _tag_category_map(conn)
    event_sets = _event_asset_sets(conn)
    favorited = {
        (r["dir_name"], r["file_name"])
        for r in conn.execute("SELECT dir_name, file_name FROM gallery_favorites")
    }

    global_count: Counter = Counter()
    global_strong: Counter = Counter()
    char_tags: dict[str, Counter] = {}
    char_assets: Counter = Counter()
    cooccur: dict[str, Counter] = {}

    rows = conn.execute(
        "SELECT id, dir_name, file_name, prompt, negative_prompt, parameters_json, snapshot_id, source_asset_id "
        "FROM gallery"
    ).fetchall()

    for row in rows:
        snap = load_snapshot_state(conn, row["snapshot_id"])
        base_tags, characters = extract_asset_preferences(conn, row, snap, known_categories)
        key = (row["dir_name"], row["file_name"])
        strong = key in favorited or key in event_sets["continue_generate"]

        positive: list[str] = []
        for tag in base_tags:
            k = normalize_key(tag)
            global_count[k] += 1
            if strong:
                global_strong[k] += 1
            positive.append(k)
        for ch in characters:
            if ch["identity"]:
                bucket = char_tags.setdefault(normalize_key(ch["identity"]), Counter())
                char_assets[normalize_key(ch["identity"])] += 1
                for tag in ch["tags"]:
                    k = normalize_key(tag)
                    bucket[k] += 1
                    global_count[k] += 1
                    if strong:
                        global_strong[k] += 1
                    positive.append(k)
            else:
                for tag in ch["tags"]:
                    k = normalize_key(tag)
                    global_count[k] += 1
                    if strong:
                        global_strong[k] += 1
                    positive.append(k)

        unique = sorted(set(positive))
        for i, a in enumerate(unique):
            bucket = cooccur.setdefault(a, Counter())
            for b in unique[i + 1:]:
                bucket[b] += 1

    top_global = sorted(
        global_count.items(), key=lambda kv: (global_strong.get(kv[0], 0), kv[1], kv[0]), reverse=True
    )[:global_limit]
    top_chars = sorted(char_tags.items(), key=lambda kv: (char_assets[kv[0]], len(kv[1])), reverse=True)[:char_limit]

    cooccur_out: dict[str, dict[str, int]] = {}
    for tag, partners in sorted(cooccur.items(), key=lambda kv: -sum(kv[1].values()))[:cooccur_tag_limit]:
        cooccur_out[tag] = dict(partners.most_common(cooccur_partner_limit))

    return {
        "global_tags": {
            tag: {"count": global_count[tag], "strong": global_strong.get(tag, 0)}
            for tag, _ in top_global
        },
        "character_tags": {
            identity: {
                "count": char_assets[identity],
                "tags": dict(char_tags[identity].most_common(char_tag_limit)),
            }
            for identity, _ in top_chars
        },
        "cooccurrence": cooccur_out,
        "totals": {
            "assets": len(rows),
            "favorites": len(favorited),
            "continues": len(event_sets["continue_generate"]),
            "restores": len(event_sets["restore"]),
            "deletes": len(event_sets["delete"]),
        },
    }


def collection_items(
    conn: sqlite3.Connection,
    kind: str,
    value: str | None = None,
) -> list[dict]:
    """返回某虚拟合集命中的图库行（带 dir_name / favorite 标记，供 app 序列化）。

    只做索引过滤，绝不移动/复制文件。
    """
    base_sql = (
        "SELECT g.id, g.dir_name, g.file_name, g.prompt, g.negative_prompt, g.parameters_json, "
        "g.file_path, g.snapshot_id, g.source_asset_id, g.parent_json, g.created_at, "
        "(f.dir_name IS NOT NULL) favorite "
        "FROM gallery g LEFT JOIN gallery_favorites f USING (dir_name, file_name) "
    )
    if kind == "favorites":
        rows = conn.execute(base_sql + "WHERE f.dir_name IS NOT NULL ORDER BY g.id DESC").fetchall()
        return [dict(r) for r in rows]
    if kind in ("continue_generate", "restore"):
        rows = conn.execute(
            base_sql + "WHERE EXISTS (SELECT 1 FROM gallery_events e "
            "WHERE e.dir_name=g.dir_name AND e.file_name=g.file_name AND e.event_type=?) "
            "ORDER BY g.id DESC",
            (kind,),
        ).fetchall()
        return [dict(r) for r in rows]
    if kind in ("character", "tag"):
        # 用 value 命中后，再逐行提取校验（集合口径与 build_preferences 一致）。
        candidates = conn.execute(base_sql + "ORDER BY g.id DESC").fetchall()
        known_categories = _tag_category_map(conn)
        needle = normalize_key(value or "")
        matched: list[dict] = []
        for row in candidates:
            snap = load_snapshot_state(conn, row["snapshot_id"])
            base_tags, characters = extract_asset_preferences(conn, row, snap, known_categories)
            if kind == "tag":
                hit = needle in {normalize_key(t) for t in base_tags} or any(
                    needle in {normalize_key(t) for t in ch["tags"]} for ch in characters
                )
            else:  # character
                hit = any(
                    normalize_key(ch["identity"]) == needle for ch in characters if ch["identity"]
                )
            if hit:
                matched.append(dict(row))
        return matched
    raise ValueError(f"unknown collection kind: {kind}")


def collection_meta(conn: sqlite3.Connection) -> dict:
    """Smart Collections 侧栏元信息：三类固定合集计数 + 角色/标签聚合候选。"""
    favs = conn.execute("SELECT COUNT(*) c FROM gallery_favorites").fetchone()["c"]
    event_sets = _event_asset_sets(conn)
    prefs = build_preferences(conn)
    return {
        "favorites": favs,
        "continued": len(event_sets["continue_generate"]),
        "restored": len(event_sets["restore"]),
        "characters": [
            {"identity": identity, "count": info["count"]}
            for identity, info in prefs["character_tags"].items()
        ],
        "tags": [
            {"tag": tag, "count": info["count"]}
            for tag, info in prefs["global_tags"].items()
        ],
    }
