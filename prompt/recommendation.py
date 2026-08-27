"""Phase 2 Recommendation Engine V2.

This module is deliberately a read-only service.  It does not know about
FastAPI, PromptDocument, or the generation/audit write path.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
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
    stage: str = ""
    position: str = ""
    body_focus: str = ""
    additional_activities: tuple[str, ...] = ()
    clothing_state: Mapping[str, Any] = field(default_factory=dict)
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

    SOURCE_NAMES = ("global_related", "local_cooccurrence", "personal_recent", "semantic_context", "adult_context")

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

    def recommend(self, *, tags: Sequence[str] = (), target: str = "", node_id: str = "",
                  limit: int = 20, mode: str = "general", participant_count=None,
                  primary_scene_type: str = "", stage: str = "", position: str = "",
                  body_focus: str = "", additional_activities: Sequence[str] = (),
                  clothing_state: Mapping[str, Any] | None = None,
                  active_target: str = "", active_section: str = "",
                  semantic_node=None, last_added_tag: str = "") -> dict[str, Any]:
        normalized = tuple(dict.fromkeys(_norm(tag) for tag in tags if _norm(tag)))
        ctx = RecommendationContext(normalized, _norm(target), node_id, _norm(mode), participant_count,
                                    _norm(primary_scene_type), _norm(stage).upper(), _norm(position),
                                    _norm(body_focus),
                                    tuple(dict.fromkeys(_norm(t) for t in (additional_activities or []) if _norm(t))),
                                    dict(clothing_state or {}),
                                    _norm(active_target), _norm(active_section),
                                    semantic_node, _norm(last_added_tag))
        if not normalized or "uc" in ctx.target or ctx.active_target.endswith(":uc"):
            return {"groups": [], "recommendations": []}
        candidates = self._collect(ctx)
        candidates = {tag: item for tag, item in candidates.items() if self._allowed(item, ctx, normalized)}
        rankings = {}
        for source in self.SOURCE_NAMES:
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

    def _collect(self, ctx: RecommendationContext) -> dict[str, dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for source in self.SOURCE_NAMES:
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
            return [{"tag": row["tag_name"], "use_count": row["use_count"]}
                    for row in self.conn.execute("SELECT tag_name, use_count FROM recent_tags ORDER BY use_count DESC, last_used_at DESC")]
        return self._semantic_items(ctx) if name == "semantic_context" else self._adult_items(ctx)

    def _semantic_items(self, ctx):
        node = ctx.semantic_node
        if isinstance(node, Mapping):
            return node.get("seed_tags", node.get("tags", []))
        return []

    def _adult_items(self, ctx):
        return self.sources.get("adult_context", []) if ctx.mode == "adult" else []

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
        reason = "、".join({"global_related": "全局关联", "local_cooccurrence": "本地共现", "personal_recent": "个人最近使用", "semantic_context": "语义节点", "adult_context": "场景上下文"}[s] for s in sources)
        return {"tag": meta.get("prompt_tag", tag), "canonical": meta.get("canonical", tag.replace(" ", "_")),
                "zh": meta.get("zh", ""), "group": self._group(item, ctx), "reason": reason or "本地候选",
                "sources": sources, "source": sources, "post_count": int(meta.get("post_count", 0) or 0),
                "_score": score}


def item_sort(item, tag):
    return (-int(item.get("meta", {}).get("rank", 10**9)), tag)


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


__all__ = ["RecommendationService", "RecommendationContext", "reciprocal_rank_fusion", "RRF_K"]
