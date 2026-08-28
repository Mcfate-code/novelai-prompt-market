"""姿势模板导入编排：本地元数据、文本和 Civitai 单图候选。"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from .metadata_readers import read_bytes
from .template_distill import distill_prompt

CIVITAI_API = "https://civitai.com/api/v1/images"
CIVITAI_HOSTS = {"civitai.com", "www.civitai.com"}
MAX_REMOTE_BYTES = 2 * 1024 * 1024


def _safe_metadata(value: dict | None) -> dict:
    """只保存可审计的来源信息，不把 Civitai 原图或完整 Prompt 再复制入库。"""
    data = value if isinstance(value, dict) else {}
    allowed = ("id", "width", "height", "nsfwLevel", "browsingLevel", "baseModel", "modelVersionIds", "resources", "civitaiResources", "steps", "sampler", "seed", "cfgScale", "scheduler")
    out = {key: data[key] for key in allowed if key in data and data[key] not in (None, "", [], {})}
    return out


def _metadata_hash(source_type: str, external_id: str, source_url: str, metadata: dict, distilled: dict) -> str:
    value = {"source_type": source_type, "external_id": external_id, "source_url": source_url, "metadata": metadata, "fingerprint": distilled.get("fingerprint")}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def build_candidate(*, positive_prompt: str, negative_prompt: str = "", source_type: str = "text", source_url: str = "", external_id: str = "", metadata: dict | None = None, conn=None, source_format: str = "text") -> dict:
    positive = str(positive_prompt or "").strip()
    if not positive:
        raise ValueError("没有读取到正向 Prompt")
    source_meta = _safe_metadata(metadata)
    distilled = distill_prompt(positive, conn=conn, metadata=metadata or {})
    return {
        "source": {
            "source_type": source_type,
            "external_id": str(external_id or ""),
            "source_url": str(source_url or ""),
            "metadata": source_meta,
            "metadata_hash": _metadata_hash(source_type, external_id, source_url, source_meta, distilled),
        },
        "document": {
            "positive_prompt": positive,
            "negative_prompt": str(negative_prompt or "").strip(),
            "settings": metadata or {},
            "source_format": source_format,
        },
        "distilled": distilled,
        "review": {
            "status": "blocked" if distilled.get("blocked") else "pending",
            "reason": distilled.get("blocked_reason") or ("等待人工确认"),
        },
    }


def import_bytes(data: bytes, *, filename: str = "", source_type: str = "local_file", source_url: str = "", conn=None) -> dict:
    document = read_bytes(data, filename=filename)
    return build_candidate(
        positive_prompt=document.get("positive_prompt") or document.get("raw", {}).get("text", ""),
        negative_prompt=document.get("negative_prompt", ""),
        source_type=source_type,
        source_url=source_url,
        external_id=filename,
        metadata=document.get("settings") or {},
        conn=conn,
        source_format=document.get("source_format", "unknown"),
    )


def import_text(text: str, *, source_type: str = "text", source_url: str = "", conn=None) -> dict:
    return import_bytes(str(text or "").encode("utf-8"), filename="prompt.txt", source_type=source_type, source_url=source_url, conn=conn)


def _civitai_id(value: str) -> str:
    raw = str(value or "").strip()
    if raw.isdigit():
        return raw
    parsed = urllib.parse.urlparse(raw)
    if parsed.hostname not in CIVITAI_HOSTS:
        raise ValueError("Civitai 导入只允许 civitai.com 域名")
    query_id = urllib.parse.parse_qs(parsed.query).get("imageId", [""])[0]
    match = re.search(r"/images/(\d+)", parsed.path)
    image_id = query_id or (match.group(1) if match else "")
    if not image_id.isdigit():
        raise ValueError("无法从 Civitai 地址解析图片 ID")
    return image_id


def fetch_civitai_image(value: str, *, opener: Callable | None = None, timeout: float = 12.0) -> dict:
    image_id = _civitai_id(value)
    query = urllib.parse.urlencode({"imageId": image_id, "withMeta": "true", "limit": "1"})
    request = urllib.request.Request(
        f"{CIVITAI_API}?{query}",
        headers={"Accept": "application/json", "User-Agent": "tags-market-template-import/1.0"},
    )
    open_fn = opener or urllib.request.urlopen
    try:
        with open_fn(request, timeout=timeout) as response:
            raw = response.read(MAX_REMOTE_BYTES + 1)
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeError(f"Civitai API 请求失败：{exc}") from exc
    if len(raw) > MAX_REMOTE_BYTES:
        raise RuntimeError("Civitai 响应过大")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Civitai 返回的不是有效 JSON") from exc
    items = payload.get("items") if isinstance(payload, dict) else None
    image = items[0] if isinstance(items, list) and items else payload if isinstance(payload, dict) and payload.get("id") else None
    if not isinstance(image, dict):
        raise RuntimeError("Civitai 未返回指定图片")
    meta = image.get("meta") if isinstance(image.get("meta"), dict) else {}
    positive = str(meta.get("prompt") or "").strip()
    if not positive:
        raise ValueError("该 Civitai 图片没有公开 Prompt 元数据")
    merged_meta = {**_safe_metadata(image), **_safe_metadata(meta), "nsfw": image.get("nsfwLevel") in {"Mature", "X"}}
    return {
        "image_id": image_id,
        "source_url": f"https://civitai.com/images/{image_id}",
        "positive_prompt": positive,
        "negative_prompt": str(meta.get("negativePrompt") or meta.get("negative_prompt") or "").strip(),
        "metadata": merged_meta,
    }


def import_civitai(value: str, *, opener: Callable | None = None, conn=None) -> dict:
    remote = fetch_civitai_image(value, opener=opener)
    return build_candidate(
        positive_prompt=remote["positive_prompt"],
        negative_prompt=remote["negative_prompt"],
        source_type="civitai",
        source_url=remote["source_url"],
        external_id=remote["image_id"],
        metadata=remote["metadata"],
        conn=conn,
        source_format="civitai",
    )


__all__ = ["build_candidate", "import_bytes", "import_text", "import_civitai", "fetch_civitai_image", "CIVITAI_API"]
