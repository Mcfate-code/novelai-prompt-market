"""把完整生成 Prompt 蒸馏成可替换的成人姿势/构图模板。

该模块不生成图片，也不保存原图。它只保留姿势、动作、关系和镜头信息，
把角色身份、画风、LoRA、质量词和生成参数列为移除项，供人工审核后进入
NSFW Builder。未知标签不会被擅自改写，只会进入 unresolved/review。
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from prompt import import_parser, prior_safety, sections

BASE_DIR = Path(__file__).resolve().parents[1]
TAXONOMY_PATH = BASE_DIR / "data" / "nsfw_taxonomy.json"

_taxonomy_cache: dict | None = None


def _taxonomy() -> dict:
    global _taxonomy_cache
    if _taxonomy_cache is None:
        try:
            _taxonomy_cache = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _taxonomy_cache = {}
    return _taxonomy_cache if isinstance(_taxonomy_cache, dict) else {}


def _taxonomy_sets() -> tuple[set[str], set[str], set[str]]:
    positions: set[str] = set()
    camera: set[str] = set()
    actions: set[str] = set()
    for category in _taxonomy().get("categories") or []:
        cid = str(category.get("id") or "")
        values = {" ".join(str(tag).strip().lower().replace("_", " ").split()) for tag in category.get("tags") or [] if str(tag).strip()}
        if cid == "nsfw_positions":
            positions |= values
        elif cid == "nsfw_camera":
            camera |= values
        elif cid in {"nsfw_sex", "nsfw_foreplay", "nsfw_masturbation", "nsfw_oral", "nsfw_nonpenetrative", "nsfw_group", "nsfw_yuri", "nsfw_yaoi", "nsfw_futanari", "nsfw_after"}:
            actions |= values
    return positions, camera, actions


POSE_TAGS, CAMERA_TAGS, ACTION_TAGS = _taxonomy_sets()
CORE_TAGS = POSE_TAGS | CAMERA_TAGS | ACTION_TAGS

_POSE_HINTS = (
    "standing", "kneeling", "sitting", "lying", "reclining", "squatting", "crouching",
    "on all fours", "bent over", "arched back", "legs up", "legs spread", "from behind",
    "from above", "from below", "side view", "profile", "facing", "straddling", "mounting",
    "hug", "kissing", "holding", "touching", "groping", "sex", "oral", "penetration",
)
_QUALITY_HINTS = (
    "masterpiece", "best quality", "high quality", "highres", "absurdres", "very aesthetic",
    "ultra detailed", "detailed", "8k", "4k", "lowres", "bad anatomy", "worst quality",
)
_MODEL_RE = re.compile(r"^(?:<[^>]+>|\b(?:lora|lyco|embedding|textual inversion)\s*[:/])", re.I)
_COUNT_RE = re.compile(r"^(\d+)\s*(girls?|boys?|women?|men?|people|persons?|characters?)$", re.I)
_PAIR_POSITION_HINTS = frozenset({
    "missionary", "mating press", "anvil position", "doggystyle", "sex from behind", "prone bone",
    "standing sex", "standing missionary", "spooning", "girl on top", "cowgirl position",
    "squatting cowgirl position", "reverse cowgirl position", "reverse squatting cowgirl position",
    "upright straddle", "reverse upright straddle", "amazon position", "boy on top", "piledriver",
    "mounting", "suspended congress", "reverse suspended congress", "full nelson", "69", "upright 69",
})


def _norm(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def _db_meta(conn, tag: str) -> dict:
    if conn is None:
        return {}
    try:
        row = conn.execute(
            "SELECT t.prompt_tag, t.danbooru_name, t.category FROM tags t "
            "WHERE lower(t.prompt_tag)=lower(?) OR lower(t.danbooru_name)=lower(?) LIMIT 1",
            (tag, tag),
        ).fetchone()
        if row:
            return {"canonical": row["prompt_tag"], "category": row["category"], "resolved": True}
        alias = conn.execute(
            "SELECT t.prompt_tag, t.category FROM tag_aliases a JOIN tags t ON t.danbooru_name=a.canonical_name "
            "WHERE lower(a.alias)=lower(?) LIMIT 1", (tag,),
        ).fetchone()
        if alias:
            return {"canonical": alias["prompt_tag"], "category": alias["category"], "resolved": True, "via": "alias"}
    except Exception:
        return {}
    return {}


def _canonical(conn, tag: str) -> tuple[str, dict]:
    meta = _db_meta(conn, tag)
    return str(meta.get("canonical") or tag).strip(), meta


def _count(tag: str) -> int | None:
    m = _COUNT_RE.fullmatch(_norm(tag))
    return int(m.group(1)) if m else None


def _is_core(tag: str, section: str = "") -> bool:
    key = _norm(tag)
    return key in CORE_TAGS or any(hint in key for hint in _POSE_HINTS) or section in {"action", "composition"}


def _slot(tag: str, section: str) -> str:
    key = _norm(tag)
    if key in CAMERA_TAGS or section == "composition":
        return "camera_angle" if any(x in key for x in ("from ", "angle", "view", "pov", "shot")) else "framing"
    if key in POSE_TAGS or any(h in key for h in _POSE_HINTS):
        return "adult_position"
    if section == "action" or key in ACTION_TAGS:
        return "interaction_role"
    if section == "expression":
        return "optional_expression"
    if section == "scene":
        return "optional_environment"
    return "optional_context"


def _section(conn, tag: str) -> str:
    if conn is None:
        return ""
    try:
        return sections.classify_tag(conn, tag)
    except Exception:
        return ""


def _entry(tag: str, *, role: str | None, slot: str, confidence: float, original: dict | None = None) -> dict:
    item = {"tag": tag, "slot": slot, "role": role or "base", "confidence": round(float(confidence), 3)}
    if original and original.get("strength") is not None:
        item["weight"] = original["strength"]
    return item


def _hash_structure(value: dict) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:24]


def distill_prompt(prompt: str | dict, *, conn=None, metadata: dict | None = None) -> dict:
    """返回可人工审核的姿势模板草稿。"""
    parsed = import_parser.parse(prompt) if isinstance(prompt, str) else (prompt if isinstance(prompt, dict) else {})
    if not isinstance(parsed, dict):
        parsed = {}
    characters = parsed.get("characters") if isinstance(parsed.get("characters"), list) else []
    raw_entries: list[tuple[dict, str, int | None]] = []
    raw_entries.extend((e, "base", None) for e in parsed.get("base") or [] if isinstance(e, dict))
    for index, character in enumerate(characters):
        if not isinstance(character, dict):
            continue
        raw_entries.extend((e, "character", index) for e in character.get("prompt") or [] if isinstance(e, dict))

    participant_count = len(characters) or 0
    for entry, _origin, _index in raw_entries:
        participant_count = max(participant_count, _count(str(entry.get("tag") or "")) or 0)
    participant_count = max(1, min(6, participant_count or 1))

    role_tags: list[list[str]] = [[] for _ in range(participant_count)]
    base_tags: list[str] = []
    camera_tags: list[str] = []
    composition_tags: list[str] = []
    optional_tags: list[str] = []
    removed_tags: list[dict] = []
    unresolved: list[str] = []
    slots: list[dict] = []
    relation_entries: list[dict] = []
    adult_evidence = False
    age_flags: list[str] = []
    validation_total = 0
    validation_hits = 0

    def add_unique(target: list[str], tag: str) -> None:
        if _norm(tag) and _norm(tag) not in {_norm(x) for x in target}:
            target.append(tag)

    for entry, origin, char_index in raw_entries:
        raw_tag = str(entry.get("tag") or "").strip()
        if not raw_tag:
            continue
        key = _norm(raw_tag)
        if _count(raw_tag) is not None:
            participant_count = max(participant_count, _count(raw_tag) or 1)
            continue
        validation_total += 1
        # 这些关系/体位本身就是成人语义，可作为成人证据；仅有镜头词
        # （例如 from behind）不能单独把普通图片升级为成人模板。
        explicit_adult_pose = key in _PAIR_POSITION_HINTS
        if explicit_adult_pose or key in {"sex", "sexual", "vaginal sex", "anal sex", "oral sex"}:
            participant_count = max(participant_count, 2)
            adult_evidence = True
        safety = prior_safety.classify_tag_safety(raw_tag, meta=metadata or {})
        if safety in {"minor_like", "age_ambiguous"}:
            age_flags.append(raw_tag)
        if safety == "adult":
            adult_evidence = True
        canonical, meta = _canonical(conn, raw_tag)
        section = _section(conn, canonical)
        is_identity = meta.get("category") in {3, 4, "3", "4"}
        is_style = meta.get("category") in {1, "1"} or section in {"style", "quality"}
        is_model = bool(_MODEL_RE.search(raw_tag))
        is_quality = key in {_norm(x) for x in _QUALITY_HINTS} or any(key == _norm(x) for x in _QUALITY_HINTS)
        if is_identity:
            removed_tags.append({"tag": raw_tag, "reason": "角色/版权身份", "origin": origin})
            continue
        if is_style:
            removed_tags.append({"tag": raw_tag, "reason": "画风/艺术家", "origin": origin})
            continue
        if is_model:
            removed_tags.append({"tag": raw_tag, "reason": "LoRA/Embedding/模型标记", "origin": origin})
            continue
        if is_quality:
            removed_tags.append({"tag": raw_tag, "reason": "质量词", "origin": origin})
            continue

        core = _is_core(canonical, section)
        # 本地 SQLite 命中或 curated 成人 taxonomy 命中都算“已知”；其余候选
        # 进入 unresolved，批准时要求整体有效率达到 80%。
        if meta.get("resolved") or core:
            validation_hits += 1
        if not meta.get("resolved") and not core:
            unresolved.append(raw_tag)
        if core:
            confidence = 0.96 if meta.get("resolved") else 0.68
            role = None
            relation = str(entry.get("relation") or "").lower()
            if relation in {"source", "target", "mutual"}:
                role = relation
                role_index = 0 if relation == "source" else 1
                if relation == "mutual":
                    role_index = 0
                while len(role_tags) <= role_index:
                    role_tags.append([])
                add_unique(role_tags[role_index], canonical)
                if relation == "mutual" and len(role_tags) > 1:
                    add_unique(role_tags[1], canonical)
                relation_entries.append({"source": 0, "target": 1, "action": canonical, "relation": "mutual" if relation == "mutual" else "directional"})
            elif origin == "character" and char_index is not None:
                while len(role_tags) <= char_index:
                    role_tags.append([])
                add_unique(role_tags[char_index], canonical)
                role = f"char:{char_index}"
            elif canonical in CAMERA_TAGS or section == "composition":
                add_unique(camera_tags, canonical)
                add_unique(composition_tags, canonical)
                role = "base"
            else:
                add_unique(base_tags, canonical)
                role = "base"
            slots.append(_entry(canonical, role=role, slot=_slot(canonical, section), confidence=confidence, original=entry))
            # CAMERA_TAGS 只描述镜头，不能单独提供成人证据；姿势/动作词或
            # 来源/标签安全分类的 adult 结果才可以作为批准依据。
            if canonical in (POSE_TAGS | ACTION_TAGS) or safety == "adult":
                adult_evidence = True
        elif section in {"clothing", "expression", "scene"}:
            add_unique(optional_tags, canonical)
            slots.append(_entry(canonical, role=f"char:{char_index}" if char_index is not None else "base", slot=_slot(canonical, section), confidence=0.75, original=entry))
        else:
            removed_tags.append({"tag": raw_tag, "reason": "与姿势/构图无关的外观或上下文", "origin": origin})

    # 显式角色分段没有 relation 时，保留角色位置；没有分段时不虚构角色分配。
    if not relation_entries and participant_count >= 2:
        # 无显式关系时仍建立可编译的多人关系，但不把它伪装成性行为。
        # 只有前面已经识别到成人证据时才使用 sex action。
        action = "sex" if adult_evidence else "interact"
        relation_entries = [{"source": i, "target": (i + 1) % participant_count, "action": action, "relation": "directional"} for i in range(participant_count)]
    if any(r.get("action") == "sex" for r in relation_entries):
        adult_evidence = True

    # 关系前缀可能暗示两人，但 Prompt 没写人数时需要补齐角色槽。
    if relation_entries and participant_count < 2:
        participant_count = 2
        while len(role_tags) < participant_count:
            role_tags.append([])
    role_tags = role_tags[:participant_count] + [[] for _ in range(max(0, participant_count - len(role_tags)))]

    coverage = round(min(1.0, validation_hits / max(1, validation_total)), 3)
    pose_completeness = min(1.0, (len(base_tags) + sum(len(v) for v in role_tags)) / 4.0)
    composition_completeness = min(1.0, len(camera_tags) / 2.0)
    relationship_confidence = 1.0 if characters or any(e.get("relation") for e, _o, _i in raw_entries) else 0.55
    completeness = round(0.30 * coverage + 0.35 * pose_completeness + 0.20 * relationship_confidence + 0.15 * composition_completeness, 3)
    structure = {
        "schema_version": 1,
        "participant_count": participant_count,
        "base_tags": base_tags,
        "camera_tags": camera_tags,
        "composition_tags": composition_tags,
        "role_tags": role_tags,
        "relations": relation_entries,
        "optional_tags": optional_tags,
        "slots": slots,
        "removed_tags": removed_tags,
        "unresolved_tags": list(dict.fromkeys(unresolved)),
        "adult_evidence": adult_evidence,
        "age_flags": list(dict.fromkeys(age_flags)),
        "metrics": {
            "tag_validity": coverage,
            "pose_completeness": round(pose_completeness, 3),
            "relationship_confidence": round(relationship_confidence, 3),
            "composition_completeness": round(composition_completeness, 3),
            "completeness": completeness,
        },
    }
    label_source = (base_tags or [*camera_tags] or ["导入姿势"])[0]
    structure["label"] = f"{label_source} · {participant_count}人"
    structure["fingerprint"] = _hash_structure({k: structure[k] for k in ("participant_count", "base_tags", "camera_tags", "role_tags", "relations")})
    structure["blocked"] = bool(age_flags)
    structure["blocked_reason"] = "发现未成年或年龄歧义标签，禁止进入成人模板库" if age_flags else ""
    return structure


__all__ = ["distill_prompt", "CORE_TAGS", "POSE_TAGS", "CAMERA_TAGS", "ACTION_TAGS"]
