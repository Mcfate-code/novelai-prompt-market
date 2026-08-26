"""Pure deterministic Prompt Auto-Split / Character Assignment proposal service.

This service proposes ownership only.  It does not mutate a PromptDocument,
call an LLM, or run on a keypress.  Explicit segments and manual assignments
always outrank the deterministic heuristics.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from prompt import import_parser
from prompt.semantics import (
    BASE_SECTIONS,
    LOCAL_SECTIONS,
    is_character_identity,
    is_subject_count,
    normalize_tag,
    resolve_tag_metadata,
    section_for,
)

AMBIGUOUS_SUMMARY = "detected multiple subjects but no reliable character boundary"
_EXPLICIT_KEYS = {"base", "characters", "global_uc", "global_uc_sections", "sections", "schema_version"}
_LOCAL_HINTS = ("hair", "eyes", "skin", "face", "body", "dress", "shirt", "skirt", "jacket", "gloves", "smile", "blush", "cry", "standing", "sitting", "running", "holding", "looking")


def is_structured_prompt(prompt: Any) -> bool:
    """Whether ``prompt`` already carries authoritative target ownership."""
    if not isinstance(prompt, Mapping):
        return False
    if prompt.get("schema_version") == 2:
        return True
    return bool(prompt.get("structured") or (prompt.get("characters") and
                                               any(k in prompt for k in ("base", "global_uc"))))


def _entry(tag: Any) -> dict[str, Any]:
    if isinstance(tag, Mapping):
        return dict(tag)
    return {"tag": str(tag).strip(), "strength": None, "brackets": 0, "relation": None}


def _flat_sections(sections: Any) -> list[dict[str, Any]]:
    if isinstance(sections, Sequence) and not isinstance(sections, (str, bytes)):
        return [_entry(e) for e in sections if _entry(e).get("tag")]
    if not isinstance(sections, Mapping):
        return []
    result = []
    for section, values in sections.items():
        if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
            continue
        for value in values:
            item = _entry(value)
            if item.get("tag"):
                item.setdefault("section", section)
                result.append(item)
    return result


def _structured_proposal(prompt: Mapping[str, Any]) -> dict[str, Any]:
    base = _flat_sections(prompt.get("sections", prompt.get("base", prompt.get("base_prompt", []))))
    global_uc = _flat_sections(prompt.get("global_uc_sections", prompt.get("global_uc", [])))
    chars = []
    for index, raw in enumerate(prompt.get("characters") or []):
        raw = raw if isinstance(raw, Mapping) else {}
        chars.append({
            "name": raw.get("name", f"Character {index + 1}"),
            "prompt": _flat_sections(raw.get("prompt_sections", raw.get("prompt", []))),
            "uc": _flat_sections(raw.get("uc_sections", raw.get("uc", []))),
            "position": raw.get("position"),
        })
    return {
        "base": base, "characters": chars, "global_uc": global_uc,
        "summary": "explicit structured prompt; ownership preserved",
        "unassigned": [], "structured": True, "resplit": False,
        "assistant_context": {"participant_count": len(chars)},
    }


def _assignment_lookup(assignments: Any) -> dict[Any, Any]:
    if not isinstance(assignments, Mapping):
        return {}
    return {(k if isinstance(k, int) else normalize_tag(k)): v for k, v in assignments.items()}


def _put(proposal: dict[str, Any], target: Any, item: dict[str, Any]) -> None:
    target = str(target or "base").lower()
    if target in {"base", "global_uc"}:
        proposal[target].append(item)
        return
    if target.startswith("char:"):
        tail = target[5:]
        is_uc = tail.endswith(":uc")
        index = int(tail[:-3] if is_uc else tail)
        while len(proposal["characters"]) <= index:
            proposal["characters"].append({"name": f"Character {len(proposal['characters']) + 1}", "prompt": [], "uc": [], "position": None})
        proposal["characters"][index]["uc" if is_uc else "prompt"].append(item)
        return
    proposal["unassigned"].append(item)


def auto_split(prompt: Any, metadata_resolver: Any = None, manual_assignments: Any = None) -> dict[str, Any]:
    """Return a proposal with Base/Character/Global UC ownership.

    ``manual_assignments`` maps an original tag (or normalized tag) to
    ``base``, ``global_uc``, ``char:N`` or ``char:N:uc``.  It is an explicit
    integrator contract and is applied before all automatic decisions.
    """
    if is_structured_prompt(prompt):
        result = _structured_proposal(prompt)
        result["manual_assignments"] = dict(manual_assignments or {})
        return result
    explicit_text = isinstance(prompt, str) and any(line.strip().lower().startswith(("base:", "character ", "global uc:", "uc:")) for line in prompt.splitlines())
    parsed = import_parser.parse(prompt) if isinstance(prompt, str) else prompt
    if not isinstance(parsed, Mapping):
        parsed = {"base": []}
    if parsed.get("structured") or parsed.get("characters") or parsed.get("global_uc"):
        return _structured_proposal(parsed)

    if explicit_text:
        result = _structured_proposal({**parsed, "structured": True})
        result["summary"] = "explicit structured prompt; ownership preserved"
        result["manual_assignments"] = dict(manual_assignments or {})
        return result
    proposal = {"base": [], "characters": [], "global_uc": [], "summary": "", "unassigned": [], "structured": False, "resplit": True}
    assignments = _assignment_lookup(manual_assignments)
    entries = [_entry(e) for e in parsed.get("base", [])]
    identities = []
    current = None
    count_only = False
    for entry_index, item in enumerate(entries):
        tag = item.get("tag", "")
        metadata = resolve_tag_metadata(tag, metadata_resolver)
        norm = normalize_tag(tag)
        if is_subject_count(tag):
            count_only = True
        target = assignments.get(entry_index, assignments.get(norm))
        if target is not None:
            _put(proposal, target, item)
            if str(target).startswith("char:") and not str(target).endswith(":uc"):
                current = int(str(target)[5:])
            continue
        if is_character_identity(tag, metadata):
            current = len(proposal["characters"])
            proposal["characters"].append({"name": metadata.get("canonical") or tag, "prompt": [item], "uc": [], "position": None})
            identities.append(tag)
            continue
        section = section_for(tag, metadata)
        relation = item.get("relation")
        if relation or section in BASE_SECTIONS:
            _put(proposal, "base", item)
        elif current is not None and section in LOCAL_SECTIONS:
            proposal["characters"][current]["prompt"].append(item)
        elif current is not None and (section in LOCAL_SECTIONS or
                                      (section is None and any(hint in norm for hint in _LOCAL_HINTS))):
            proposal["characters"][current]["prompt"].append(item)
        else:
            _put(proposal, "base", item)

    free_text = parsed.get("free_text")
    if free_text:
        proposal["base"].append({"text": free_text, "kind": "free_text"})
    if count_only and len(identities) < 2:
        proposal["summary"] = AMBIGUOUS_SUMMARY
    elif count_only:
        proposal["summary"] = "detected multiple subjects; identity anchors provide character boundaries"
    elif len(identities) > 1:
        proposal["summary"] = f"assigned {len(identities)} character identities by deterministic anchors"
    else:
        proposal["summary"] = "no reliable character boundary; ambiguous entries remain in Base"
    proposal["manual_assignments"] = dict(manual_assignments or {})
    proposal["assistant_context"] = {"participant_count": len(identities) or (2 if count_only else None), "primary_scene_type": None, "stage": None, "position": None, "body_focus": None}
    return proposal


propose_auto_split = auto_split

__all__ = ["auto_split", "propose_auto_split", "is_structured_prompt", "AMBIGUOUS_SUMMARY"]
