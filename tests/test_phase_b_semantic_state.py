import unittest
from prompt.semantic_state import build_semantic_state, EMPTY, PARTIAL, FILLED, FILLED_BY_AUTO_PRESET, SATISFIED_BY_ALTERNATIVE

class TestSemanticState(unittest.TestCase):
    def _state(self, sections=None, characters=None, ctx=None):
        return {
            "schema_version": 2,
            "sections": sections or {},
            "characters": characters or [{"name":"C1","prompt_sections":{},"uc_sections":{}}],
            "assistant_context": ctx or {},
        }

    def test_empty_base_and_character(self):
        s = build_semantic_state(self._state())
        self.assertTrue(all(slot.status == EMPTY for slot in s.base_slots if slot.node_id != "quality"))
        ns = s.next_steps("base")
        self.assertTrue(any(slot.node_id == "base_subject_count" for slot in ns))
        cs = s.next_steps("char:0")
        self.assertTrue(any(slot.node_id == "char_identity" for slot in cs))

    def test_identity_only_partial(self):
        state = self._state(characters=[{"name":"C1","prompt_sections":{"character":[{"tag":"1girl"}]},"uc_sections":{}}])
        s = build_semantic_state(state)
        identity = [slot for slot in s.character_slots[0] if slot.node_id == "char_identity"][0]
        self.assertEqual(identity.status, PARTIAL)
        ns = s.next_steps("char:0")
        self.assertTrue(any(slot.node_id in ("char_hair","char_eyes") for slot in ns))

    def test_identity_hair_eyes_clothing_next_steps(self):
        state = self._state(characters=[{"name":"C1","prompt_sections":{
            "character":[{"tag":"Citlali"}],
            "appearance":[{"tag":"white hair"},{"tag":"blue eyes"}],
            "clothing":[{"tag":"white dress"}]
        },"uc_sections":{}}])
        s = build_semantic_state(state)
        slots = {slot.node_id: slot for slot in s.character_slots[0]}
        self.assertEqual(slots["char_identity"].status, FILLED)
        self.assertEqual(slots["char_hair"].status, FILLED)
        self.assertEqual(slots["char_eyes"].status, FILLED)
        self.assertEqual(slots["char_clothing"].status, FILLED)
        ns = s.next_steps("char:0")
        ns_ids = {slot.node_id for slot in ns}
        self.assertTrue(len(ns_ids & {"char_expression","char_pose","char_action"}) >= 2)

    def test_bedroom_night(self):
        state = self._state(sections={"scene":[{"tag":"bedroom"},{"tag":"night"}]})
        s = build_semantic_state(state)
        # At least one scene-related slot should be non-empty
        non_empty = [slot for slot in s.base_slots if slot.status != EMPTY and slot.node_id != "quality"]
        self.assertTrue(len(non_empty) > 0)

    def test_indoor_and_outdoor_are_alternative_environment_branches(self):
        state = self._state(sections={"scene": [{"tag": "bedroom"}]})
        s = build_semantic_state(state)
        slots = {slot.node_id: slot for slot in s.base_slots}
        self.assertEqual(slots["env_indoor"].status, FILLED)
        self.assertEqual(slots["env_outdoor"].status, SATISFIED_BY_ALTERNATIVE)
        self.assertNotIn("env_outdoor", {slot.node_id for slot in s.next_steps("base")})

    def test_quality_preset_on(self):
        s = build_semantic_state(self._state(), generation_config={"positiveTier":"standard"})
        quality = [slot for slot in s.base_slots if slot.node_id == "quality"][0]
        self.assertEqual(quality.status, FILLED_BY_AUTO_PRESET)

    def test_quality_preset_off(self):
        s = build_semantic_state(self._state(), generation_config={"positiveTier":"off"})
        quality = [slot for slot in s.base_slots if slot.node_id == "quality"][0]
        self.assertEqual(quality.status, EMPTY)

    def test_2person_scene(self):
        s = build_semantic_state(self._state(ctx={"participant_count":2}))
        participants = [slot for slot in s.scene_slots if slot.node_id == "scene_participants"][0]
        self.assertEqual(participants.status, FILLED)

    def test_3person_scene(self):
        s = build_semantic_state(self._state(ctx={"participant_count":3}))
        participants = [slot for slot in s.scene_slots if slot.node_id == "scene_participants"][0]
        self.assertEqual(participants.status, FILLED)

    def test_scene_stage_position(self):
        s = build_semantic_state(self._state(ctx={"stage":"FOREPLAY","position":"missionary","body_focus":"breasts"}))
        slots = {slot.node_id: slot for slot in s.scene_slots}
        self.assertEqual(slots["scene_stage"].status, FILLED)
        self.assertEqual(slots["scene_position"].status, FILLED)
        self.assertEqual(slots["scene_body_focus"].status, FILLED)

    def test_intent_derivation(self):
        s = build_semantic_state(self._state(), active_target="char:0", mode="general")
        self.assertEqual(s.intent["target"], "char:0")
        self.assertEqual(s.intent["mode"], "general")
        self.assertTrue(len(s.intent["description"]) > 0)

    def test_tag_to_node_mapping(self):
        from prompt.semantic_state import _resolve_semantic_node
        nid, src = _resolve_semantic_node("blue eyes")
        self.assertEqual(nid, "char_eyes")
        nid, _ = _resolve_semantic_node("smile")
        self.assertEqual(nid, "char_expression")
        nid, _ = _resolve_semantic_node("standing")
        self.assertEqual(nid, "char_pose")

    def test_graceful_without_conn(self):
        s = build_semantic_state(self._state(), conn=None)
        self.assertIsNotNone(s.summary)
        self.assertTrue(s.summary["total"] > 0)

if __name__ == "__main__":
    unittest.main()
