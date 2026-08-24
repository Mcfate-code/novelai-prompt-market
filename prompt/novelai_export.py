"""NovelAI Prompt 导出。

只输出 NovelAI 原生语法：
- `{}` / `[]` 逐层强调（约 ×1.05 / ÷1.05）
- 数值权重 `1.5::tag::`
- V4.5+ 负数权重 `-1::hat::`
- 多角色关系前缀 `source# / target# / mutual#`

不输出 Stable Diffusion WebUI 的 `(tag:1.2)`。
"""
from __future__ import annotations

from . import composer as C


def format_entry(entry: dict, overlay: dict) -> str:
    """把单个 entry 转成 NovelAI 字符串。"""
    e = C.normalize_entry(entry)
    tag = e["tag"]
    if not tag:
        return ""
    supports = overlay.get("supports", {})

    # 关系前缀（多角色）
    if e["relation"] and supports.get("multi_character", True):
        tag = f"{e['relation']}#{tag}"

    strength = e["strength"]
    if strength is not None and strength != 1.0 and supports.get("numeric_weight", True):
        if strength < 0 and not supports.get("negative_weight", True):
            # 不支持负数权重：落回 bracket 弱化
            n = min(8, int(abs(strength) * 20))
            return f"{'[' * n}{tag}{']' * n}"
        return f"{C.format_number(strength)}::{tag}::"

    brackets = e["brackets"]
    if brackets > 0:
        n = min(8, brackets)
        return f"{'{' * n}{tag}{'}' * n}"
    if brackets < 0:
        n = min(8, -brackets)
        return f"{'[' * n}{tag}{']' * n}"

    return tag


def render_section(entries, overlay: dict) -> str:
    parts = [format_entry(e, overlay) for e in C.normalize_prompt_list(entries)]
    return ", ".join(p for p in parts if p)


def export(state: dict, model_id: str | None = None) -> dict:
    """把 composer 状态导出为 NovelAI prompt。

    state 结构（规格 5.1）：
    {
      "model": "v5",
      "base_prompt": [entries],
      "characters": [{"name", "prompt": [entries], "uc": [entries], "position"}],
      "global_uc": [entries],
      "free_text": ""
    }
    """
    model_id = state.get("model") or model_id
    overlay = C.load_overlay(model_id)

    base = render_section(state.get("base_prompt", []), overlay)
    free_text = (state.get("free_text") or "").strip()
    global_uc = render_section(state.get("global_uc", []), overlay)

    characters = []
    for ch in state.get("characters", []):
        characters.append(
            {
                "name": ch.get("name") or "",
                "prompt": render_section(ch.get("prompt", []), overlay),
                "uc": render_section(ch.get("uc", []), overlay),
                "position": ch.get("position"),
            }
        )

    lines: list[str] = []
    if base:
        lines.append(f"Base: {base}")
    for i, ch in enumerate(characters, 1):
        name = ch["name"] or f"Character {i}"
        if ch["prompt"]:
            lines.append(f"{name}: {ch['prompt']}")
        if ch["uc"]:
            lines.append(f"{name} UC: {ch['uc']}")
    if global_uc:
        lines.append(f"Global UC: {global_uc}")
    if free_text:
        lines.append(f"Free text: {free_text}")

    # 单角色/无角色：flat prompt 直接可复制
    plain_parts = [base]
    for ch in characters:
        if ch["prompt"]:
            plain_parts.append(ch["prompt"])
    flat = ", ".join(p for p in plain_parts if p)
    if free_text:
        flat = f"{flat}\n{free_text}" if flat else free_text

    has_characters = bool(characters and any(c["prompt"] for c in characters))
    return {
        "model": model_id,
        "model_full": overlay.get("id"),
        "base": base,
        "characters": characters,
        "global_uc": global_uc,
        "free_text": free_text,
        "structured": "\n".join(lines),
        "flat": flat,
        "multi_character": has_characters,
        "conflicts": C.conflict_hints(
            state.get("base_prompt", [])
            + [e for ch in state.get("characters", []) for e in ch.get("prompt", [])],
            model_id,
        ),
        "warnings": validate(state, overlay),
    }


def validate(state: dict, overlay: dict | None = None) -> list[str]:
    """只验证真实失败模式，不叠过度严谨的校验。"""
    overlay = overlay or C.load_overlay(state.get("model"))
    supports = overlay.get("supports", {})
    warnings: list[str] = []

    max_chars = supports.get("max_characters")
    if max_chars is not None:
        n = len([c for c in state.get("characters", []) if c.get("prompt")])
        if n > max_chars:
            warnings.append(f"{overlay.get('label')} 建议不超过 {max_chars} 个角色（当前 {n}）")

    for e in C.normalize_prompt_list(state.get("base_prompt", [])):
        if e["strength"] is not None and e["strength"] < 0 and not supports.get("negative_weight"):
            warnings.append(f"{overlay.get('label')} 不支持负数权重：{e['tag']}")

    return warnings
