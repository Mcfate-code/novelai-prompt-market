"""Phase 4：semantic alternatives（相似/替代）与 additive "Next Step" 推荐分离。

覆盖（spec 4.2/4.3/4.5/4.6/4.9/4.10）：
- blue eyes -> red eyes 只作为 semantic alternative 出现，绝不进入默认
  "Next Step" 加法推荐列表（即便 NPMI related_tags 也返回 red eyes）。
- Eyes 已填、Expression/Pose 为空时，Next Step 仍是 Expression / Pose，
  不被眼睛的相似替代项挤占。
- 纯 fake 注入 / monkeypatch prior，不发任何网络 / embedding API。
"""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import prompt.prior as prior_mod
from prompt.recommendation import RecommendationService


class _FakePrior:
    """Controlled offline prior stand-in — no sqlite, no network, no API."""

    def __init__(self, related=(), neighbors=(), context=(), slots=None, transitions=()):
        self.related = list(related)
        self.neighbors = list(neighbors)
        self.context = list(context)
        self.slots = slots or {}
        self.transitions = list(transitions)

    def is_available(self):
        return True

    def related_tags(self, tag, adult=False):
        return self.related

    def semantic_neighbors(self, tag, adult=False):
        return self.neighbors

    def context_candidates(self, tag, adult=False):
        return self.context

    def slot_candidates(self, slot, context=None, adult=False):
        return self.slots.get(slot, [])

    def next_slot_prior(self, filled_slots, all_slots=None, adult=False):
        return self.transitions


def _eyes_filled_state():
    """Eyes 已填；Expression / Pose 为空（missing）。"""
    return SimpleNamespace(next_steps=lambda target, limit: [
        SimpleNamespace(node_id="char_expression", label="Expression", zh="表情", status="empty", reason="尚未设置"),
        SimpleNamespace(node_id="char_pose", label="Pose", zh="姿势", status="empty", reason="尚未设置"),
    ])


class SemanticAlternativeSeparationTest(unittest.TestCase):
    def setUp(self):
        self.prior_patch = patch.object(prior_mod, "get_prior", return_value=_FakePrior())
        self.prior_patch.start()

    def tearDown(self):
        self.prior_patch.stop()

    def _service(self, prior=None, sources=None):
        if prior is not None:
            self.prior_patch.stop()
            self.prior_patch = patch.object(prior_mod, "get_prior", return_value=prior)
            self.prior_patch.start()
        return RecommendationService(sources=sources or {})

    def test_blue_eyes_red_eyes_is_alternative_not_add(self):
        # NPMI related_tags 也返回 "red eyes"（prompt compatibility 信号），
        # 但 semantic_neighbors 标记其为 same_slot 替代项 → 必须从加法列表剔除。
        prior = _FakePrior(
            related=[
                {"tag": "red eyes", "npmi": 0.3},
                {"tag": "long hair", "npmi": 0.2},
            ],
            neighbors=[
                {"tag": "red eyes", "similarity": 0.92, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
                {"tag": "green eyes", "similarity": 0.91, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
            ],
            slots={
                "char_expression": [{"tag": "smile", "frequency": 100}],
                "char_pose": [{"tag": "standing", "frequency": 90}],
            },
        )
        result = self._service(prior=prior).recommend_v3(
            tags=["blue eyes"], target="char:0", node_id="char_eyes",
            semantic_node={"node_id": "char_eyes", "seed_tags": ["blue eyes"]},
            semantic_state=_eyes_filled_state(), limit=20,
        )
        alternatives = result.get("alternatives", [])
        alt_tags = {i["tag"] for i in alternatives}
        add_tags = [i["tag"] for i in result["recommendations"]]
        self.assertIn("red eyes", alt_tags)
        self.assertIn("green eyes", alt_tags)
        # 相似替代项绝不进入默认 Next-Step 加法推荐列表
        self.assertNotIn("red eyes", add_tags)
        self.assertNotIn("green eyes", add_tags)
        # 非替代项（long hair 全局关联）仍正常推荐
        self.assertIn("long hair", add_tags)

    def test_eyes_filled_next_step_is_expression_pose(self):
        prior = _FakePrior(
            related=[],
            neighbors=[
                {"tag": "red eyes", "similarity": 0.92, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
                {"tag": "purple eyes", "similarity": 0.85, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
                {"tag": "aqua eyes", "similarity": 0.80, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
            ],
            slots={
                "char_expression": [{"tag": "smile", "frequency": 100}],
                "char_pose": [{"tag": "standing", "frequency": 90}],
            },
        )
        result = self._service(prior=prior).recommend_v3(
            tags=["blue eyes"], target="char:0", node_id="char_eyes",
            semantic_node={"node_id": "char_eyes", "seed_tags": ["blue eyes"]},
            semantic_state=_eyes_filled_state(), limit=10,
        )
        # Next Step 仍由 Expression / Pose（缺失槽位）决定，不被眼睛替代项挤占
        self.assertEqual([s["node_id"] for s in result["next_steps"]],
                         ["char_expression", "char_pose"])
        add_slots = {i.get("slot") for i in result["recommendations"]}
        self.assertIn("char_expression", add_slots)
        self.assertIn("char_pose", add_slots)
        for i in result["recommendations"]:
            self.assertNotIn(i["tag"], {"red eyes", "purple eyes", "aqua eyes"})

    def test_fake_sources_dict_no_network_and_labels(self):
        # 纯 fake sources dict（4.10），monkeypatch prior 为空，无网络/API。
        sources = {
            "semantic_alternative": [
                {"tag": "short ponytail", "similarity": 0.92,
                 "src_node": "char_hair", "dst_node": "char_hair"},
            ],
            "semantic_context": [
                {"tag": "smile", "slot": "char_expression"},
            ],
        }
        result = self._service(sources=sources).recommend_v3(
            tags=["ponytail"], target="char:0", node_id="char_hair",
            semantic_node={"node_id": "char_hair", "seed_tags": ["ponytail"]},
            semantic_state=_eyes_filled_state(),
        )
        alts = result.get("alternatives", [])
        self.assertTrue(alts)
        self.assertEqual(alts[0]["tag"], "short ponytail")
        # 人性化 reason，不暴露原始 source 字符串
        self.assertIn("相似替代", alts[0]["reason"])
        self.assertNotIn("semantic_alternative", alts[0]["reason"])
        self.assertNotIn("semantic_context", alts[0]["reason"])
        # 加法列表保留槽位候选，替代项不出现在加法列表
        self.assertIn("smile", [i["tag"] for i in result["recommendations"]])
        self.assertNotIn("short ponytail", [i["tag"] for i in result["recommendations"]])

    def test_reason_is_human_readable_no_raw_source(self):
        prior = _FakePrior(
            related=[],
            neighbors=[
                {"tag": "red eyes", "similarity": 0.92, "relation_type": "same_slot",
                 "src_node": "char_eyes", "dst_node": "char_eyes"},
            ],
            slots={"char_expression": [{"tag": "smile", "frequency": 100}]},
        )
        result = self._service(prior=prior).recommend_v3(
            tags=["blue eyes"], target="char:0", node_id="char_eyes",
            semantic_node={"node_id": "char_eyes", "seed_tags": ["blue eyes"]},
            semantic_state=_eyes_filled_state(),
        )
        for layer in ("recommendations", "alternatives"):
            for i in result.get(layer, []):
                reason = i["reason"].lower()
                self.assertNotIn("semantic_context", reason)
                self.assertNotIn("semantic_alternative", reason)
                self.assertNotIn("global_related", reason)
                self.assertNotIn("local_cooccurrence", reason)
        alt = result["alternatives"][0]
        self.assertIn("眼睛", alt["reason"])
        self.assertIn("相似替代", alt["reason"])


if __name__ == "__main__":
    unittest.main()
