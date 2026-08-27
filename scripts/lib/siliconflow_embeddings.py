"""SiliconFlow Embeddings API 客户端（仅构建期使用，运行时零依赖）。

使用 stdlib urllib.request 调用 SiliconFlow 在线 Embeddings API，绝不引入
requests/httpx 运行时依赖。API Key 只从环境变量 ``SILICONFLOW_API_KEY`` 读取；
未设置时抛 ``SiliconFlowKeyMissing``，绝不回退到本地模型下载（§75）。

安全约定：任何情况下都不得打印 / 记录 Key 本身，只允许打印 "configured" /
"missing"。
"""
from __future__ import annotations

import json
import math
import os
import random
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

ENDPOINT = "https://api.siliconflow.cn/v1/embeddings"
HARD_INPUT_CAP = 32          # API input 数组硬上限 maxItems=32
EXPECTED_DIM = 1024          # bge-m3 / bge-large-zh-v1.5 均为 1024 维
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
NON_RETRYABLE_STATUS = {400, 401, 403, 404}
MAX_CHARS_LARGE_ZH = 1500    # bge-large-zh-v1.5 512 token 上限，按字符防御性截断


class SiliconFlowError(Exception):
    """SiliconFlow provider 基础错误。"""


class SiliconFlowKeyMissing(SiliconFlowError):
    """SILICONFLOW_API_KEY 未设置（禁止回退到本地模型下载）。"""


class SiliconFlowHTTPError(SiliconFlowError):
    def __init__(self, status: int, message: str):
        super().__init__(f"SiliconFlow HTTP {status}: {message}")
        self.status = status
        self.retryable = status in RETRYABLE_STATUS


class SiliconFlowResponseError(SiliconFlowError):
    """响应校验失败（维度不符 / 数量不符 / 非法向量）——不可重试。"""


def get_api_key() -> str:
    """读取 API Key；未设置即抛错。绝不打印 Key。"""
    key = os.environ.get("SILICONFLOW_API_KEY", "")
    if not key:
        raise SiliconFlowKeyMissing("missing SILICONFLOW_API_KEY")
    return key


def key_status() -> str:
    return "configured" if os.environ.get("SILICONFLOW_API_KEY") else "missing"


def l2_normalize(vec) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0.0:
        return list(vec)
    return [x / norm for x in vec]


def _chunk(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _truncate(text: str, model: str) -> str:
    """bge-large-zh-v1.5 输入上限 512 token，按字符防御性截断（中文按字符近似）。"""
    if "large-zh" in model and len(text) > MAX_CHARS_LARGE_ZH:
        return text[:MAX_CHARS_LARGE_ZH]
    return text


def _parse_response(payload: dict, texts: list[str]):
    data = payload.get("data")
    n = len(texts)
    if not isinstance(data, list) or len(data) != n:
        got = len(data) if isinstance(data, list) else type(data).__name__
        raise SiliconFlowResponseError(
            f"expected {n} embeddings, got {got}"
        )
    embeddings: list[Optional[list[float]]] = [None] * n
    for item in data:
        idx = item.get("index")
        vec = item.get("embedding")
        if not isinstance(idx, int) or not (0 <= idx < n):
            raise SiliconFlowResponseError(f"bad embedding index {idx!r}")
        if not isinstance(vec, list) or len(vec) != EXPECTED_DIM:
            got_dim = len(vec) if isinstance(vec, list) else type(vec).__name__
            raise SiliconFlowResponseError(
                f"dim mismatch: expected {EXPECTED_DIM}, got {got_dim}"
            )
        embeddings[idx] = vec
    for i, vec in enumerate(embeddings):
        if vec is None:
            raise SiliconFlowResponseError(f"missing embedding at index {i}")
        if not all(math.isfinite(x) for x in vec):
            raise SiliconFlowResponseError(f"non-finite values at index {i}")
        if not any(x != 0.0 for x in vec):
            raise SiliconFlowResponseError(f"all-zero vector at index {i}")
    usage = payload.get("usage") or {}
    return embeddings, usage


def _embed_once(texts, model, key, *, encoding_format="float", timeout=60):
    """单次 HTTP 调用（texts 必须 <= HARD_INPUT_CAP）。返回 (embeddings, usage)。"""
    body = {
        "model": model,
        "input": [t for t in texts],
        "encoding_format": encoding_format,
    }
    payload_bytes = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT,
        data=payload_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return _parse_response(payload, texts)


# on_request(duration: float, ok: bool, status: Optional[int], prompt_tokens: int)
RequestCallback = Callable[[float, bool, Optional[int], int], None]


def _embed_with_retry(chunk, model, key, *, encoding_format, timeout, max_retries, on_request):
    attempt = 0
    while True:
        attempt += 1
        status = None
        t0 = time.monotonic()
        try:
            emb, usage = _embed_once(
                chunk, model, key, encoding_format=encoding_format, timeout=timeout
            )
            tokens = int((usage or {}).get("prompt_tokens") or 0)
            if on_request:
                on_request(time.monotonic() - t0, True, 200, tokens)
            return emb, usage
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                e.read()
            except Exception:
                pass
            if on_request:
                on_request(time.monotonic() - t0, False, status, 0)
            if status in NON_RETRYABLE_STATUS:
                raise SiliconFlowHTTPError(status, "non-retryable") from e
            if status not in RETRYABLE_STATUS:
                raise SiliconFlowHTTPError(status, "unexpected status") from e
            # retryable（429/5xx）落入下方 backoff
        except (urllib.error.URLError, TimeoutError, OSError, ConnectionError) as e:
            if on_request:
                on_request(time.monotonic() - t0, False, None, 0)
            if attempt > max_retries:
                raise SiliconFlowHTTPError(0, f"network error after {max_retries} retries: {e}") from e
        except SiliconFlowResponseError:
            raise  # 维度/数量校验失败不可重试
        if attempt > max_retries:
            raise SiliconFlowHTTPError(
                status or 0, f"retries exhausted ({attempt - 1} retries, status {status})"
            )
        # 指数退避 1s,2s,4s,8s… 上限 60s + 抖动（§ "Exponential backoff"）
        delay = min(60.0, 2 ** (attempt - 1)) * (0.5 + random.random())
        time.sleep(delay)


def embed_batch(
    texts,
    model,
    *,
    encoding_format="float",
    timeout=60,
    max_retries=5,
    concurrency=1,
    batch_size=16,
    on_request: Optional[RequestCallback] = None,
):
    """Embed 任意数量文本（内部按 batch_size 分块，上限 HARD_INPUT_CAP=32）。

    返回 ``(embeddings: list[list[float]], usage: dict)``；usage 聚合所有分块。
    API Key 仅在此处校验一次（缺失立即抛 ``SiliconFlowKeyMissing``）。
    """
    key = get_api_key()  # fail-fast；绝不打印 key
    texts = [_truncate(str(t), model) for t in texts]
    bs = max(1, min(int(batch_size), HARD_INPUT_CAP))
    chunks = list(_chunk(texts, bs))

    def _run(chunk):
        return _embed_with_retry(
            chunk, model, key,
            encoding_format=encoding_format, timeout=timeout,
            max_retries=max_retries, on_request=on_request,
        )

    if concurrency > 1 and len(chunks) > 1:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            results = list(ex.map(_run, chunks))
    else:
        results = [_run(c) for c in chunks]

    all_embeddings = []
    usage_total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    for emb, usage in results:
        all_embeddings.extend(emb)
        for k in usage_total:
            usage_total[k] = int(usage_total.get(k) or 0) + int((usage or {}).get(k) or 0)
    return all_embeddings, usage_total


__all__ = [
    "SiliconFlowError",
    "SiliconFlowKeyMissing",
    "SiliconFlowHTTPError",
    "SiliconFlowResponseError",
    "get_api_key",
    "key_status",
    "l2_normalize",
    "embed_batch",
    "ENDPOINT",
    "HARD_INPUT_CAP",
    "EXPECTED_DIM",
]
