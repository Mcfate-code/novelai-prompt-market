"""Phase 3：语义归属 / 身份映射确定性（spec 3.1–3.7）。

覆盖 6 个命名用例（1girl / solo / 具名角色 / copyright / full body / blue eyes），
全部调用 ``build_embedding_prior.resolve_node`` / ``load_navigation``，绝不发起真实 API
调用，也不依赖 data/*.sqlite 先验库。

同时解析 config/prompt_navigation.json 与 config/semantic_slots.json，断言
char_identity 节点（及槽位）不再携带 solo / 1girl 等主体计数 seed。
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.build_embedding_prior as build  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
NAV_PATH = REPO_ROOT / "config" / "prompt_navigation.json"
SLOTS_PATH = REPO_ROOT / "config" / "semantic_slots.json"

# seed / category / taxonomy 决策不依赖 embedding；向量仅占位。
_VEC = np.array([0.0], dtype=np.float32)


def _norm(tag) -> str:
    return " ".join(str(tag or "").strip().lower().replace("_", " ").split())


def _resolve(tag_key, meta):
    seed_map, _ = build.load_navigation()
    return build.resolve_node(
        tag_key, meta, _VEC, {}, seed_map, set(), 0.35, 0.03,
    )


def _find_node(node_id):
    data = json.loads(NAV_PATH.read_text(encoding="utf-8"))
    found = {}

    def walk(node):
        if node.get("id") == node_id:
            found["node"] = node
        for c in node.get("children") or []:
            walk(c)

    for root_key in ("base", "character"):
        root = data.get(root_key)
        if root:
            walk(root)
    return found.get("node")


def _find_slot(node_id):
    slots = json.loads(SLOTS_PATH.read_text(encoding="utf-8"))
    return next((s for s in slots if s.get("node_id") == node_id), None)


# --------------------------------------------------------------------------- #
# 6 个命名用例（spec 3.6）
# --------------------------------------------------------------------------- #
def test_1girl_is_base_subject_count_not_identity():
    node, conf, src, _, _ = _resolve(
        "1girl", {"taxonomy_l1": "人物数量与主体", "category": 0, "section": None})
    assert node == "base_subject_count"
    assert src == "seed"
    assert node != "char_identity"


def test_solo_is_base():
    node, conf, src, _, _ = _resolve(
        "solo", {"taxonomy_l1": "人物数量与主体", "category": 0, "section": None})
    assert node == "base_subject_count"
    assert src == "seed"
    assert node != "char_identity"


def test_named_character_is_identity():
    node, conf, src, _, _ = _resolve(
        "hatsune miku", {"taxonomy_l1": None, "category": 4, "section": None})
    assert node == "char_identity"
    assert src == "category"


def test_copyright_tag_not_identity():
    for tag in ("genshin impact", "fate (series)"):
        node, conf, src, _, _ = _resolve(
            tag, {"taxonomy_l1": None, "category": 3, "section": None})
        assert node != "char_identity"
        assert src == "copyright"


def test_full_body_is_composition_not_char_body():
    node, conf, src, _, _ = _resolve(
        "full body", {"taxonomy_l1": None, "category": 0, "section": None})
    assert node == "base_composition"
    assert src == "seed"
    assert node != "char_body"


def test_blue_eyes_is_char_eyes():
    node, conf, src, _, _ = _resolve(
        "blue eyes", {"taxonomy_l1": "眼睛颜色", "category": 0, "section": None})
    assert node == "char_eyes"
    assert src == "seed"


# --------------------------------------------------------------------------- #
# 附加：taxonomy 不再把主体计数塞进 char_identity（spec 3.5）
# --------------------------------------------------------------------------- #
def test_subject_count_taxonomy_not_identity():
    # 3girls 不在 seed_map，走 taxonomy「人物数量与主体」→ base_subject_count
    node, conf, src, _, _ = _resolve(
        "3girls", {"taxonomy_l1": "人物数量与主体", "category": 0, "section": None})
    assert node == "base_subject_count"
    assert src == "taxonomy"
    assert node != "char_identity"


def test_glasses_deterministic_accessory():
    # §3.4 多证据标签固定裁决为单一视觉节点：Accessory > Face > Eyes
    node, conf, src, _, _ = _resolve(
        "glasses", {"taxonomy_l1": "眼镜、面部与穿戴物", "category": 0, "section": None})
    assert node == "char_clothing_accessory"
    assert src == "seed"


# --------------------------------------------------------------------------- #
# 配置断言：char_identity 不再携带 solo / 1girl（spec 3.1/3.6）
# --------------------------------------------------------------------------- #
def test_nav_char_identity_seeds_exclude_subject_count():
    node = _find_node("char_identity")
    assert node is not None
    seeds = {_norm(t) for t in node.get("seed_tags") or []}
    assert "solo" not in seeds
    assert "1girl" not in seeds
    assert "1boy" not in seeds
    assert "2girls" not in seeds
    # 身份 seed 应是 girl / boy
    assert "girl" in seeds
    assert "boy" in seeds


def test_slots_char_identity_keywords_exclude_subject_count():
    slot = _find_slot("char_identity")
    assert slot is not None
    kws = {_norm(k) for k in slot.get("keywords_en") or []}
    assert "solo" not in kws
    assert "1girl" not in kws
    assert "1boy" not in kws
    assert "girl" in kws
    assert "boy" in kws


def test_nav_base_subject_count_owns_subject_count_tags():
    seed_map, _ = build.load_navigation()
    for tag in ("solo", "1girl", "1boy", "2girls", "2boys",
                "multiple girls", "multiple boys", "couple", "crowd"):
        assert seed_map[tag] == "base_subject_count", tag


def test_nav_full_body_and_composition():
    seed_map, _ = build.load_navigation()
    assert seed_map["full body"] == "base_composition"
    assert seed_map["portrait"] == "base_composition"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
