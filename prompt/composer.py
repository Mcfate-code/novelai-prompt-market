"""Prompt Composer —— 组织 Base / Character / UC / 权重 / 关系前缀。"""
from __future__ import annotations

import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
OVERLAY_PATH = BASE_DIR / "config" / "model_overlays.json"

RELATIONS = ("source", "target", "mutual")


def load_overlay(model_id: str | None = None) -> dict:
    data = json.loads(OVERLAY_PATH.read_text(encoding="utf-8"))
    models = data["models"]
    model_id = model_id or data.get("default_model", "v5")
    if model_id not in models:
        model_id = data.get("default_model", "v5")
    overlay = dict(models[model_id])
    overlay["_all"] = data
    overlay["_model_id"] = model_id
    return overlay


def list_models() -> list[dict]:
    data = json.loads(OVERLAY_PATH.read_text(encoding="utf-8"))
    return [
        {"id": mid, "label": m["label"], "id_full": m["id"]}
        for mid, m in data["models"].items()
    ]


def format_number(x: float) -> str:
    if x is None:
        return ""
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return f"{x:g}"


def normalize_entry(raw) -> dict:
    """把 str 或 dict 归一为内部 entry：{tag, strength, brackets, relation}。"""
    if isinstance(raw, str):
        return {"tag": raw, "strength": None, "brackets": 0, "relation": None}
    if not isinstance(raw, dict):
        raise ValueError(f"非法 entry: {raw!r}")
    entry = {
        "tag": str(raw.get("tag", "")).strip(),
        "strength": raw.get("strength"),
        "brackets": int(raw.get("brackets", 0) or 0),
        "relation": raw.get("relation"),
    }
    if entry["strength"] is not None:
        try:
            entry["strength"] = float(entry["strength"])
        except (TypeError, ValueError):
            entry["strength"] = None
    if entry["relation"] not in RELATIONS:
        entry["relation"] = None
    return entry


def normalize_prompt_list(items) -> list[dict]:
    if not items:
        return []
    return [normalize_entry(x) for x in items]


def overlay_tags() -> set[str]:
    """所有 model-specific / renamed / special 标签（用于 Seed 存在性校验时标记 overlay_only）。"""
    data = json.loads(OVERLAY_PATH.read_text(encoding="utf-8"))
    out: set[str] = set()
    for m in data["models"].values():
        out.update(m.get("special_tags", []))
        for preset in list(m.get("quality_presets", {}).values()) + list(
            m.get("uc_presets", {}).values()
        ):
            out.update(parse_preset_tokens(preset))
    for group in data.get("special_tags", {}).values():
        out.update(x for x in group if " " in x or ":" in x or x != "year XXXX")
    out.update(data.get("renamed_tags", {}).keys())
    out.update(data.get("renamed_tags", {}).values())
    out.update({"year XXXX"})
    return {t for t in out if t}


def parse_preset_tokens(preset: str) -> list[str]:
    """从预设字符串里粗略拆出 tag token（用于 overlay 集合）。"""
    toks = []
    for piece in preset.split(","):
        piece = piece.strip()
        if not piece:
            continue
        # 去掉数值权重包裹: 1.5::tag::
        if "::" in piece:
            inner = piece.split("::")[1].strip()
            if inner:
                toks.append(inner)
        else:
            toks.append(piece)
    return toks


def conflict_hints(entries: list[dict], model_id: str | None = None) -> list[str]:
    """返回命中的“可能冲突”提示（只提示，不禁止导出）。"""
    data = json.loads(OVERLAY_PATH.read_text(encoding="utf-8"))
    pairs = data.get("conflict_hints", [])
    tags = {e["tag"] for e in normalize_prompt_list(entries)}
    hits = []
    for a, b in pairs:
        if a in tags and b in tags:
            hits.append(f"{a} ↔ {b}")
    return hits
