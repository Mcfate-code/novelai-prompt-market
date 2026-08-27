"""Semantic State — pure derivation layer over PromptDocument.

Consumes structured_state (dict) + optional generation_config.
Produces slot status (EMPTY/PARTIAL/FILLED/FILLED_BY_AUTO_PRESET),
evidence tags, semantic node assignment, and current intent.
No schema change, no DB writes, no LLM.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
SLOTS_PATH = BASE_DIR / "config" / "semantic_slots.json"
NAV_PATH = BASE_DIR / "config" / "prompt_navigation.json"

EMPTY = "empty"
PARTIAL = "partial"
FILLED = "filled"
FILLED_BY_AUTO_PRESET = "filled_by_auto_preset"

SUBJECT_COUNT_SLOT = {
    "node_id": "base_subject_count",
    "family": "subject_count",
    "label": "Subject / Count",
    "zh": "主体/人数",
}

SCENE_SLOTS = [
    {"node_id": "scene_participants", "label": "Participants", "zh": "人物"},
    {"node_id": "scene_primary_act", "label": "Primary Act", "zh": "主要行为"},
    {"node_id": "scene_interaction", "label": "Interaction", "zh": "互动关系"},
    {"node_id": "scene_stage", "label": "Stage", "zh": "阶段"},
    {"node_id": "scene_position", "label": "Position", "zh": "体位"},
    {"node_id": "scene_character_state", "label": "Character State", "zh": "角色状态"},
    {"node_id": "scene_additional_activities", "label": "Additional Activities", "zh": "附加活动"},
    {"node_id": "scene_body_focus", "label": "Body Focus", "zh": "身体焦点"},
    {"node_id": "scene_composition", "label": "Composition", "zh": "构图"},
    {"node_id": "scene_environment", "label": "Environment / Scenario", "zh": "环境"},
]

CHAR_PRIORITY = [
    "char_identity", "char_hair", "char_eyes", "char_face", "char_body",
    "char_clothing", "char_clothing_accessory", "char_expression",
    "char_pose", "char_action",
]
BASE_PRIORITY = [
    "base_subject_count", "env_indoor", "env_outdoor", "base_composition",
    "base_lighting", "base_time_weather", "base_objects", "base_style", "quality",
]

SECTION_NODE_FALLBACK = {
    "character": "char_identity",
    "expression": "char_expression",
    "clothing": "char_clothing",
    "composition": "base_composition",
    "style": "base_style",
    "quality": "quality",
}


def _norm(tag: str) -> str:
    return " ".join(str(tag or "").strip().lower().replace("_", " ").split())


# ---- Cached config loaders ----
_slots_cache: list[dict] | None = None
_nav_seeds_cache: dict[str, str] | None = None
_keyword_index_cache: dict[str, str] | None = None


def _load_slots_config() -> list[dict]:
    global _slots_cache
    if _slots_cache is None:
        _slots_cache = json.loads(SLOTS_PATH.read_text(encoding="utf-8"))
    return _slots_cache


def _load_nav_seeds() -> dict[str, str]:
    """Flatten prompt_navigation.json tree -> {tag: node_id} from seed_tags."""
    global _nav_seeds_cache
    if _nav_seeds_cache is None:
        seeds: dict[str, str] = {}
        try:
            tree = json.loads(NAV_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            tree = {}
        for root_key in ("base", "character"):
            root = tree.get(root_key) or {}
            _collect_seeds(root, seeds)
        _nav_seeds_cache = seeds
    return _nav_seeds_cache


def _collect_seeds(node: dict, seeds: dict[str, str]) -> None:
    nid = node.get("id")
    if nid:
        for tag in node.get("seed_tags") or []:
            key = _norm(tag)
            if key and key not in seeds:
                seeds[key] = nid
    for child in node.get("children") or []:
        _collect_seeds(child, seeds)


def _load_keyword_index() -> dict[str, str]:
    """{normalized_keyword: node_id} from semantic_slots.json keywords_en."""
    global _keyword_index_cache
    if _keyword_index_cache is None:
        idx: dict[str, str] = {}
        for slot in _load_slots_config():
            nid = slot.get("node_id", "")
            for kw in slot.get("keywords_en") or []:
                key = _norm(kw)
                if key and key not in idx:
                    idx[key] = nid
        _keyword_index_cache = idx
    return _keyword_index_cache


@dataclass
class SlotInfo:
    node_id: str
    label: str
    zh: str
    status: str
    evidence_tags: list[str] = field(default_factory=list)
    semantic_node: str | None = None
    reason: str = ""


@dataclass
class SemanticState:
    base_slots: list[SlotInfo]
    character_slots: list[list[SlotInfo]]
    scene_slots: list[SlotInfo]
    intent: dict
    summary: dict

    def missing_slots_for_target(self, target: str) -> list[SlotInfo]:
        """Return missing (EMPTY/PARTIAL) slots for base or char:N target."""
        if target == "base" or not target.startswith("char:"):
            return [s for s in self.base_slots if s.status in (EMPTY, PARTIAL)]
        try:
            idx = int(target.split(":")[1])
        except (ValueError, IndexError):
            return []
        if idx < 0 or idx >= len(self.character_slots):
            return []
        return [s for s in self.character_slots[idx] if s.status in (EMPTY, PARTIAL)]

    def next_steps(self, target: str | None = None, limit: int = 5) -> list[SlotInfo]:
        """Top missing slots ordered by priority."""
        missing = self.missing_slots_for_target(target or "base")
        is_char = target and target.startswith("char:")
        priority = CHAR_PRIORITY if is_char else BASE_PRIORITY
        # Sort by priority index (slots not in priority list go last, alphabetically)
        def _key(s: SlotInfo) -> tuple:
            try:
                return (0, priority.index(s.node_id))
            except ValueError:
                return (1, s.node_id)
        ordered = sorted(missing, key=_key)
        return ordered[:limit]


def _resolve_semantic_node(tag: str, conn: sqlite3.Connection | None = None) -> tuple[str | None, str]:
    """Return (node_id, source). Priority chain:
    1. slot keywords_en (most precise fine-grained node)
    2. prior.semantic_node_for_tag
    3. nav_seeds
    4. DB category (4 or 3 -> char_identity)
    5. section fallback (classify_tag -> SECTION_NODE_FALLBACK)
    6. None
    """
    key = _norm(tag)
    if not key:
        return (None, "unmapped")
    # 1. Slot keywords
    kw_idx = _load_keyword_index()
    if key in kw_idx:
        return (kw_idx[key], "slot_keyword")
    # 2. Prior table
    try:
        from prompt import prior as prior_mod
        nid = prior_mod.semantic_node_for_tag(key)
        if nid:
            return (nid, "prior_table")
    except Exception:
        pass
    # 3. Nav seeds
    seeds = _load_nav_seeds()
    if key in seeds:
        return (seeds[key], "nav_seed")
    # 4. DB category
    if conn is not None:
        try:
            row = conn.execute(
                "SELECT category FROM tags WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
                (tag, tag),
            ).fetchone()
            if row and row["category"] in (3, 4):
                return ("char_identity", "category")
        except Exception:
            pass
        # 5. Section fallback
        try:
            from prompt.sections import classify_tag
            section = classify_tag(conn, tag)
            fallback = SECTION_NODE_FALLBACK.get(section)
            if fallback:
                return (fallback, "section_fallback")
        except Exception:
            pass
    return (None, "unmapped")


def _collect_section_tags(sections: dict) -> list[tuple[str, str]]:
    """[(tag, section_name), ...] from a sections dict."""
    out: list[tuple[str, str]] = []
    if not isinstance(sections, dict):
        return out
    for section_name, entries in sections.items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            tag = ""
            if isinstance(entry, dict):
                tag = str(entry.get("tag", "")).strip()
            elif isinstance(entry, str):
                tag = entry.strip()
            if tag:
                out.append((tag, str(section_name)))
    return out


def _has_subject_count(tags: list[tuple[str, str]]) -> bool:
    try:
        from prompt.semantics import parse_subject_count
    except Exception:
        return False
    for tag, _ in tags:
        if parse_subject_count(tag):
            return True
    return False


def _has_character_name(tags: list[tuple[str, str]], conn) -> bool:
    if conn is None:
        return False
    for tag, _ in tags:
        try:
            row = conn.execute(
                "SELECT category FROM tags WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
                (tag, tag),
            ).fetchone()
            if row and row["category"] == 4:
                return True
        except Exception:
            pass
    return False


def _has_relation_entries(characters: list) -> bool:
    """Check if any character prompt has relation entries (source/target/mutual)."""
    for ch in characters:
        if not isinstance(ch, dict):
            continue
        for sections_dict in (ch.get("prompt_sections"), ch.get("uc_sections")):
            if not isinstance(sections_dict, dict):
                continue
            for entries in sections_dict.values():
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    if isinstance(entry, dict) and entry.get("relation") in ("source", "target", "mutual"):
                        return True
    return False


def _build_base_slots(state: dict, conn, generation_config) -> list[SlotInfo]:
    sections = state.get("sections") or {}
    all_tags = _collect_section_tags(sections)
    # Group tags by resolved node
    node_tags: dict[str, list[str]] = {}
    for tag, section in all_tags:
        nid, _src = _resolve_semantic_node(tag, conn)
        if nid:
            node_tags.setdefault(nid, []).append(tag)
    # Also track by section for fallback
    section_tags: dict[str, list[str]] = {}
    for tag, section in all_tags:
        section_tags.setdefault(section, []).append(tag)

    slots_config = _load_slots_config()
    result: list[SlotInfo] = []

    # Subject count slot
    has_sc = _has_subject_count(all_tags)
    sc_tags = [t for t, s in all_tags if _norm(t) in {n for n in []}]  # placeholder
    # Actually collect subject count tags:
    sc_tags = []
    try:
        from prompt.semantics import parse_subject_count
        sc_tags = [t for t, _ in all_tags if parse_subject_count(t)]
    except Exception:
        pass
    result.append(SlotInfo(
        node_id="base_subject_count", label=SUBJECT_COUNT_SLOT["label"],
        zh=SUBJECT_COUNT_SLOT["zh"],
        status=FILLED if has_sc else EMPTY,
        evidence_tags=sc_tags,
        semantic_node="base_subject_count",
        reason=f"已有 {', '.join(sc_tags[:3])}" if has_sc else "尚未设置",
    ))

    # Slots from config
    for slot in slots_config:
        nid = slot["node_id"]
        ev = node_tags.get(nid, [])
        # For scene slots (env_indoor/outdoor/etc), also check section "scene" tags
        if not ev and nid in ("env_indoor", "env_outdoor", "base_lighting", "base_time_weather", "base_objects"):
            scene_tags = section_tags.get("scene", [])
            if scene_tags and nid == "env_indoor":
                # Check if any scene tag maps to indoor keywords
                ev = [t for t in scene_tags if _norm(t) in _load_keyword_index() and _load_keyword_index()[_norm(t)] == nid]
        if not ev and nid == "base_composition":
            ev = section_tags.get("composition", [])
        if not ev and nid == "base_style":
            ev = section_tags.get("style", [])
        if not ev and nid == "quality":
            ev = section_tags.get("quality", [])
            # Check auto-preset
            tier = ""
            if generation_config and isinstance(generation_config, dict):
                tier = str(generation_config.get("positiveTier", generation_config.get("quality_preset", ""))).lower()
            if tier and tier not in ("", "off"):
                result.append(SlotInfo(
                    node_id=nid, label=slot.get("label", nid), zh=slot.get("zh", ""),
                    status=FILLED_BY_AUTO_PRESET, evidence_tags=ev,
                    semantic_node=nid, reason="由画质预设自动提供"))
                continue

        is_filled = bool(ev)
        result.append(SlotInfo(
            node_id=nid, label=slot.get("label", nid), zh=slot.get("zh", ""),
            status=FILLED if is_filled else EMPTY,
            evidence_tags=ev[:10], semantic_node=nid if is_filled else None,
            reason=f"已有 {', '.join(ev[:3])}" if is_filled else "尚未设置"))

    return result


def _build_character_slots(state: dict, conn) -> list[list[SlotInfo]]:
    characters = state.get("characters") or []
    slots_config = _load_slots_config()
    result: list[list[SlotInfo]] = []
    for ch in characters:
        if not isinstance(ch, dict):
            result.append([])
            continue
        prompt_sections = ch.get("prompt_sections") or {}
        all_tags = _collect_section_tags(prompt_sections)
        node_tags: dict[str, list[str]] = {}
        for tag, section in all_tags:
            nid, _ = _resolve_semantic_node(tag, conn)
            if nid:
                node_tags.setdefault(nid, []).append(tag)
        section_tags: dict[str, list[str]] = {}
        for tag, section in all_tags:
            section_tags.setdefault(section, []).append(tag)

        char_slots: list[SlotInfo] = []
        has_name = _has_character_name(all_tags, conn)
        has_sc = _has_subject_count(all_tags)

        for slot in slots_config:
            nid = slot["node_id"]
            ev = node_tags.get(nid, [])
            # Identity special: PARTIAL if only subject count, FILLED if character name
            if nid == "char_identity":
                if has_name:
                    char_slots.append(SlotInfo(nid, slot.get("label", nid), slot.get("zh", ""),
                        FILLED, ev[:10], nid, f"已有 {', '.join(ev[:3])}" if ev else "已有角色名"))
                elif has_sc:
                    sc_tags = [t for t, _ in all_tags]
                    try:
                        from prompt.semantics import parse_subject_count
                        sc_tags = [t for t, _ in all_tags if parse_subject_count(t)]
                    except Exception:
                        pass
                    char_slots.append(SlotInfo(nid, slot.get("label", nid), slot.get("zh", ""),
                        PARTIAL, sc_tags[:10], nid, "仅有主体计数"))
                else:
                    # 角色分区内已有标签（无需 DB/先验即可认定身份已填）
                    char_sec = section_tags.get("character", [])
                    if char_sec:
                        char_slots.append(SlotInfo(nid, slot.get("label", nid), slot.get("zh", ""),
                            FILLED, char_sec[:10], nid,
                            f"已有 {', '.join(char_sec[:3])}"))
                    else:
                        char_slots.append(SlotInfo(nid, slot.get("label", nid), slot.get("zh", ""),
                            EMPTY, [], None, "尚未设置"))
            else:
                is_filled = bool(ev)
                # Also check section fallback for clothing
                if not is_filled and nid == "char_clothing":
                    ev = section_tags.get("clothing", [])
                    is_filled = bool(ev)
                # Appearance-section fallback for hair/eyes (deterministic substring rules)
                if not is_filled and nid in ("char_hair", "char_eyes"):
                    app_tags = section_tags.get("appearance", [])
                    if nid == "char_hair":
                        ev = [t for t in app_tags if "hair" in _norm(t)]
                    elif nid == "char_eyes":
                        ev = [t for t in app_tags if "eye" in _norm(t)]
                    is_filled = bool(ev)
                char_slots.append(SlotInfo(nid, slot.get("label", nid), slot.get("zh", ""),
                    FILLED if is_filled else EMPTY, ev[:10],
                    nid if is_filled else None,
                    f"已有 {', '.join(ev[:3])}" if is_filled else "尚未设置"))
        result.append(char_slots)
    return result


def _build_scene_slots(state: dict) -> list[SlotInfo]:
    ctx = state.get("assistant_context") or {}
    if not isinstance(ctx, dict):
        ctx = {}
    characters = state.get("characters") or []
    sections = state.get("sections") or {}
    scene_section_tags = _collect_section_tags(sections)
    has_scene = any(s == "scene" for _, s in scene_section_tags)
    interactions = ctx.get("interactions") if isinstance(ctx.get("interactions"), list) else []
    has_relation = bool(interactions) or _has_relation_entries(characters)

    def _filled(val) -> bool:
        return val is not None and str(val).strip() not in ("", "0", "None")

    def _slot(nid, label, zh, filled, evidence=None):
        return SlotInfo(nid, label, zh,
            FILLED if filled else EMPTY,
            evidence or [], nid if filled else None,
            f"已有 {evidence[0]}" if filled and evidence else ("已设置" if filled else "尚未设置"))

    count = ctx.get("participant_count")
    count_exact = False
    try:
        count_exact = int(count) == len(characters) and 1 <= int(count) <= 3
    except (TypeError, ValueError):
        pass
    participants = _slot("scene_participants", "Participants", "人物", _filled(count), [str(count or "")])
    if count_exact:
        participants.status = PARTIAL
        participants.reason = "人数与角色槽已同步；本地库无已验证的非性别精确人数标签"
    return [
        participants,
        _slot("scene_primary_act", "Primary Act", "主要行为",
              _filled(ctx.get("primary_act")), [str(ctx.get("primary_act",""))]),
        _slot("scene_interaction", "Interaction", "互动关系", has_relation,
              [str(row.get("action", "")) for row in interactions if isinstance(row, dict)][:3]),
        _slot("scene_stage", "Stage", "阶段",
              _filled(ctx.get("stage")), [str(ctx.get("stage",""))]),
        _slot("scene_position", "Position", "体位",
              _filled(ctx.get("position")), [str(ctx.get("position",""))]),
        _slot("scene_character_state", "Character State", "角色状态",
              any(any(_filled(v) for v in (ctx.get(key) or {}).values()) for key in ("clothing_state", "character_state", "expressions"))),
        _slot("scene_additional_activities", "Additional Activities", "附加活动",
              bool(ctx.get("additional_activities")), list(ctx.get("additional_activities") or [])[:3]),
        _slot("scene_body_focus", "Body Focus", "身体焦点",
              _filled(ctx.get("body_focus")), [str(ctx.get("body_focus",""))]),
        _slot("scene_composition", "Composition", "构图", _filled(ctx.get("composition")), [str(ctx.get("composition", ""))]),
        _slot("scene_environment", "Environment / Scenario", "环境",
              _filled(ctx.get("primary_scene_type")) or _filled(ctx.get("environment")) or has_scene,
              [str(ctx.get("primary_scene_type") or ctx.get("environment") or "")] + [t for t,s in scene_section_tags if s=="scene"][:2]),
    ]


def _derive_intent(active_target: str, mode: str, active_node_id: str,
                   assistant_context: dict, last_added_tag: str) -> dict:
    target_type = "character" if active_target.startswith("char:") else ("base" if active_target == "base" else "unknown")
    node_id = active_node_id or None
    if not node_id and last_added_tag:
        node_id, _ = _resolve_semantic_node(last_added_tag, None)
    # Find zh label for description
    zh = ""
    for slot in _load_slots_config():
        if slot.get("node_id") == node_id:
            zh = slot.get("zh", "")
            break
    if node_id == "base_subject_count":
        zh = "主体/人数"
    for ss in SCENE_SLOTS:
        if ss["node_id"] == node_id:
            zh = ss["zh"]
    if target_type == "character":
        desc = f"正在编辑{zh}" if zh else "编辑角色"
    elif target_type == "base":
        desc = f"正在编辑{zh}" if zh else "编辑基础画面"
    else:
        desc = f"正在选择{zh}" if zh else ""
    return {"target": active_target, "node_id": node_id, "mode": mode, "description": desc}


def build_semantic_state(structured_state, *, conn=None, generation_config=None,
                         active_target="", mode="general", assistant_context=None,
                         last_added_tag="") -> SemanticState:
    state = structured_state if isinstance(structured_state, dict) else {}
    if assistant_context is not None:
        state = dict(state)
        state["assistant_context"] = assistant_context

    base_slots = _build_base_slots(state, conn, generation_config)
    character_slots = _build_character_slots(state, conn)
    scene_slots = _build_scene_slots(state)

    intent = _derive_intent(active_target, mode, "",
                            state.get("assistant_context") or {}, last_added_tag)

    # Summary
    all_slots = list(base_slots) + [s for chars in character_slots for s in chars] + list(scene_slots)
    filled = sum(1 for s in all_slots if s.status in (FILLED, FILLED_BY_AUTO_PRESET))
    partial = sum(1 for s in all_slots if s.status == PARTIAL)
    empty = sum(1 for s in all_slots if s.status == EMPTY)
    missing = [s for s in all_slots if s.status in (EMPTY, PARTIAL)]
    scene_filled = sum(1 for s in scene_slots if s.status in (FILLED, FILLED_BY_AUTO_PRESET))
    scene_partial = sum(1 for s in scene_slots if s.status == PARTIAL)
    summary = {"filled": filled, "partial": partial, "empty": empty,
               "total": len(all_slots), "missing_slots": len(missing)}
    summary["scene"] = {"filled": scene_filled, "partial": scene_partial,
                        "empty": len(scene_slots) - scene_filled - scene_partial, "total": len(scene_slots)}

    return SemanticState(base_slots=base_slots, character_slots=character_slots,
                         scene_slots=scene_slots, intent=intent, summary=summary)


__all__ = ["SlotInfo", "SemanticState", "build_semantic_state",
           "EMPTY", "PARTIAL", "FILLED", "FILLED_BY_AUTO_PRESET"]
