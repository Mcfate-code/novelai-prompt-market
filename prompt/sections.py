"""Prompt V2 固定分区与本地标签分类。"""
from __future__ import annotations

import re
import sqlite3

SECTIONS = (
    "character", "appearance", "clothing", "expression", "action",
    "composition", "scene", "style", "quality", "other",
)
SECTION_LABELS = {
    "character": "角色",
    "appearance": "外观",
    "clothing": "服装",
    "expression": "表情",
    "action": "动作",
    "composition": "构图",
    "scene": "场景",
    "style": "风格",
    "quality": "质量",
    "other": "其他",
}


def section_definitions() -> list[dict]:
    return [{"id": section, "label": SECTION_LABELS[section]} for section in SECTIONS]

_RULES = (
    ("quality", ("quality", "masterpiece", "best quality", "highres", "detailed", "resolution", "bad anatomy", "lowres")),
    ("style", ("style", "medium", "artist", "illustration", "painting", "sketch", "anime", "photorealistic", "monochrome")),
    ("composition", ("composition", "camera", "view", "shot", "angle", "focus", "depth of field", "portrait", "close-up", "full body")),
    ("scene", ("scene", "background", "location", "indoors", "outdoors", "sky", "room", "street", "forest", "beach", "night", "day")),
    ("action", ("action", "pose", "standing", "sitting", "lying", "running", "walking", "holding", "looking", "hug", "pointing")),
    ("expression", ("expression", "smile", "frown", "blush", "crying", "angry", "open mouth", "closed mouth", "eyes closed")),
    ("clothing", ("clothing", "clothes", "dress", "shirt", "skirt", "pants", "uniform", "jacket", "hat", "shoes", "gloves", "swimsuit")),
    ("appearance", ("appearance", "hair", "eyes", "skin", "body", "breasts", "face", "ears", "tail", "wings", "height", "age")),
    ("character", ("character", "person", "girl", "boy", "woman", "man", "solo", "multiple girls", "multiple boys")),
)


def validate_section(section: str) -> str:
    section = (section or "").strip().lower()
    if section not in SECTIONS:
        raise ValueError(f"无效 section: {section}")
    return section


def classify_tag(conn: sqlite3.Connection, tag: str) -> str:
    tag = (tag or "").strip()
    if not tag:
        return "other"
    row = conn.execute(
        "SELECT section FROM tag_section_override WHERE lower(tag_name)=lower(?)", (tag,)
    ).fetchone()
    if row:
        return row["section"]

    normalized = " ".join(re.sub(r"[^\w]+", " ", tag.lower().replace("_", " ")).split())
    row = conn.execute(
        "SELECT category, prompt_tag, danbooru_name FROM tags "
        "WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
        (tag, tag),
    ).fetchone()
    if row and row["category"] == 4:
        return "character"
    if row and row["category"] == 1:
        return "style"

    taxonomy = conn.execute(
        "SELECT category_l1, category_l2, category_l3 FROM taxonomy_map "
        "WHERE lower(tag_name)=lower(?) ORDER BY sort_order LIMIT 1",
        (tag,),
    ).fetchone()
    haystack = normalized
    if taxonomy:
        haystack += " " + " ".join(str(taxonomy[k] or "").lower() for k in taxonomy.keys())
    for section, keywords in _RULES:
        if any(keyword in haystack for keyword in keywords):
            return section
    return "other"


def classify_tags(conn: sqlite3.Connection, tags: list[str]) -> list[dict]:
    return [{"tag": tag, "section": classify_tag(conn, tag)} for tag in tags]
