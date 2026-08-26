"""Deterministic prompt-semantic helpers used by the Phase 2 splitter.

The module deliberately knows nothing about the database.  Applications can
inject a resolver returning metadata for a prompt tag; a resolver may return a
mapping or an object with ``category``, ``section``, ``canonical`` and
``aliases`` attributes.  Unknown metadata is never invented here.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Callable

CHARACTER_CATEGORY = 4
BASE_SECTIONS = frozenset({"scene", "composition", "style", "quality"})
LOCAL_SECTIONS = frozenset({"character", "appearance", "clothing", "expression", "action"})
SUBJECT_COUNT_RE = re.compile(r"^(?:\d+\s*)?(?:girls?|boys?|women?|men?|people|persons?)$", re.I)


def normalize_tag(value: Any) -> str:
    """Normalize only for comparisons; never use this as an output tag."""
    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def resolve_tag_metadata(tag: str, resolver: Any = None) -> dict[str, Any]:
    """Return resolver metadata in a small, tolerant, read-only shape."""
    if resolver is None:
        return {}
    result = resolver(tag) if callable(resolver) else None
    if result is None and hasattr(resolver, "resolve"):
        result = resolver.resolve(tag)
    if result is None and isinstance(resolver, Mapping):
        result = resolver.get(tag) or resolver.get(normalize_tag(tag))
        if result is None:
            wanted = normalize_tag(tag)
            for candidate, metadata in resolver.items():
                if not isinstance(metadata, Mapping):
                    continue
                names = [metadata.get("canonical"), *(metadata.get("aliases") or ())]
                if wanted in {normalize_tag(name) for name in names if name}:
                    result = metadata
                    break
    if result is None:
        return {}
    if isinstance(result, Mapping):
        return dict(result)
    return {name: getattr(result, name) for name in ("category", "section", "canonical", "aliases")
            if hasattr(result, name)}


def is_character_identity(tag: str, metadata: Mapping[str, Any]) -> bool:
    """Only DB/resolver-backed character metadata is an identity anchor."""
    category = metadata.get("category")
    if isinstance(category, str):
        return category.lower() in {"character", "4"}
    return category == CHARACTER_CATEGORY


def section_for(tag: str, metadata: Mapping[str, Any]) -> str | None:
    section = metadata.get("section")
    return str(section).lower() if section is not None else None


def is_subject_count(tag: str) -> bool:
    return bool(SUBJECT_COUNT_RE.fullmatch(normalize_tag(tag)))


def has_identity_alias(tag: str, metadata: Mapping[str, Any]) -> bool:
    """Useful for callers auditing canonical/alias matching."""
    canonical = metadata.get("canonical")
    aliases = metadata.get("aliases") or ()
    names = {normalize_tag(canonical), *(normalize_tag(a) for a in aliases)}
    return normalize_tag(tag) in names
