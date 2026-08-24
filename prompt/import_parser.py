"""Prompt 导入解析器 —— 把一段 NovelAI 提示词文本解析为结构化 Composer 状态。

支持：
- 数值权重  `1.5::red eyes::` / `1.5::rain, night::`（:: 包裹内的逗号不被拆分）
- 负数权重  `-1::hat::`
- 强调层级  `{{blue eyes}}` / `[[simple background]]`（可嵌套）
- 关系前缀  `source#` / `target#` / `mutual#`
- 多角色分段 `Base:` / `Character N:` / `Character N UC:` / `Global UC:` / `UC:`
- 自然语言自由文本（不含逗号分隔 tag 的段落，或 `Free text:` 前缀）

解析是「导入」的逆操作，与 novelai_export 保持往返一致。
"""
from __future__ import annotations

import re

from prompt import composer

REL_PREFIX = re.compile(r"^(source|target|mutual)#\s*", re.IGNORECASE)
WEIGHT_WRAP = re.compile(r"^(-?\d+(?:\.\d+)?)::(.*)::$", re.DOTALL)
SEGMENT_RE = re.compile(
    r"^(Base|Global UC|UC|Free text|Natural language|Character\s*\d+)\s*(?:UC)?\s*:",
    re.IGNORECASE,
)


def split_tags(text: str) -> list[str]:
    """按逗号拆分，但 :: ... :: 权重包裹内的逗号不拆。"""
    tokens: list[str] = []
    buf: list[str] = []
    in_weight = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == ":" and i + 1 < n and text[i + 1] == ":":
            # 切换 in_weight 状态（成对出现）
            in_weight = not in_weight
            buf.append("::")
            i += 2
            continue
        if ch == "," and not in_weight:
            t = "".join(buf).strip()
            if t:
                tokens.append(t)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    t = "".join(buf).strip()
    if t:
        tokens.append(t)
    return tokens


def _strip_brackets(s: str) -> tuple[str, int]:
    """剥离外层 {} / []，返回 (inner, 层级)，正数为 {} 层、负数为 [] 层。"""
    level = 0
    t = s
    while t.startswith("{") and t.endswith("}"):
        level += 1
        t = t[1:-1]
    while t.startswith("[") and t.endswith("]"):
        level -= 1
        t = t[1:-1]
    return t, level


def parse_entry(token: str) -> dict:
    t = token.strip()
    if not t:
        return None

    # 1) 关系前缀
    relation = None
    m = REL_PREFIX.match(t)
    if m:
        relation = m.group(1).lower()
        t = t[m.end():].strip()

    # 2) 数值权重包裹 X::...::
    strength = None
    m = WEIGHT_WRAP.match(t)
    if m:
        strength = float(m.group(1))
        t = m.group(2).strip()

    # 3) 括号层级
    t, brackets = _strip_brackets(t)

    tag = t.strip()
    if not tag:
        return None
    return {
        "tag": tag,
        "strength": strength,
        "brackets": brackets,
        "relation": relation,
    }


def parse(text: str) -> dict:
    """主入口。返回可直接赋给 Composer state 的 dict。"""
    if not text:
        return {"base": [], "characters": [], "global_uc": [], "free_text": ""}

    text = text.replace("\u3000", " ").replace("，", ",").replace("：", ":")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    base: list[dict] = []
    characters: list[dict] = []
    global_uc: list[dict] = []
    free_text_parts: list[str] = []

    def char_of(idx: int) -> dict:
        while len(characters) <= idx:
            characters.append({"name": f"Character {len(characters) + 1}", "prompt": [], "uc": [], "position": None})
        return characters[idx]

    current = None  # ('base'|'global_uc'|('char', idx)|('char_uc', idx)|'free')

    def entries_for(line: str) -> list[dict]:
        return [e for e in (parse_entry(t) for t in split_tags(line)) if e]

    for line in lines:
        m = SEGMENT_RE.match(line)
        if m:
            head = m.group(0)
            rest = line[len(head):].strip()
            key = head.rstrip(":").strip().lower()
            if key == "base":
                current = "base"
            elif key in ("global uc", "uc"):
                current = "global_uc"
            elif key.startswith("character"):
                num = int(re.search(r"\d+", key).group())
                current = ("char", num - 1) if "uc" not in head.lower() else ("char_uc", num - 1)
            else:  # free text / natural language
                current = "free"
            if rest:
                _route(current, rest, entries_for, base, characters, global_uc, free_text_parts, char_of, parse_entry)
            continue

        # 无前缀行：自然语言优先判定为 free_text；否则归属当前分段（无分段则默认 Base）
        if _looks_like_free_text(line):
            free_text_parts.append(line)
        elif current is None:
            base.extend(entries_for(line))
        else:
            _route(current, line, entries_for, base, characters, global_uc, free_text_parts, char_of, parse_entry)

    return {
        "base": composer.normalize_prompt_list(base),
        "characters": [
            {"name": c["name"], "prompt": composer.normalize_prompt_list(c["prompt"]),
             "uc": composer.normalize_prompt_list(c["uc"]), "position": c.get("position")}
            for c in characters
        ],
        "global_uc": composer.normalize_prompt_list(global_uc),
        "free_text": "\n".join(free_text_parts),
    }


def _route(current, rest, entries_for, base, characters, global_uc, free_text_parts, char_of, parse_entry):
    if current == "base":
        base.extend(entries_for(rest))
    elif current == "global_uc":
        global_uc.extend(entries_for(rest))
    elif current == "free":
        free_text_parts.append(rest)
    elif isinstance(current, tuple):
        kind, idx = current
        c = char_of(idx)
        if kind == "char":
            c["prompt"].extend(entries_for(rest))
        else:
            c["uc"].extend(entries_for(rest))


def _looks_like_free_text(line: str) -> bool:
    """启发式：判断一段无前缀文本是自然语言而非 tag 串。

    关键：权重语法 ::...:: 一定不是自然语言（避免 1.5::hug:: 的小数点被误判）。
    """
    if "::" in line:  # 权重 / 复合短语语法
        return False
    if "," in line:  # tag 串
        return False
    if "#" in line:  # source#/target#/mutual# 关系前缀
        return False
    stripped = line.rstrip()
    if stripped.endswith((".", "。", "!", "！", "?", "？")):
        return True
    return len(line.split()) > 4
