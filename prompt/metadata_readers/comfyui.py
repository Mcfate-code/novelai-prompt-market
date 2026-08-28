"""ComfyUI workflow/prompt JSON 的保守解析器。

只把进入 KSampler/采样器 positive、negative 输入的 CLIP 文本当作主提示词；
无法追踪连线时按节点标题/输入名做降级判断，并在 warnings 中说明。
"""
from __future__ import annotations

from typing import Any


def _node_map(payload: Any) -> dict[str, dict]:
    if not isinstance(payload, dict):
        return {}
    if isinstance(payload.get("prompt"), dict):
        payload = payload["prompt"]
    if isinstance(payload.get("workflow"), dict) and not any(isinstance(v, dict) and "class_type" in v for v in payload.values()):
        payload = payload["workflow"]
    if isinstance(payload.get("nodes"), list):
        result = {}
        for node in payload["nodes"]:
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("id") or len(result) + 1)
            inputs = dict(node.get("inputs") or {}) if isinstance(node.get("inputs"), dict) else {}
            widgets = node.get("widgets_values")
            if isinstance(widgets, list) and widgets and "text" not in inputs:
                # ComfyUI 前端工作流把 CLIPTextEncode 文本放在 widgets_values[0]。
                if isinstance(widgets[0], str):
                    inputs["text"] = widgets[0]
            result[node_id] = {"class_type": node.get("type") or node.get("class_type") or "", "inputs": inputs, "title": node.get("title") or node.get("properties", {}).get("Node name for S&R", "")}
        return result
    return {str(k): v for k, v in payload.items() if isinstance(v, dict) and isinstance(v.get("inputs"), dict)}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_comfyui(payload: Any) -> dict:
    nodes = _node_map(payload)
    if not nodes:
        return {}
    positive_ids: set[str] = set()
    negative_ids: set[str] = set()
    for node_id, node in nodes.items():
        inputs = node.get("inputs") or {}
        klass = str(node.get("class_type") or "").lower()
        if "sampler" not in klass and "ksampler" not in klass:
            continue
        for key, target in inputs.items():
            if isinstance(target, list) and target and str(target[0]) in nodes:
                if "negative" in str(key).lower() or "uc" in str(key).lower():
                    negative_ids.add(str(target[0]))
                elif "positive" in str(key).lower():
                    positive_ids.add(str(target[0]))

    positives: list[str] = []
    negatives: list[str] = []
    for node_id, node in nodes.items():
        inputs = node.get("inputs") or {}
        klass = str(node.get("class_type") or "").lower()
        if "cliptextencode" not in klass and "textencode" not in klass and "prompt" not in klass:
            continue
        value = _text(inputs.get("text") or inputs.get("prompt"))
        if not value:
            continue
        title = " ".join(str(node.get(k) or "") for k in ("title", "_meta"))
        if node_id in negative_ids or "negative" in title.lower():
            negatives.append(value)
        elif node_id in positive_ids or node_id not in negative_ids:
            positives.append(value)
    if not positives and not negatives:
        return {}
    return {
        "source_format": "comfyui",
        "positive_prompt": ", ".join(dict.fromkeys(positives)),
        "negative_prompt": ", ".join(dict.fromkeys(negatives)),
        "settings": {},
        "raw": {"comfyui_node_count": len(nodes)},
        "warnings": (["未能从采样器连线确认正负面节点，已按节点名称降级判断"] if not positive_ids and not negative_ids else []),
    }


__all__ = ["parse_comfyui"]
