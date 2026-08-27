import json
import unittest
from pathlib import Path

from prompt.recommendation import RecommendationService
from prompt.semantic_state import PARTIAL, build_semantic_state


class PhaseESceneComposerTest(unittest.TestCase):
    def test_primary_act_is_separate_from_environment_and_additional_activity(self):
        state = {
            "schema_version": 2,
            "sections": {"scene": [{"tag": "bedroom"}], "action": [{"tag": "kissing"}]},
            "characters": [{"name": "Character 1", "prompt_sections": {}, "uc_sections": {}}],
            "assistant_context": {
                "participant_count": 1,
                "primary_act": "solo",
                "primary_scene_type": "bedroom",
                "additional_activities": ["kissing"],
                "composition": "close_up",
            },
        }
        scene = {slot.node_id: slot for slot in build_semantic_state(state).scene_slots}
        self.assertEqual(scene["scene_primary_act"].evidence_tags, ["solo"])
        self.assertEqual(scene["scene_environment"].evidence_tags[0], "bedroom")
        self.assertEqual(scene["scene_additional_activities"].evidence_tags, ["kissing"])
        self.assertEqual(scene["scene_composition"].evidence_tags, ["close_up"])

    def test_structured_context_reaches_v3_and_changes_primary_act_subset(self):
        contexts = []
        def source(context):
            contexts.append(context)
            return [{"tag": "candidate", "primary_act": context.primary_act}]
        source_map = {"adult_context": source}
        service = RecommendationService(sources=source_map)
        a = service.recommend_v3(tags=["seed"], mode="adult", primary_act="solo")
        b = service.recommend_v3(tags=["seed"], mode="adult", primary_act="vaginal_sex")
        self.assertEqual([item.primary_act for item in contexts], ["solo", "vaginal sex"])
        self.assertTrue(a["recommendations"] and b["recommendations"])
        self.assertTrue(any(item["tag"] == "candidate" for item in a["recommendations"]))

    def test_structural_count_without_verified_generic_tag_is_partial(self):
        state = {"schema_version": 2, "sections": {}, "characters": [
            {"name": "Character 1", "prompt_sections": {}, "uc_sections": {}},
            {"name": "Character 2", "prompt_sections": {}, "uc_sections": {}},
        ], "assistant_context": {"participant_count": 2}}
        participants = next(s for s in build_semantic_state(state).scene_slots if s.node_id == "scene_participants")
        self.assertEqual(participants.status, PARTIAL)
        self.assertIn("非性别", participants.reason)

    def test_config_has_explicit_phase_e_groups(self):
        config = json.loads((Path(__file__).parents[1] / "config" / "scene_composer.json").read_text())
        for key in ("primary_acts", "scenarios", "interaction_actions", "character_states", "compositions", "environments"):
            self.assertIsInstance(config[key], list)
        self.assertTrue(all(item.get("route") for item in config["primary_acts"]))


if __name__ == "__main__":
    unittest.main()
