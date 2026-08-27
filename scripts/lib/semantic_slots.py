"""语义槽位定义与 embedding 槽位分配（§9/§30/§31）。

加载 config/semantic_slots.json；把每个槽位节点的描述 + 关键词 embedding 后取均值，
得到「槽位向量」。``assign_slot`` 做带歧义保护的最近槽位判定：

- 若 top1 < min_similarity 或 top1-top2 < min_margin → 返回 ``(None, score, "embedding_ambiguous")``。
- 否则返回 ``(node_id, score, "embedding")``。

默认 min_similarity=0.35 / min_margin=0.03（在 benchmark 中校准，实际值记入 manifest）。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

DEFAULT_SLOTS_PATH = Path(__file__).resolve().parent.parent.parent / "config" / "semantic_slots.json"

DEFAULT_MIN_SIMILARITY = 0.35
DEFAULT_MIN_MARGIN = 0.03


def load_slots(path=None) -> list[dict]:
    p = Path(path) if path else DEFAULT_SLOTS_PATH
    return json.loads(p.read_text(encoding="utf-8"))


def slot_texts(slot: dict) -> list[str]:
    """该槽位需要 embedding 的文本：描述 + 全部 EN 关键词 + label。"""
    texts = []
    desc = (slot.get("description_en") or "").strip()
    label = (slot.get("label") or "").strip()
    if desc:
        texts.append(desc)
    for kw in slot.get("keywords_en") or []:
        kw = str(kw).strip()
        if kw and kw not in texts:
            texts.append(kw)
    if label and label not in texts:
        texts.append(label)
    return texts or [slot.get("node_id", "")]


def embed_slot_vectors(slots, embed_fn):
    """为每个槽位生成质心向量（关键词+描述 embedding 均值，L2 归一）。

    ``embed_fn(texts) -> (embeddings, usage)``（复用 Provider 客户端，内部可走缓存）。
    返回 ``(slot_vectors: dict[node_id -> np.ndarray], usage_total: dict)``。
    """
    usage_total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    slot_vectors = {}
    for slot in slots:
        texts = slot_texts(slot)
        emb, usage = embed_fn(texts)
        for k in usage_total:
            usage_total[k] = int(usage_total.get(k) or 0) + int(usage.get(k) or 0)
        mat = np.asarray(emb, dtype=np.float32)
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        mat = mat / norms
        centroid = mat.mean(axis=0)
        n = float(np.linalg.norm(centroid))
        if n == 0.0:
            n = 1.0
        slot_vectors[slot["node_id"]] = (centroid / n).astype(np.float32)
    return slot_vectors, usage_total


def assign_slot(tag_vector, slot_vectors, *, min_similarity=DEFAULT_MIN_SIMILARITY,
                min_margin=DEFAULT_MIN_MARGIN):
    """tag_vector 与 slot_vectors（已归一）余弦相似 → 带歧义保护的槽位。

    返回 ``(node_id | None, score, rule_source)``；rule_source ∈ {"embedding", "embedding_ambiguous"}。
    """
    v = np.asarray(tag_vector, dtype=np.float32).reshape(1, -1)
    n = float(np.linalg.norm(v))
    if n == 0.0:
        return None, 0.0, "embedding_ambiguous"
    v = v / n
    node_ids = list(slot_vectors.keys())
    if not node_ids:
        return None, 0.0, "embedding_ambiguous"
    matrix = np.vstack([slot_vectors[nid] for nid in node_ids])
    sims = (matrix @ v.T).ravel()
    order = np.argsort(-sims)
    top1_idx = int(order[0])
    top1_score = float(sims[top1_idx])
    top2_score = float(sims[int(order[1])]) if len(order) > 1 else 0.0
    if top1_score < min_similarity or (top1_score - top2_score) < min_margin:
        return None, top1_score, "embedding_ambiguous"
    return node_ids[top1_idx], top1_score, "embedding"


def node_to_family(slots: list[dict]) -> dict[str, str]:
    return {s["node_id"]: s.get("family", s["node_id"]) for s in slots}


__all__ = [
    "load_slots",
    "slot_texts",
    "embed_slot_vectors",
    "assign_slot",
    "node_to_family",
    "DEFAULT_MIN_SIMILARITY",
    "DEFAULT_MIN_MARGIN",
]
