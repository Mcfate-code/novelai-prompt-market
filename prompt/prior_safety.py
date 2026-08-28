"""Deterministic build-time tag safety classifier（Product V3 Phase 2，§2.2）。

为每个标签分配 ``safety_scope`` ∈ {general, adult, minor_like, age_ambiguous}，
只用模块内置的 curated 列表 + 显式元数据，无 ML / LLM、无网络、无随机性——
相同输入恒得到相同输出。

硬规则（安全边界）：
    携带 minor-like 或 age-ambiguous 证据的标签绝不判为 ``adult``。成人模式推荐查询
    过滤 ``safety_scope='adult'``，因此保证 minor-like 标签永远不会以
    Adult Recommendation 候选身份出现。

优先级（高者胜）：
    1. ``age_ambiguous`` — 少数可能未成年也可能成年的短语（如 "small girl"、
       "young woman"）。
    2. ``minor_like``   — 年龄相关 deny-list 与 loli 风格别名
       （young/loli/shota/child/…），token 边界匹配。
    3. Danbooru rating  — ``q``/``e``（questionable/explicit）→ adult，
                          ``g``/``s``（general/sensitive）→ general。
    4. ``meta`` 成人证据 — 真值的 adult / is_adult / nsfw / explicit 标记。
    5. 显式成人词汇 fallback — 模块内置的一小份性相关词表。
    6. 其余 → general。
"""
from __future__ import annotations

from typing import Any, Mapping

# Danbooru rating 池（与 prompt/prior_build.py 保持一致）。
ADULT_RATINGS = frozenset({"q", "e"})
GENERAL_RATINGS = frozenset({"g", "s"})

# 年龄相关 deny-list（hard：命中即 minor_like，永不 adult）。
MINOR_LIKE_TERMS = frozenset({
    "young", "loli", "shota", "child", "children", "toddler", "baby", "infant",
    "adolescent", "teen", "teenager", "kid", "underage",
    # loli-style aliases
    "lolicon", "shotacon",
})

# 年龄歧义短语（可能未成年也可能成年；命中即 age_ambiguous，永不 adult）。
AGE_AMBIGUOUS_TERMS = frozenset({
    "small girl", "small boy", "young woman", "young lady",
    "little sister", "little brother",
})

# 显式成人词汇（仅当无 age 证据、无 rating、无 meta 时才作 fallback 判 adult）。
ADULT_TERMS = frozenset({
    "sex", "sexual", "explicit", "porn", "pornography", "hentai", "nsfw",
    "nude", "naked", "nudity", "topless", "bottomless",
    "masturbation", "fellatio", "cunnilingus", "anilingus", "blowjob",
    "penetration", "ejaculation", "orgasm", "creampie", "cum", "semen",
    "handjob", "footjob", "fingering", "paizuri", "anal", "vaginal",
    "breast", "breasts", "nipple", "nipples", "pussy", "vulva", "vagina",
    "penis", "cock", "erection", "testicles", "scrotum", "anus",
    "dildo", "vibrator", "bondage", "bdsm", "shibari", "futanari",
    "ahegao", "threesome", "foursome", "orgy",
    # 这些是服装/镜头类的性暗示标签，不应因离线 prior 误标为 general 而混入普通推荐。
    "pantyshot", "upskirt", "cameltoe", "crotch",
})


def _norm(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def _contains_phrase(key: str, phrase: str) -> bool:
    """phrase 作为连续 token 序列是否出现在 key 中（token 边界匹配）。"""
    kt = key.split()
    pt = phrase.split()
    n = len(pt)
    if n == 0 or n > len(kt):
        return False
    return any(kt[i:i + n] == pt for i in range(len(kt) - n + 1))


def _is_age_ambiguous(key: str) -> bool:
    return any(_contains_phrase(key, p) for p in AGE_AMBIGUOUS_TERMS)


def _is_minor_like(key: str) -> bool:
    if key in MINOR_LIKE_TERMS:
        return True
    return any(tok in MINOR_LIKE_TERMS for tok in key.split())


def _is_adult_vocab(key: str) -> bool:
    if key in ADULT_TERMS:
        return True
    return any(tok in ADULT_TERMS for tok in key.split())


def _meta_is_adult(meta: Any) -> bool:
    if not meta:
        return False
    if isinstance(meta, Mapping):
        for flag in ("adult", "is_adult", "nsfw", "explicit"):
            if meta.get(flag):
                return True
        return False
    return bool(meta)


def classify_tag_safety(tag: Any, *, rating: Any = None, meta: Any = None) -> str:
    """返回 tag 的 safety_scope：general / adult / minor_like / age_ambiguous。

    ``rating``：Danbooru 帖子 rating（g/s/q/e，大小写归一）。
    ``meta``：可选元信息 dict，含成人证据标记（adult / is_adult / nsfw / explicit）。
    """
    key = _norm(tag)
    if not key:
        return "general"
    # 1/2. 年龄证据优先（hard：永不 adult）。
    if _is_age_ambiguous(key):
        return "age_ambiguous"
    if _is_minor_like(key):
        return "minor_like"
    # 3. Danbooru rating。
    r = _norm(rating)
    if r:
        if r in ADULT_RATINGS:
            return "adult"
        if r in GENERAL_RATINGS:
            return "general"
    # 4. meta 成人证据。
    if _meta_is_adult(meta):
        return "adult"
    # 5. 显式成人词汇 fallback。
    if _is_adult_vocab(key):
        return "adult"
    return "general"


def has_minor_evidence(tag: Any, *, rating: Any = None, meta: Any = None) -> bool:
    """tag（或样本）是否携带 minor_like / age_ambiguous 证据。

    供构建期 adult 作用域硬规则复用：命中即不得写入 adult 作用域。
    """
    return classify_tag_safety(tag, rating=rating, meta=meta) in ("minor_like", "age_ambiguous")


__all__ = [
    "classify_tag_safety",
    "has_minor_evidence",
    "ADULT_RATINGS",
    "GENERAL_RATINGS",
    "MINOR_LIKE_TERMS",
    "AGE_AMBIGUOUS_TERMS",
    "ADULT_TERMS",
]
