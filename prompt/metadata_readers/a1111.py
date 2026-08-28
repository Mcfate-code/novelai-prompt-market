"""AUTOMATIC1111/Forge infotext 解析。"""
from __future__ import annotations

import re


def _settings(text: str) -> dict:
    out: dict = {}
    # A1111 的逗号分隔参数允许引号和少量嵌套；这里只解析常用标量，原文仍由 raw 保留。
    for match in re.finditer(r"(?:^|[\n,]\s*)([A-Za-z][A-Za-z0-9 _/.-]*):\s*(\"[^\"]*\"|[^,]+)", text):
        key = match.group(1).strip()
        value = match.group(2).strip().strip('"')
        if key.lower() in {"steps", "seed", "width", "height", "clip skip"}:
            try:
                out[key.lower().replace(" ", "_")] = int(value)
            except ValueError:
                out[key.lower().replace(" ", "_")] = value
        elif key.lower() in {"cfg scale", "denoising strength"}:
            try:
                out[key.lower().replace(" ", "_")] = float(value)
            except ValueError:
                out[key.lower().replace(" ", "_")] = value
        elif key.lower() in {"sampler", "model", "schedule type", "version"}:
            out[key.lower().replace(" ", "_")] = value
    size = re.search(r"(?:^|,\s*)Size:\s*(\d+)x(\d+)", text, flags=re.I)
    if size:
        out["width"], out["height"] = int(size.group(1)), int(size.group(2))
    return out


def parse_a1111(value: str) -> dict:
    text = str(value or "").replace("\r\n", "\n").strip()
    if not text:
        return {}
    marker = re.search(r"(?:^|\n)Negative prompt:\s*", text, flags=re.I)
    settings_marker = re.search(r"(?:^|\n)(?:Steps|Sampler|CFG scale|Size):\s*", text, flags=re.I)
    if marker:
        positive = text[:marker.start()].strip()
        negative_end = settings_marker.start() if settings_marker and settings_marker.start() > marker.end() else len(text)
        negative = text[marker.end():negative_end].strip()
    else:
        positive_end = settings_marker.start() if settings_marker else len(text)
        positive, negative = text[:positive_end].strip(), ""
    settings_text = text[settings_marker.start():] if settings_marker else ""
    if not positive and not negative:
        return {}
    return {
        "positive_prompt": positive,
        "negative_prompt": negative,
        "settings": _settings(settings_text),
        "raw": {"a1111": text},
    }


__all__ = ["parse_a1111"]
