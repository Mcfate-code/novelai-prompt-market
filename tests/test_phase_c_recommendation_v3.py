import unittest
from types import SimpleNamespace
from unittest.mock import patch

from prompt.recommendation import RecommendationService


class PhaseCRecommendationV3Test(unittest.TestCase):
    def service(self, sources=None):
        return RecommendationService(sources=sources or {})

    def test_empty_base_has_three_guidance_layers(self):
        result = self.service().recommend_v3(target="base", structured_state={})
        self.assertTrue(result["next_steps"])
        self.assertEqual({"next_steps", "current_node", "contextual", "related", "groups", "recommendations", "count", "section"}, set(result))
        self.assertEqual([s["node_id"] for s in result["next_steps"][:3]], ["base_subject_count", "env_indoor", "env_outdoor"])

    def test_empty_character_has_identity_guidance(self):
        result = self.service().recommend_v3(target="char:0", structured_state={})
        self.assertEqual(result["next_steps"][0]["node_id"], "char_identity")

    def test_empty_state_without_prior_is_not_no_recommendations(self):
        result = self.service().recommend_v3(target="base", tags=[])
        self.assertTrue(result["next_steps"])
        self.assertEqual(result["recommendations"], [])

    def test_v3_uses_slot_metadata_for_candidates(self):
        result = self.service({"semantic_context": [
            {"tag": "one person", "slot": "base_subject_count"},
            {"tag": "portrait", "slot": "base_composition"},
        ]}).recommend_v3(target="base", tags=["seed"])
        self.assertEqual(result["recommendations"][0]["slot"], "base_subject_count")
        self.assertIn("补齐当前槽位", result["recommendations"][0]["reason"])

    def test_identity_only_character_next_steps_include_appearance(self):
        state = SimpleNamespace(next_steps=lambda target, limit: [
            SimpleNamespace(node_id="char_hair", label="Hair", zh="发型", status="empty", reason="尚未设置"),
            SimpleNamespace(node_id="char_eyes", label="Eyes", zh="眼睛", status="empty", reason="尚未设置"),
        ])
        result = self.service().recommend_v3(target="char:0", semantic_state=state)
        self.assertEqual([x["node_id"] for x in result["next_steps"]], ["char_hair", "char_eyes"])

    def test_complete_identity_prioritizes_expression_pose_action(self):
        state = SimpleNamespace(next_steps=lambda target, limit: [
            SimpleNamespace(node_id="char_expression", label="Expression", zh="表情", status="empty", reason="尚未设置"),
            SimpleNamespace(node_id="char_pose", label="Pose", zh="姿势", status="empty", reason="尚未设置"),
            SimpleNamespace(node_id="char_action", label="Action", zh="动作", status="empty", reason="尚未设置"),
        ])
        result = self.service({"semantic_context": [
            {"tag": "smile", "slot": "char_expression"},
            {"tag": "standing", "slot": "char_pose"},
            {"tag": "waving", "slot": "char_action"},
        ]}).recommend_v3(target="char:0", semantic_state=state)
        self.assertGreaterEqual(len(result["next_steps"]), 2)
        self.assertEqual([x["node_id"] for x in result["next_steps"][:3]], ["char_expression", "char_pose", "char_action"])

    def test_rrf_remains_part_of_v3_ranking(self):
        result = self.service({
            "global_related": ["shared", "global"],
            "local_cooccurrence": ["shared", "local"],
        }).recommend_v3(tags=["seed"], limit=4)
        self.assertEqual(result["recommendations"][0]["tag"], "shared")

    def test_personal_history_is_capped(self):
        result = self.service({
            "personal_recent": [{"tag": "personal", "use_count": 10000}],
            "global_related": ["global"],
        }).recommend_v3(tags=["seed"], limit=2)
        self.assertEqual({i["tag"] for i in result["recommendations"]}, {"personal", "global"})

    def test_human_reason_hides_internal_scores(self):
        result = self.service({"global_related": [{"tag": "candidate", "npmi": 9.2, "score": 8.1}]}).recommend_v3(tags=["seed"])
        reason = result["recommendations"][0]["reason"]
        self.assertTrue(reason)
        self.assertNotRegex(reason.lower(), r"rrf|npmi|score")

    def test_general_recommendation_has_runtime_safety_boundary(self):
        service = self.service({"global_related": [
            {"tag": "bedroom"},
            {"tag": "pantyshot", "is_adult": 0},
            {"tag": "onee shota", "is_adult": 0},
        ]})
        result = service.recommend_v3(tags=["blue eyes"], mode="general", limit=20)
        tags = {item["tag"] for item in result["recommendations"]}
        self.assertIn("bedroom", tags)
        self.assertNotIn("pantyshot", tags)
        self.assertNotIn("onee shota", tags)

    def test_adult_recommendation_keeps_adult_tags_but_blocks_minor_like(self):
        service = self.service({"global_related": [
            {"tag": "pantyshot", "is_adult": 1},
            {"tag": "onee shota", "is_adult": 1},
        ]})
        result = service.recommend_v3(tags=["bedroom"], mode="adult", limit=20)
        tags = {item["tag"] for item in result["recommendations"]}
        self.assertIn("pantyshot", tags)
        self.assertNotIn("onee shota", tags)

    def test_last_added_tag_intent_changes_subset(self):
        sources = {"global_related": [
            {"tag": "other", "slot": "base_composition"},
            {"tag": "related", "related_to": "new tag", "slot": "base_composition"},
        ]}
        a = self.service(sources).recommend_v3(tags=["seed"], last_added_tag="new tag", limit=1)
        b = self.service(sources).recommend_v3(tags=["seed"], last_added_tag="different", limit=1)
        self.assertNotEqual(a["recommendations"][0]["tag"], b["recommendations"][0]["tag"])

    def test_stage_changes_relevant_subset(self):
        sources = {"adult_context": [
            {"tag": "preparation tag", "stage": "preparation"},
            {"tag": "foreplay tag", "stage": "foreplay"},
        ]}
        a = self.service(sources).recommend_v3(tags=["seed"], mode="adult", stage="PREPARATION")
        b = self.service(sources).recommend_v3(tags=["seed"], mode="adult", stage="FOREPLAY")
        self.assertNotEqual([i["tag"] for i in a["recommendations"]], [i["tag"] for i in b["recommendations"]])

    def test_position_changes_relevant_subset(self):
        sources = {"adult_context": [{"tag": "standing", "position": "standing"}, {"tag": "kneeling", "position": "kneeling"}]}
        a = self.service(sources).recommend_v3(tags=["seed"], mode="adult", position="standing")
        b = self.service(sources).recommend_v3(tags=["seed"], mode="adult", position="kneeling")
        self.assertNotEqual(a["recommendations"][0]["tag"], b["recommendations"][0]["tag"])

    def test_body_focus_changes_relevant_subset(self):
        sources = {"adult_context": [{"tag": "face", "body_focus": "face"}, {"tag": "breasts", "body_focus": "breasts"}]}
        a = self.service(sources).recommend_v3(tags=["seed"], mode="adult", body_focus="face")
        b = self.service(sources).recommend_v3(tags=["seed"], mode="adult", body_focus="breasts")
        self.assertNotEqual(a["recommendations"][0]["tag"], b["recommendations"][0]["tag"])

    def test_participant_filter(self):
        result = self.service({"adult_context": [
            {"tag": "solo", "min_participants": 1, "max_participants": 1},
            {"tag": "group", "min_participants": 3},
        ]}).recommend_v3(tags=["seed"], mode="adult", participant_count=2)
        self.assertEqual(result["recommendations"], [])

    def test_additional_activity_and_clothing_are_contextual(self):
        result = self.service({"adult_context": [
            {"tag": "kissing", "activity": "kissing"},
            {"tag": "lingerie", "clothing_state": "lingerie"},
        ]}).recommend_v3(tags=["seed"], mode="adult", additional_activities=["kissing"], clothing_state={"state": "lingerie"})
        self.assertTrue(result["recommendations"])
        self.assertTrue(any(i["scene_context"] for i in result["recommendations"]))

    def test_general_mode_does_not_use_adult_source(self):
        result = self.service({"adult_context": [{"tag": "explicit", "nsfw": True}]}).recommend_v3(tags=["bedroom"], mode="general")
        self.assertEqual(result["recommendations"], [])

    def test_bedroom_general_can_use_non_character_context(self):
        result = self.service({"semantic_context": [
            {"tag": "bed", "slot": "env_indoor"},
            {"tag": "alice", "sections": ["character"]},
        ]}).recommend_v3(tags=["bedroom"], target="base")
        self.assertEqual(result["recommendations"][0]["tag"], "bed")
        self.assertNotIn("alice", [i["tag"] for i in result["recommendations"]])

    def test_slot_prior_rejects_stale_cross_slot_rows(self):
        class FakePrior:
            def related_tags(self, *args, **kwargs): return []
            def semantic_neighbors(self, *args, **kwargs): return []
            def context_candidates(self, *args, **kwargs): return []
            def next_slot_prior(self, *args, **kwargs): return []
            def slot_candidates(self, slot, **kwargs):
                return [{"tag": "male focus"}, {"tag": "portrait"}, {"tag": "legacy tail"}]
            def semantic_node_for_tag(self, tag):
                return {"male focus": "char_identity", "portrait": "base_composition"}.get(tag)

        state = SimpleNamespace(next_steps=lambda target, limit: [
            SimpleNamespace(node_id="base_composition", label="Composition", zh="构图", status="empty", reason="尚未设置"),
        ])
        with patch("prompt.prior.get_prior", return_value=FakePrior()):
            result = self.service().recommend_v3(tags=["bedroom"], target="base", semantic_state=state)
        tags = {item["tag"] for item in result["recommendations"]}
        self.assertIn("portrait", tags)
        self.assertNotIn("male focus", tags)
        self.assertNotIn("legacy tail", tags)

    def test_uc_never_produces_positive_recommendations(self):
        result = self.service({"global_related": ["candidate"]}).recommend_v3(tags=["seed"], target="global_uc")
        self.assertEqual(result["recommendations"], [])

    def test_target_filter_preserves_character_scope(self):
        result = self.service({"global_related": [
            {"tag": "char tag", "target": "character", "sections": ["character"]},
            {"tag": "base tag", "target": "base", "sections": ["scene"]},
        ]}).recommend_v3(tags=["seed"], target="character")
        self.assertEqual([i["tag"] for i in result["recommendations"]], ["char tag"])

    def test_contextual_and_related_layers_are_partitioned(self):
        result = self.service({"global_related": [
            {"tag": "context", "stage": "PREPARATION"}, {"tag": "related"},
        ]}).recommend_v3(tags=["seed"], mode="adult", stage="PREPARATION")
        self.assertIn("context", [i["tag"] for i in result["contextual"]])
        self.assertIn("related", [i["tag"] for i in result["related"]])

    def test_v2_contract_is_unchanged(self):
        result = self.service({"global_related": ["candidate"]}).recommend(tags=["seed"])
        self.assertEqual(set(result), {"groups", "recommendations"})


if __name__ == "__main__":
    unittest.main()
