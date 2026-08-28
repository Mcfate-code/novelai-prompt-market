"""NovelAI PNG/JSON 元数据的宽松读取器。

NovelAI 导出字段可能随版本变化，因此不依赖单一固定字段名，而是递归查找
prompt/uc/negative_prompt，并保留未知字段数量供审核。
"""
from __future__ import annotations

import json
from typing import Any


POSITIVE_KEYS = {"prompt", "positive_prompt", "base_caption", "caption"}
NEGATIVE_KEYS = {"uc", "negative_prompt", "undesired_content", "negative"}


def _walk(value: Any, path: tuple[str, ...] = ()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key), child, path
            yield from _walk(child, path + (str(key),))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield str(index), child, path
            yield from _walk(child, path + (str(index),))


def parse_novelai(value: str | dict | list) -> dict:
    payload: Any = value
    if isinstance(value, str):
        text = value.strip()
        if not text or text[0] not in "[{":
            return {}
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return {}
    if not isinstance(payload, (dict, list)):
        return {}
    positives: list[str] = []
    negatives: list[str] = []
    settings: dict = {}
    for key, child, _path in _walk(payload):
        normalized = key.strip().lower().replace("-", "_").replace(" ", "_")
        if isinstance(child, str) and child.strip():
            if normalized in NEGATIVE_KEYS or normalized.endswith("_uc"):
                negatives.append(child.strip())
            elif normalized in POSITIVE_KEYS or normalized.endswith("_prompt"):
                positives.append(child.strip())
        elif normalized in {"seed", "steps", "width", "height", "sampler", "model", "scale", "cfg_rescale"} and isinstance(child, (int, float, str)):
            settings[normalized] = child
    if not positives and not negatives:
        return {}
    return {
        "source_format": "novelai",
        "positive_prompt": ", ".join(dict.fromkeys(positives)),
        "negative_prompt": ", ".join(dict.fromkeys(negatives)),
        "settings": settings,
        "raw": {"novelai_json": True},
    }


__all__ = ["parse_novelai"]
