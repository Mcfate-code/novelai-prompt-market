"""生成图片元数据读取器。

把不同工作流写入 PNG/JSON 的元数据统一成：
``positive_prompt``、``negative_prompt``、``settings`` 和 ``raw``。

读取器只解析用户已经拿到的本地文件或受信任 API 返回值，不下载任意图片，
避免把在线导入变成 SSRF 或隐式素材采集。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .a1111 import parse_a1111
from .comfyui import parse_comfyui
from .novelai import parse_novelai
from .png import read_png_text_chunks


def _json_value(value: str) -> Any | None:
    text = str(value or "").strip()
    if not text or text[0] not in "[{":
        return None
    try:
        return json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return None


def _merge(base: dict, extra: dict) -> dict:
    """非空字段合并；后面的专用读取器优先。"""
    result = dict(base or {})
    for key, value in (extra or {}).items():
        if value in (None, "", [], {}):
            continue
        if key == "settings" and isinstance(value, dict):
            result[key] = {**(result.get(key) or {}), **value}
        elif key == "raw" and isinstance(value, dict):
            result[key] = {**(result.get(key) or {}), **value}
        else:
            result[key] = value
    return result


def _from_text_chunks(chunks: dict[str, list[str]]) -> dict:
    result: dict = {"source_format": "png", "raw": {k: list(v) for k, v in chunks.items()}}
    # A1111/Forge 通常写入 parameters；某些导出器使用 Comment/Text。
    for key in ("parameters", "Parameters", "comment", "Comment", "prompt", "Prompt", "Description", "text"):
        for value in chunks.get(key, []):
            result = _merge(result, parse_a1111(value))
            result = _merge(result, parse_novelai(value))
            parsed_json = _json_value(value)
            if isinstance(parsed_json, dict):
                result = _merge(result, parse_comfyui(parsed_json))

    # ComfyUI 常见字段是 prompt/workflow，字段名大小写不固定。
    for key, values in chunks.items():
        lower = key.lower()
        for value in values:
            parsed_json = _json_value(value)
            if not isinstance(parsed_json, (dict, list)):
                continue
            if lower in {"workflow", "prompt", "comfyui_workflow", "comfy_prompt"} or isinstance(parsed_json, dict):
                result = _merge(result, parse_comfyui(parsed_json))
                result = _merge(result, parse_novelai(value))

    # 纯文本 PNG 元数据或用户手动粘贴的文本也可作为兜底。
    if not result.get("positive_prompt"):
        for values in chunks.values():
            for value in values:
                if value.strip() and ("," in value or "Negative prompt:" in value or "Steps:" in value):
                    result = _merge(result, parse_a1111(value))
                    if result.get("positive_prompt"):
                        break
            if result.get("positive_prompt"):
                break
    return result


def read_bytes(data: bytes, *, filename: str = "") -> dict:
    """读取 PNG/JSON/纯文本字节，不抛出格式解析异常。"""
    suffix = Path(filename).suffix.lower()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        try:
            return _from_text_chunks(read_png_text_chunks(data))
        except ValueError as exc:
            return {"source_format": "png", "positive_prompt": "", "negative_prompt": "", "settings": {}, "raw": {}, "warnings": [str(exc)]}

    text = data.decode("utf-8", errors="replace").strip()
    if suffix in {".json", ".workflow"} or text[:1] in "[{":
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, (dict, list)):
            result = _merge({"source_format": "json", "raw": {"json": payload}}, parse_comfyui(payload))
            result = _merge(result, parse_novelai(text))
            if result.get("positive_prompt"):
                return result
    return _merge({"source_format": "text", "raw": {"text": text}}, parse_a1111(text))


def read_file(path: str | Path) -> dict:
    file_path = Path(path)
    return read_bytes(file_path.read_bytes(), filename=file_path.name)


__all__ = ["read_bytes", "read_file", "read_png_text_chunks"]
