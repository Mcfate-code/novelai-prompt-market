"""Phase 2 Recommendation Engine V2.

This module is deliberately a read-only service.  It does not know about
FastAPI, PromptDocument, or the generation/audit write path.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any, Callable, Iterable, Mapping, Sequence

from prompt.sections import classify_tag as classify_prompt_section


RRF_K = 60
TARGET_SECTIONS = {
    "base": {"style", "composition", "scene", "quality", "other"},
    "character": {"character", "appearance", "clothing", "expression", "action"},
}
ADULT_STAGES = ("PREPARATION", "FOREPLAY", "MAIN_ACT", "CLIMAX", "AFTERMATH")
GROUPS = ("General", "角色", "外观", "服装", "动作", "环境", "物体", "光照", "构图", "画风")
ADULT_GROUPS = ("主要行为", "体位", "辅助行为", "玩法", "角色状态", "身体焦点", "当前阶段", "下一阶段", "构图")

# Phase 4 source contract (spec 4.4). ``semantic_alternative`` carries the
# embedding-derived same-class neighbours (e.g. blue eyes -> red eyes) and is
# surfaced ONLY as 相似/替代 alternatives — it never joins the additive
# "Next Step" RRF ranking. The additive sources keep their legacy names for
# backward compatibility with existing consumers/tests:
#   global_related     ~ public_association (global NPMI / remote related)
#   local_cooccurrence ~ personal_scoped (personal learned co-occurrence)
#   personal_recent    ~ personal_scoped (personal recent usage)
#   semantic_context   ~ context_association + slot_candidate
#   adult_context      ~ adult_context (unchanged)
ADDITIVE_SOURCES = ("global_related", "local_cooccurrence", "personal_recent", "semantic_context", "adult_context")
ALTERNATIVE_SOURCES = ("semantic_alternative",)
SOURCE_NAMES = ADDITIVE_SOURCES + ALTERNATIVE_SOURCES

# Human-facing source labels — the raw source identifiers are never exposed to
# users in ``reason`` (spec 4.9).
SOURCE_LABELS = {
    "global_related": "全局关联",
    "local_cooccurrence": "本地共现",
    "personal_recent": "个人最近使用",
    "semantic_context": "语义节点",
    "adult_context": "场景上下文",
    "semantic_alternative": "相似替代",
}


def reciprocal_rank_fusion(rankings: Mapping[str, Sequence[str]], k: int = RRF_K) -> dict[str, float]:
    """Fuse independently ranked source lists without mixing raw scales."""
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings.values():
        seen: set[str] = set()
        for rank, tag in enumerate(ranking, 1):
            if tag in seen:
                continue
            seen.add(tag)
            scores[tag] += 1.0 / (k + rank)
    return dict(scores)


def _norm(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def _same_slot_neighbor(item: Any) -> bool:
    """True when a neighbour row is a same-slot alternative (a replacement for
    the current tag), not a co-addable tag.  Determined by ``relation_type`` or
    by equal src/dst node ids (spec 4.2)."""
    if not isinstance(item, Mapping):
        return False
    if item.get("relation_type") == "same_slot":
        return True
    src = item.get("src_node")
    dst = item.get("dst_node")
    return bool(src and dst and _norm(src) == _norm(dst))


_SLOT_ZH_CACHE: dict[str, str] | None = None
_SLOT_ZH_EXTRAS = (
    ("base_subject_count", "主体/人数"),
    ("scene_participants", "人物"),
    ("scene_primary_act", "主要行为"),
    ("scene_interaction", "互动关系"),
    ("scene_stage", "阶段"),
    ("scene_position", "体位"),
    ("scene_character_state", "角色状态"),
    ("scene_additional_activities", "附加活动"),
    ("scene_body_focus", "身体焦点"),
    ("scene_composition", "构图"),
    ("scene_environment", "环境"),
)


def _slot_zh(node_id: Any) -> str:
    """Return the Chinese label for a semantic slot node, for human reasons."""
    global _SLOT_ZH_CACHE
    if _SLOT_ZH_CACHE is None:
        _SLOT_ZH_CACHE = {}
        try:
            import json
            from pathlib import Path
            cfg = Path(__file__).resolve().parent.parent / "config" / "semantic_slots.json"
            for slot in json.loads(cfg.read_text(encoding="utf-8")):
                nid = slot.get("node_id")
                if nid:
                    _SLOT_ZH_CACHE[nid] = slot.get("zh", nid)
        except Exception:
            pass
        for nid, zh in _SLOT_ZH_EXTRAS:
            _SLOT_ZH_CACHE.setdefault(nid, zh)
    return _SLOT_ZH_CACHE.get(str(node_id or ""), str(node_id or ""))


def _as_items(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        value = value.get("results", value.get("tags", []))
    result = []
    for item in value or []:
        result.append(dict(item) if isinstance(item, Mapping) else {"tag": item})
    return [item for item in result if _norm(item.get("tag") or item.get("prompt_tag"))]


@dataclass(frozen=True)
class RecommendationContext:
    tags: tuple[str, ...]
    target: str = ""
    node_id: str = ""
    mode: str = "general"
    participant_count: Any = None
    primary_scene_type: str = ""
    primary_act: str = ""
    stage: str = ""
    position: str = ""
    body_focus: str = ""
    additional_activities: tuple[str, ...] = ()
    clothing_state: Mapping[str, Any] = field(default_factory=dict)
    character_state: Mapping[str, Any] = field(default_factory=dict)
    expressions: Mapping[str, Any] = field(default_factory=dict)
    interactions: tuple[Mapping[str, Any], ...] = ()
    composition: str = ""
    environment: str = ""
    active_target: str = ""
    active_section: str = ""
    semantic_node: Any = None
    last_added_tag: str = ""


class RecommendationService:
    """Read-only, deterministic recommendation engine.

    Sources may be callables accepting ``context`` or static iterables.  A
    source item can be a tag string or metadata mapping; metadata is used for
    hard filtering and context reranking, never as a raw score input.
    """

    SOURCE_NAMES = SOURCE_NAMES
    ADDITIVE_SOURCES = ADDITIVE_SOURCES
    ALTERNATIVE_SOURCES = ALTERNATIVE_SOURCES

    def __init__(self, conn=None, *, sources: Mapping[str, Any] | None = None,
                 related_source: Callable | None = None, semantic_source: Callable | None = None,
                 hidden_tags: Iterable[str] = (), adolescent_mode: bool = False,
                 navigation: Mapping[str, Any] | None = None, rrf_k: int = RRF_K):
        self.conn = conn
        self.sources = dict(sources or {})
        if related_source is not None:
            self.sources["global_related"] = related_source
        if semantic_source is not None:
            self.sources["semantic_context"] = semantic_source
        self.hidden_tags = {_norm(tag) for tag in hidden_tags}
        self.adolescent_mode = adolescent_mode
        self.navigation = navigation or {}
        self.rrf_k = int(rrf_k)
        # Optional debug sink (spec 4.8): records prior-failure reasons without
        # ever surfacing stack traces to the normal UI.  Off by default.
        self.debug_reasons: list[tuple[str, str]] | None = None

    def recommend(self, *, tags: Sequence[str] = (), target: str = "", node_id: str = "",
                  limit: int = 20, mode: str = "general", participant_count=None,
                  primary_scene_type: str = "", stage: str = "", position: str = "",
                  primary_act: str = "", character_state: Mapping[str, Any] | None = None,
                  expressions: Mapping[str, Any] | None = None, interactions: Sequence[Mapping[str, Any]] = (),
                  composition: str = "", environment: str = "",
                  body_focus: str = "", additional_activities: Sequence[str] = (),
                  clothing_state: Mapping[str, Any] | None = None,
                  active_target: str = "", active_section: str = "",
                  semantic_node=None, last_added_tag: str = "") -> dict[str, Any]:
        normalized = tuple(dict.fromkeys(_norm(tag) for tag in tags if _norm(tag)))
        ctx = RecommendationContext(normalized, _norm(target), node_id, _norm(mode), participant_count,
                                    _norm(primary_scene_type), _norm(primary_act), _norm(stage).upper(), _norm(position),
                                    _norm(body_focus),
                                    tuple(dict.fromkeys(_norm(t) for t in (additional_activities or []) if _norm(t))),
                                    dict(clothing_state or {}), dict(character_state or {}), dict(expressions or {}), tuple(interactions or ()), _norm(composition), _norm(environment),
                                    _norm(active_target), _norm(active_section),
                                    semantic_node, _norm(last_added_tag))
        if not normalized or "uc" in ctx.target or ctx.active_target.endswith(":uc"):
            return {"groups": [], "recommendations": []}
        candidates = self._collect(ctx)
        candidates = {tag: item for tag, item in candidates.items() if self._allowed(item, ctx, normalized)}
        rankings = {}
        for source in self.ADDITIVE_SOURCES:
            values = [tag for tag, item in candidates.items() if source in item["sources"]]
            rankings[source] = sorted(values, key=lambda tag: source_sort(source, candidates[tag], tag))
        fused = reciprocal_rank_fusion(rankings, self.rrf_k)
        ordered = sorted(candidates, key=lambda tag: self._final_sort(tag, candidates[tag], fused, ctx))
        selected = self._diversify(ordered, candidates, max(0, min(int(limit), 100)), ctx)
        output = [self._public_item(tag, candidates[tag], fused.get(tag, 0.0), ctx) for tag in selected]
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in output:
            groups[item["group"]].append(item)
        return {"groups": [{"group": name, "recommendations": groups[name]} for name in groups],
                 "recommendations": output}

    def recommend_v3(self, *, tags: Sequence[str] = (), target: str = "", node_id: str = "",
                     limit: int = 20, mode: str = "general", participant_count=None,
                      primary_scene_type: str = "", stage: str = "", position: str = "",
                      primary_act: str = "", character_state: Mapping[str, Any] | None = None,
                      expressions: Mapping[str, Any] | None = None, interactions: Sequence[Mapping[str, Any]] = (),
                      composition: str = "", environment: str = "",
                     body_focus: str = "", additional_activities: Sequence[str] = (),
                     clothing_state: Mapping[str, Any] | None = None,
                     active_target: str = "", active_section: str = "",
                     semantic_node=None, last_added_tag: str = "", structured_state=None,
                     generation_config=None, semantic_state=None) -> dict[str, Any]:
        """Recommendation V3: next-step guidance layered on the V2 RRF core.

        This method intentionally has a separate contract.  The V2 method above
        remains unchanged for existing clients.  ``semantic_state`` may be a
        Phase-B SemanticState instance or a serializable equivalent.
        """
        normalized = tuple(dict.fromkeys(_norm(tag) for tag in tags if _norm(tag)))
        ctx = RecommendationContext(normalized, _norm(target), node_id, _norm(mode), participant_count,
                                    _norm(primary_scene_type), _norm(primary_act), _norm(stage).upper(), _norm(position),
                                    _norm(body_focus),
                                    tuple(dict.fromkeys(_norm(t) for t in (additional_activities or []) if _norm(t))),
                                    dict(clothing_state or {}), dict(character_state or {}), dict(expressions or {}), tuple(interactions or ()), _norm(composition), _norm(environment), _norm(active_target), _norm(active_section),
                                    semantic_node, _norm(last_added_tag))
        if "uc" in ctx.target or ctx.active_target.endswith(":uc"):
            return self._v3_empty(ctx)
        state = semantic_state
        had_explicit_state = state is not None or structured_state is not None
        if state is None and structured_state is not None:
            try:
                from prompt.semantic_state import build_semantic_state
                state = build_semantic_state(structured_state, conn=self.conn,
                                             generation_config=generation_config,
                                             active_target=active_target or target,
                                             mode=mode, last_added_tag=last_added_tag)
            except Exception:
                state = None
        state_dict = asdict(state) if is_dataclass(state) else (state if isinstance(state, Mapping) else {})
        missing = self._v3_missing(state, state_dict, active_target or target)
        rankings, candidates, same_slot = self._v3_collect(ctx, missing, state_dict, use_prior=had_explicit_state)
        if ctx.mode != "adult":
            candidates = {tag: item for tag, item in candidates.items() if "adult_context" not in item["sources"]}
        candidates = {tag: item for tag, item in candidates.items()
                      if self._allowed(item, ctx, normalized)}
        # Same-slot semantic alternatives (spec 4.2/4.3) override additive
        # compatibility: e.g. "red eyes" is a replacement for an already-present
        # "blue eyes", never a co-addable "Next Step" tag.
        for tag in same_slot:
            entry = candidates.get(tag)
            if entry is None:
                continue
            for source in self.ADDITIVE_SOURCES:
                entry["sources"].discard(source)
                if tag in rankings.get(source, ()):
                    rankings[source].remove(tag)
        # Split semantic alternatives out of the additive "Next Step" pipeline.
        alternative_items = {tag: item for tag, item in candidates.items()
                             if any(s in self.ALTERNATIVE_SOURCES for s in item["sources"])
                             and not any(s in self.ADDITIVE_SOURCES for s in item["sources"])}
        additive = {tag: item for tag, item in candidates.items() if tag not in alternative_items}
        rankings = {name: [tag for tag in values if tag in additive]
                    for name, values in rankings.items() if name in self.ADDITIVE_SOURCES}
        fused = reciprocal_rank_fusion(rankings, self.rrf_k)
        ordered = sorted(additive, key=lambda tag: self._v3_sort(tag, additive[tag], fused, ctx, missing))
        selected = self._diversify(ordered, additive, max(0, min(int(limit), 100)), ctx)
        output = [self._v3_public_item(tag, additive[tag], fused.get(tag, 0.0), ctx, missing)
                  for tag in selected]
        alternatives = self._v3_alternatives(alternative_items, ctx, missing)
        next_steps = []
        for slot in missing[:max(1, min(5, int(limit) if limit else 5))]:
            slot_id = slot.get("node_id", "") if isinstance(slot, Mapping) else getattr(slot, "node_id", "")
            slot_item = {"node_id": slot_id,
                         "slot": slot_id,
                         "label": slot.get("label", slot_id) if isinstance(slot, Mapping) else getattr(slot, "label", slot_id),
                         "zh": slot.get("zh", "") if isinstance(slot, Mapping) else getattr(slot, "zh", ""),
                         "status": slot.get("status", "empty") if isinstance(slot, Mapping) else getattr(slot, "status", "empty"),
                         "reason": slot.get("reason", "建议补充该槽位") if isinstance(slot, Mapping) else getattr(slot, "reason", "建议补充该槽位"),
                         "recommendations": [i for i in output if i.get("slot") == slot_id][:max(1, min(3, int(limit) or 3))]}
            next_steps.append(slot_item)
        current_node = (state_dict.get("intent") or {}).get("node_id") if isinstance(state_dict.get("intent"), Mapping) else None
        current_node = current_node or ctx.node_id or (semantic_node.get("node_id") if isinstance(semantic_node, Mapping) else None)
        contextual = [i for i in output if i.get("scene_context")]
        related = [i for i in output if not i.get("scene_context") and i.get("slot") is None]
        groups = self._v3_groups(output)
        result = {"next_steps": next_steps, "current_node": current_node,
                  "contextual": contextual, "related": related,
                  "groups": groups, "recommendations": output,
                  "count": len(output), "section": groups}
        if alternatives:
            result["alternatives"] = alternatives
        return result

    def _v3_empty(self, ctx):
        return {"next_steps": [], "current_node": None, "contextual": [], "related": [],
                "groups": [], "recommendations": [], "count": 0, "section": []}

    @staticmethod
    def _v3_missing(state, state_dict, target):
        if state is not None:
            try:
                slots = state.next_steps(target or "base", limit=10)
                result = [asdict(s) if is_dataclass(s) else (dict(s) if isinstance(s, Mapping) else vars(s)) for s in slots]
                if result:
                    return result
            except Exception:
                pass
        if target.startswith("char:"):
            return [{"node_id": "char_identity", "label": "Identity", "zh": "身份", "status": "empty", "reason": "建议先补充角色身份"}]
        return [{"node_id": "base_subject_count", "label": "Subject / Count", "zh": "主体/人数", "status": "empty", "reason": "建议先确定主体与人数"},
                {"node_id": "env_indoor", "label": "Environment", "zh": "环境", "status": "empty", "reason": "建议补充环境场景"},
                {"node_id": "base_composition", "label": "Composition", "zh": "构图", "status": "empty", "reason": "建议补充构图"}]

    def _v3_collect(self, ctx, missing, state_dict, *, use_prior=False):
        rankings = {name: [] for name in self.SOURCE_NAMES}
        candidates = {}
        same_slot: set[str] = set()
        # The offline prior is an optional adapter.  It is never required for V3.
        # Each prior family degrades independently (spec 4.8): a failure in the
        # embedding/neighbour prior must not disable the context / slot /
        # next-slot priors, and vice versa.  Failures are recorded for debug only.
        if use_prior:
            prior = None
            try:
                from prompt import prior as prior_mod
                prior = prior_mod.get_prior()
            except Exception as exc:
                self._record_debug("prior_unavailable", exc)
            if prior is not None:
                adult = ctx.mode == "adult"
                for tag in ctx.tags:
                    # 1. public NPMI association (prompt compatibility)
                    try:
                        for raw in prior.related_tags(tag, adult=adult) or []:
                            self._v3_add(candidates, rankings, "global_related", raw, ctx)
                    except Exception as exc:
                        self._record_debug("related_prior", exc)
                    # 2. embedding neighbours (semantic similarity) — NOT additive
                    try:
                        for raw in prior.semantic_neighbors(tag, adult=adult) or []:
                            self._v3_add(candidates, rankings, "semantic_alternative", raw, ctx)
                            if _same_slot_neighbor(raw):
                                same_slot.add(_norm(raw.get("tag") or raw.get("prompt_tag")))
                    except Exception as exc:
                        self._record_debug("semantic_prior", exc)
                    # 3. context association
                    try:
                        for raw in prior.context_candidates(tag, adult=adult) or []:
                            self._v3_add(candidates, rankings, "semantic_context", raw, ctx)
                    except Exception as exc:
                        self._record_debug("context_prior", exc)
                # 4. missing-slot candidates
                nodes = [s.get("node_id") for s in missing if s.get("node_id")]
                for node in nodes:
                    try:
                        for raw in prior.slot_candidates(node, context=self._context_map(ctx), adult=adult) or []:
                            self._v3_add(candidates, rankings, "semantic_context", {**raw, "slot": node}, ctx)
                    except Exception as exc:
                        self._record_debug("slot_prior", exc)
                # 5. next-slot transition prior
                try:
                    filled = [s.get("node_id") for s in self._filled_slots(state_dict)]
                    for raw in prior.next_slot_prior(filled, adult=adult) or []:
                        for candidate in prior.slot_candidates(raw.get("node_id", ""), context=self._context_map(ctx), adult=adult) or []:
                            self._v3_add(candidates, rankings, "semantic_context", {**candidate, "slot": raw.get("node_id")}, ctx)
                except Exception as exc:
                    self._record_debug("next_slot_prior", exc)
        for source in self.SOURCE_NAMES:
            if source == "adult_context" and ctx.mode != "adult":
                continue
            if self.conn is None and source == "local_cooccurrence":
                continue
            for raw in _as_items(self._source(source, ctx)):
                self._v3_add(candidates, rankings, source, raw, ctx)
                if source == "semantic_alternative" and _same_slot_neighbor(raw):
                    same_slot.add(_norm(raw.get("tag") or raw.get("prompt_tag")))
        # Apply DB metadata after all adapters have contributed.  Prior rows are
        # deliberately allowed to be sparse, but a known tag must still obey
        # target/section/safety filters just like a V2 candidate.
        if self.conn is not None:
            for tag, entry in candidates.items():
                try:
                    row = self.conn.execute(
                        "SELECT danbooru_name, prompt_tag, post_count, zh_name, category FROM tags "
                        "WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1", (tag, tag)
                    ).fetchone()
                    if row:
                        entry["meta"].setdefault("canonical", row["danbooru_name"])
                        entry["meta"].setdefault("prompt_tag", row["prompt_tag"])
                        entry["meta"].setdefault("post_count", row["post_count"])
                        entry["meta"].setdefault("zh", row["zh_name"] or "")
                        entry["meta"].setdefault("sections", {classify_prompt_section(self.conn, tag)})
                except Exception:
                    pass
        return rankings, candidates, same_slot

    def _record_debug(self, key: str, exc: Exception) -> None:
        """Record a prior-family failure reason for debug mode only (spec 4.8).
        The normal UI never surfaces stack traces."""
        if self.debug_reasons is not None:
            try:
                self.debug_reasons.append((key, repr(exc)))
            except Exception:
                pass

    @staticmethod
    def _context_map(ctx):
        return {"participant_count": ctx.participant_count, "primary_scene_type": ctx.primary_scene_type,
                "primary_act": ctx.primary_act, "interactions": ctx.interactions,
                "composition": ctx.composition, "environment": ctx.environment,
                "stage": ctx.stage, "position": ctx.position, "body_focus": ctx.body_focus,
                "additional_activities": ctx.additional_activities, "clothing_state": dict(ctx.clothing_state),
                "character_state": dict(ctx.character_state), "expressions": dict(ctx.expressions)}

    @staticmethod
    def _filled_slots(state_dict):
        slots = []
        for value in (state_dict.get("base_slots", []), state_dict.get("scene_slots", [])):
            slots.extend(value if isinstance(value, list) else [])
        for chars in state_dict.get("character_slots", []) or []:
            slots.extend(chars if isinstance(chars, list) else [])
        return [s.get("node_id") for s in slots
                if isinstance(s, Mapping) and s.get("status") not in ("empty", "partial") and s.get("node_id")]

    def _v3_add(self, candidates, rankings, source, raw, ctx):
        item = dict(raw) if isinstance(raw, Mapping) else {"tag": raw}
        tag = _norm(item.get("tag") or item.get("prompt_tag"))
        if not tag:
            return
        entry = candidates.setdefault(tag, {"tag": tag, "sources": set(), "meta": {}, "source_meta": {}})
        entry["sources"].add(source); entry["meta"].update({k: v for k, v in item.items() if k not in ("tag", "prompt_tag")})
        entry["source_meta"][source] = item
        if tag not in rankings[source]: rankings[source].append(tag)

    def _v3_sort(self, tag, item, fused, ctx, missing):
        meta = item["meta"]
        missing_ids = {s.get("node_id") for s in missing}
        slot = meta.get("slot") or meta.get("node_id") or meta.get("dst_node")
        gap = 1 if slot in missing_ids else 0
        # Single intent authority (spec 4.7): the active node id.  ``ctx.node_id``
        # is authoritative; fall back to the injected semantic_node["node_id"] so
        # the 0.15 intent bonus for the actively-edited node actually applies.
        intent_node = ctx.node_id or (ctx.semantic_node.get("node_id") if isinstance(ctx.semantic_node, Mapping) else None)
        intent = 1 if intent_node and slot == intent_node else int(bool(ctx.last_added_tag and _norm(meta.get("related_to")) == ctx.last_added_tag))
        scene = 0
        for field, actual in (("scene", ctx.primary_scene_type), ("primary_act", ctx.primary_act),
                              ("stage", ctx.stage), ("position", ctx.position), ("body_focus", ctx.body_focus),
                              ("composition", ctx.composition), ("environment", ctx.environment)):
            if meta.get(field) is not None and actual and _norm(meta.get(field)) == _norm(actual):
                scene += 1
        if meta.get("activity") in ctx.additional_activities:
            scene += 1
        if meta.get("clothing_state") and any(_norm(meta["clothing_state"]) == _norm(v) for v in ctx.clothing_state.values()):
            scene += 1
        if meta.get("participant_count") is not None and _participant_number(meta["participant_count"]) == _participant_number(ctx.participant_count):
            scene += 1
        personal = min(1, int(meta.get("use_count", meta.get("personal_metric", 0)) or 0) / 10)
        score = .45 * fused.get(tag, 0) + .25 * gap + .15 * intent + .10 * min(scene, 1) + .05 * personal
        # Intent is a tie-breaking layer, but should be visible even when the
        # two candidates came from the same RRF rank.
        return (-score, -intent, -gap, 0 if intent else 1, tag)

    def _v3_public_item(self, tag, item, score, ctx, missing):
        public = self._public_item(tag, item, score, ctx)
        meta = item["meta"]
        slot = meta.get("slot") or meta.get("node_id") or meta.get("dst_node")
        public["slot"] = slot
        public["target"] = meta.get("target", ctx.target or "base")
        public["scene_context"] = any(meta.get(k) is not None for k in ("scene", "primary_act", "stage", "position", "body_focus", "activity", "participant_count", "composition", "environment"))
        # Human-meaningful reason (spec 4.9); never exposes raw source names.
        intent_node = ctx.node_id or (ctx.semantic_node.get("node_id") if isinstance(ctx.semantic_node, Mapping) else None)
        parts: list[str] = []
        if slot and slot == intent_node:
            parts.append(f"正在编辑{_slot_zh(slot)}")
        elif slot:
            prefix = "当前角色还没有" if str(slot).startswith("char_") else "当前画面还没有"
            parts.append(f"{prefix}{_slot_zh(slot)}，补齐当前槽位")
        else:
            parts.append("与当前标签相关")
        if public["scene_context"]:
            if ctx.mode == "adult" and ctx.stage:
                parts.append(f"当前阶段 {ctx.stage}")
            elif ctx.primary_scene_type:
                parts.append(f"当前场景为 {ctx.primary_scene_type}")
            elif ctx.environment:
                parts.append(f"当前场景为 {ctx.environment}")
            else:
                parts.append("匹配当前场景")
        public["reason"] = "；".join(parts)
        return public

    def _v3_alternatives(self, alternative_items, ctx, missing):
        """Surface same-class semantic alternatives (相似/替代) separately from
        the additive "Next Step" list (spec 4.5/4.6)."""
        out = []
        for tag, item in alternative_items.items():
            meta = item["meta"]
            node = meta.get("src_node") or meta.get("dst_node") or meta.get("node_id")
            if not node:
                node = ctx.node_id or (ctx.semantic_node.get("node_id") if isinstance(ctx.semantic_node, Mapping) else None)
            pub = self._public_item(tag, item, 0.0, ctx)
            pub["reason"] = f"这是{_slot_zh(node)}的相似替代项" if node else "这是相似替代项"
            pub["slot"] = node
            pub["target"] = ctx.target or "base"
            pub["scene_context"] = False
            pub["similarity"] = float(meta.get("similarity", meta.get("semantic_priority", 0)) or 0)
            out.append(pub)
        out.sort(key=lambda i: (-float(i.get("similarity", 0.0) or 0.0), i["tag"]))
        return out

    @staticmethod
    def _v3_groups(output):
        grouped = defaultdict(list)
        for item in output: grouped[item["group"]].append(item)
        return [{"group": name, "recommendations": values} for name, values in grouped.items()]

    def _collect(self, ctx: RecommendationContext) -> dict[str, dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for source in self.ADDITIVE_SOURCES:
            raw = self._source(source, ctx)
            for item in _as_items(raw):
                tag = _norm(item.get("tag") or item.get("prompt_tag"))
                entry = collected.setdefault(tag, {"tag": tag, "sources": set(), "meta": {}, "source_meta": {}})
                entry["sources"].add(source)
                source_meta = {k: v for k, v in item.items() if k not in ("tag", "prompt_tag")}
                entry["source_meta"][source] = source_meta
                entry["meta"].update(source_meta)
        if self.conn is not None:
            for tag, entry in collected.items():
                row = self.conn.execute(
                    "SELECT danbooru_name, prompt_tag, post_count, zh_name FROM tags "
                    "WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
                    (tag, tag),
                ).fetchone()
                if row:
                    entry["meta"].setdefault("canonical", row["danbooru_name"])
                    entry["meta"].setdefault("prompt_tag", row["prompt_tag"])
                    entry["meta"].setdefault("post_count", row["post_count"])
                    entry["meta"].setdefault("zh", row["zh_name"] or "")
                # Prompt 分区（Base/Character 目标过滤）：用 sections 分类器而非 danbooru taxonomy。
                try:
                    section = classify_prompt_section(self.conn, tag)
                except Exception:
                    section = "other"
                if "sections" not in entry["meta"]:
                    entry["meta"]["sections"] = {section}
        return collected

    def _source(self, name: str, ctx: RecommendationContext):
        source = self.sources.get(name)
        if source is not None:
            try:
                return source(ctx) if callable(source) else source
            except Exception:
                return []
        if self.conn is None:
            return []
        if name == "local_cooccurrence":
            # 作用域感知的本地共现：base 目标读 base/base_character_context，
            # character 目标读 character，interaction 恒包含；未指定目标读全部作用域。
            if ctx.target == "base":
                scopes = ("base", "base_character_context", "interaction")
            elif ctx.target == "character":
                scopes = ("character", "interaction")
            else:
                scopes = ("base", "base_character_context", "character", "interaction")
            placeholders = ",".join("?" for _ in scopes)
            rows = []
            for tag in ctx.tags:
                rows.extend(self.conn.execute(
                    f"SELECT tag_a, tag_b, positive_weight, negative_weight FROM tag_cooccurrence_scoped "
                    f"WHERE scope IN ({placeholders}) AND (tag_a=? OR tag_b=?)",
                    (*scopes, tag, tag),
                ))
            totals = defaultdict(float)
            for row in rows:
                other = row["tag_b"] if row["tag_a"] in ctx.tags else row["tag_a"]
                if other not in ctx.tags:
                    totals[other] += (float(row["positive_weight"] or 0)
                                      - float(row["negative_weight"] or 0))
            return [{"tag": tag, "count": count} for tag, count in totals.items() if count > 0]
        if name == "personal_recent":
            return self._personal_recent_items(ctx)
        if name == "semantic_context":
            return self._semantic_items(ctx)
        if name == "adult_context":
            return self._adult_items(ctx)
        # ``semantic_alternative`` has no local connector: alternatives are only
        # contributed by the prior adapter (V3) or an explicitly injected source.
        return []

    def _semantic_items(self, ctx):
        node = ctx.semantic_node
        if isinstance(node, Mapping):
            return node.get("seed_tags", node.get("tags", []))
        return []

    def _personal_recent_items(self, ctx):
        """作用域过滤的个人最近使用（spec 6.3/6.5）。

        优先读 recent_tags_scoped 并按当前推荐上下文（target）过滤作用域；
        作用域结果为空或表缺失/不可用时，优雅回退到全局 recent_tags（向后兼容）。
        个人偏好仍是小权重 bonus，不参与主排序（见 _v3_sort 的 0.05 * personal）。
        """
        scopes = _personal_recent_scopes(ctx)
        placeholders = ",".join("?" for _ in scopes)
        rows: list[Any] = []
        try:
            rows = list(self.conn.execute(
                f"SELECT tag_name, use_count FROM recent_tags_scoped "
                f"WHERE scope IN ({placeholders}) ORDER BY use_count DESC, last_used_at DESC",
                scopes,
            ).fetchall())
        except Exception:
            rows = []
        if not rows:
            # 优雅回退：作用域表缺失/为空时退回全局 recent_tags（保持旧行为）。
            try:
                rows = list(self.conn.execute(
                    "SELECT tag_name, use_count FROM recent_tags ORDER BY use_count DESC, last_used_at DESC"
                ).fetchall())
            except Exception:
                rows = []
        return [{"tag": row["tag_name"], "use_count": row["use_count"]} for row in rows]

    def _adult_items(self, ctx):
        source = self.sources.get("adult_context", [])
        return (source(ctx) if callable(source) else source) if ctx.mode == "adult" else []

    def _allowed(self, item, ctx, selected):
        tag, meta = item["tag"], item["meta"]
        if tag in selected or tag in self.hidden_tags or meta.get("nsfw") and self.adolescent_mode:
            return False
        if ctx.mode == "adult" and (meta.get("minor_like") or meta.get("juvenile") or meta.get("underage")):
            return False
        if ctx.target in TARGET_SECTIONS and meta.get("target") and meta["target"] != ctx.target:
            return False
        if ctx.target in TARGET_SECTIONS and meta.get("sections"):
            if not (set(meta["sections"]) & TARGET_SECTIONS[ctx.target]):
                return False
        if ctx.active_section and meta.get("sections") and ctx.active_section not in meta["sections"]:
            return False
        if ctx.node_id and meta.get("nodes") and ctx.node_id not in meta["nodes"]:
            return False
        count = _participant_number(ctx.participant_count)
        if count is not None and not _participant_ok(meta, count):
            return False
        if meta.get("exclusive_group") and self._exclusive_conflict(meta["exclusive_group"], selected):
            return False
        incompatible = {_norm(value) for value in meta.get("incompatible_tags", meta.get("exclusive_with", []))}
        if incompatible & set(selected):
            return False
        return not self._conflicts(tag, selected)

    def _exclusive_conflict(self, group, selected):
        return any(_norm(tag) == _norm(group) for tag in selected)

    def _conflicts(self, tag, selected):
        if self.conn is None:
            return False
        for other in selected:
            pair = sorted((tag, other))
            if self.conn.execute("SELECT 1 FROM tag_conflict WHERE tag_a=? AND tag_b=?", tuple(pair)).fetchone():
                return True
        return False

    def _final_sort(self, tag, item, fused, ctx):
        meta = item["meta"]
        context = 0
        if ctx.mode == "adult":
            context += 3 * int("adult_context" in item["sources"])
            context += int(bool(ctx.primary_scene_type and _norm(meta.get("scene")) == ctx.primary_scene_type))
            context += int(bool(ctx.stage and _norm(meta.get("stage")) == ctx.stage.lower()))
        context += int(bool(ctx.last_added_tag and _norm(meta.get("related_to")) == ctx.last_added_tag))
        return (-(fused.get(tag, 0.0) + context / 100), -context, -int(meta.get("post_count", 0) or 0), tag)

    def _diversify(self, ordered, candidates, limit, ctx):
        result = []
        used = defaultdict(int)
        for tag in ordered:
            group = self._group(candidates[tag], ctx)
            if used[group] >= 2:
                continue
            result.append(tag)
            used[group] += 1
            if len(result) >= limit:
                break
        if len(result) < limit:
            for tag in ordered:
                if tag not in result:
                    result.append(tag)
                    if len(result) >= limit:
                        break
        return result

    def _group(self, item, ctx):
        if item["meta"].get("group"):
            return item["meta"]["group"]
        return "当前阶段" if ctx.mode == "adult" and item["meta"].get("stage") else "General"

    def _public_item(self, tag, item, score, ctx):
        meta = item["meta"]
        sources = [name for name in self.SOURCE_NAMES if name in item["sources"]]
        reason = "、".join(SOURCE_LABELS[s] for s in sources if s in SOURCE_LABELS)
        return {"tag": meta.get("prompt_tag", tag), "canonical": meta.get("canonical", tag.replace(" ", "_")),
                "zh": meta.get("zh", ""), "group": self._group(item, ctx), "reason": reason or "本地候选",
                "sources": sources, "source": sources, "post_count": int(meta.get("post_count", 0) or 0),
                "_score": score}


def item_sort(item, tag):
    return (-int(item.get("meta", {}).get("rank", 10**9)), tag)


def _personal_recent_scopes(ctx) -> tuple[str, ...]:
    """把推荐目标映射到个人最近使用的作用域集合（spec 6.3）。

    base 目标读 base/scene（base 环境历史），绝不读 character；character 目标读
    character（角色偏好），绝不读 base 环境历史；未指定目标读全部作用域。
    """
    if ctx.target == "base":
        return ("base", "scene")
    if ctx.target == "character" or ctx.target.startswith("char:"):
        return ("character",)
    return ("base", "scene", "character", "interaction")


def source_sort(source, item, tag):
    meta = item.get("source_meta", {}).get(source, item.get("meta", {}))
    if source == "local_cooccurrence":
        return (-int(meta.get("count", 0) or 0), tag)
    if source == "personal_recent":
        return (-int(meta.get("use_count", meta.get("personal_metric", 0)) or 0), tag)
    if source == "global_related":
        return (-float(meta.get("score", meta.get("npmi", 0)) or 0), int(meta.get("rank", 10**9)), tag)
    if source == "semantic_context":
        return (-int(meta.get("semantic_priority", meta.get("priority", 0)) or 0), tag)
    if source == "adult_context":
        return (-int(meta.get("context_priority", meta.get("priority", 0)) or 0), tag)
    if source == "semantic_alternative":
        return (-float(meta.get("similarity", meta.get("semantic_priority", 0)) or 0), tag)
    return item_sort(item, tag)


def _participant_number(value):
    if value is None or value == "":
        return None
    if isinstance(value, str) and value.endswith("+"):
        return int(value[:-1])
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _participant_ok(meta, count):
    minimum = meta.get("min_participants")
    maximum = meta.get("max_participants")
    return not (minimum is not None and count < int(minimum) or maximum is not None and count > int(maximum))


__all__ = ["RecommendationService", "RecommendationContext", "reciprocal_rank_fusion", "RRF_K",
           "ADDITIVE_SOURCES", "ALTERNATIVE_SOURCES", "SOURCE_NAMES", "SOURCE_LABELS"]
