"""Phase 2 deterministic Prompt Auto-Split proposal contract."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from prompt.auto_split import AMBIGUOUS_SUMMARY, auto_split, is_structured_prompt


METADATA = {
    "citlali (genshin impact)": {
        "canonical": "citlali_(genshin_impact)", "aliases": ["citlali (genshin impact)"], "category": 4,
    },
    "furina_(genshin_impact)": {
        "canonical": "furina_(genshin_impact)", "aliases": ["furina (genshin impact)"], "category": 4,
    },
    "jean (genshin impact)": {
        "canonical": "jean_(genshin_impact)", "aliases": ["jean (genshin impact)"], "category": 4,
    },
    "raiden shogun (genshin impact)": {
        "canonical": "raiden_shogun_(genshin_impact)", "aliases": ["raiden shogun (genshin impact)"], "category": 4,
    },
    "nahida (genshin impact)": {
        "canonical": "nahida_(genshin_impact)", "aliases": ["nahida (genshin impact)"], "category": 4,
    },
    "blue eyes": {"section": "appearance"},
    "red eyes": {"section": "appearance"},
    "green eyes": {"section": "appearance"},
    "long hair": {"section": "appearance"},
    "blonde hair": {"section": "appearance"},
    "purple hair": {"section": "appearance"},
    "white dress": {"section": "clothing"},
    "black dress": {"section": "clothing"},
    "smile": {"section": "expression"},
    "waving": {"section": "action"},
    "night": {"section": "scene"},
    "cafe": {"section": "scene"},
    "from above": {"section": "composition"},
    "masterpiece": {"section": "quality"},
}


def tags(entries):
    return [entry.get("tag") for entry in entries if "tag" in entry]


class AutoSplitTest(unittest.TestCase):
    def test_citlali_parentheses_is_metadata_backed_identity(self):
        result = auto_split("2girls, citlali (genshin impact), long hair", METADATA)
        self.assertEqual(tags(result["base"]), ["2girls"])
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "long hair"])

    def test_weighted_citlali_preserves_weight(self):
        result = auto_split("1.35::citlali (genshin impact)::, blue eyes", METADATA)
        identity = result["characters"][0]["prompt"][0]
        self.assertEqual(identity["tag"], "citlali (genshin impact)")
        self.assertEqual(identity["strength"], 1.35)

    def test_two_identities_open_left_to_right_characters(self):
        result = auto_split(
            "2girls, citlali (genshin impact), white dress, furina (genshin impact), black dress",
            METADATA,
        )
        self.assertEqual(tags(result["base"]), ["2girls"])
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "white dress"])
        self.assertEqual(tags(result["characters"][1]["prompt"]),
                         ["furina (genshin impact)", "black dress"])

    def test_global_scene_between_local_tags_stays_base(self):
        result = auto_split(
            "citlali (genshin impact), blue eyes, cafe, smile, night, waving", METADATA)
        self.assertEqual(tags(result["base"]), ["cafe", "night"])
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "blue eyes", "smile", "waving"])

    def test_same_blue_eyes_can_appear_in_two_character_targets(self):
        result = auto_split(
            "citlali (genshin impact), blue eyes, furina (genshin impact), blue eyes", METADATA)
        self.assertEqual(tags(result["characters"][0]["prompt"])[-1], "blue eyes")
        self.assertEqual(tags(result["characters"][1]["prompt"])[-1], "blue eyes")

    def test_relations_with_anchor_go_to_current_character(self):
        result = auto_split(
            "citlali (genshin impact), source#hug, target#pointing, mutual#holding hands", METADATA)
        prompt = result["characters"][0]["prompt"]
        self.assertEqual(tags(prompt)[1:], ["hug", "pointing", "holding hands"])
        self.assertEqual([e["relation"] for e in prompt[1:]], ["source", "target", "mutual"])
        self.assertEqual(result["base"], [])

    def test_relations_without_anchor_stay_in_base(self):
        result = auto_split(
            "source#hug, target#pointing, mutual#holding hands", METADATA)
        self.assertEqual(tags(result["base"]), ["hug", "pointing", "holding hands"])
        self.assertEqual([e["relation"] for e in result["base"]], ["source", "target", "mutual"])
        self.assertEqual(result["characters"], [])

    def test_explicit_structured_text_is_not_resplit(self):
        text = (
            "Base: 2girls, cafe\n"
            "Character 1: blue eyes\n"
            "Character 2: blue eyes\n"
            "Character 2 UC: hat\n"
            "Global UC: lowres"
        )
        result = auto_split(text, METADATA)
        self.assertFalse(result["resplit"])
        self.assertEqual(tags(result["base"]), ["2girls", "cafe"])
        self.assertEqual(tags(result["characters"][1]["uc"]), ["hat"])
        self.assertEqual(tags(result["global_uc"]), ["lowres"])

    def test_flat_prompt_and_natural_language_default_to_base(self):
        result = auto_split("masterpiece, 1girl\nShe stands beneath an umbrella.", METADATA)
        self.assertEqual(tags(result["base"]), ["masterpiece", "1girl"])
        self.assertEqual(result["base"][-1],
                         {"text": "She stands beneath an umbrella.", "kind": "free_text"})
        self.assertEqual(result["characters"], [])

    def test_schema_v2_structured_metadata_is_not_resplit(self):
        document = {
            "schema_version": 2,
            "sections": {"scene": [{"tag": "cafe", "weight": 1}]},
            "characters": [{"name": "Hero", "prompt_sections": {"appearance": [{"tag": "blue eyes"}]},
                            "uc_sections": {}, "position": {"x": 0.25, "y": 0.5}}],
            "global_uc_sections": {"quality": [{"tag": "lowres"}]},
        }
        self.assertTrue(is_structured_prompt(document))
        result = auto_split(document, METADATA)
        self.assertFalse(result["resplit"])
        self.assertEqual(result["characters"][0]["position"], {"x": 0.25, "y": 0.5})
        self.assertEqual(tags(result["characters"][0]["prompt"]), ["blue eyes"])

    def test_manual_assignment_contract_precedes_semantics(self):
        result = auto_split("cafe, blue eyes, blue eyes", METADATA,
                            manual_assignments={0: "char:0", 1: "char:0", 2: "char:1"})
        self.assertEqual(tags(result["characters"][0]["prompt"]), ["cafe", "blue eyes"])
        self.assertEqual(tags(result["characters"][1]["prompt"]), ["blue eyes"])

    def test_weight_brackets_and_order_are_preserved(self):
        result = auto_split(
            "{{masterpiece}}, 1.2::citlali (genshin impact)::, [[blue eyes]], 0.8::white dress::",
            METADATA,
        )
        self.assertEqual(result["base"][0]["brackets"], 2)
        local = result["characters"][0]["prompt"]
        self.assertEqual(tags(local), ["citlali (genshin impact)", "blue eyes", "white dress"])
        self.assertEqual([e["strength"] for e in local], [1.2, None, 0.8])
        self.assertEqual(local[1]["brackets"], -2)

    def test_ambiguous_multiple_subjects_do_not_create_characters(self):
        for text in ("2girls, blue eyes, cafe", "1girl, 1boy, from above"):
            with self.subTest(text=text):
                result = auto_split(text, METADATA)
                self.assertEqual(result["characters"], [])
                self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
                self.assertTrue(all(tag in tags(result["base"]) for tag in text.split(", ")))

    # ---- 新增真实用例：能确定才分，不能确定留 Base ----

    def test_two_identity_anchors_open_characters(self):
        result = auto_split(
            "citlali (genshin impact), long hair, furina (genshin impact), black dress", METADATA)
        self.assertEqual(result["base"], [])
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "long hair"])
        self.assertEqual(tags(result["characters"][1]["prompt"]),
                         ["furina (genshin impact)", "black dress"])

    def test_three_identity_anchors_open_characters(self):
        result = auto_split(
            "citlali (genshin impact), long hair, furina (genshin impact), blue eyes, "
            "jean (genshin impact), blonde hair",
            METADATA,
        )
        self.assertEqual(len(result["characters"]), 3)
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "long hair"])
        self.assertEqual(tags(result["characters"][1]["prompt"]),
                         ["furina (genshin impact)", "blue eyes"])
        self.assertEqual(tags(result["characters"][2]["prompt"]),
                         ["jean (genshin impact)", "blonde hair"])

    def test_four_identity_anchors_count_as_participants(self):
        result = auto_split(
            "citlali (genshin impact), long hair, furina (genshin impact), blue eyes, "
            "jean (genshin impact), blonde hair, raiden shogun (genshin impact), purple hair",
            METADATA,
        )
        self.assertEqual(len(result["characters"]), 4)
        self.assertEqual(result["assistant_context"]["participant_count"], 4)
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 4)

    def test_count_only_gender_sum_reports_actual(self):
        result = auto_split("1girl, 1boy, blue eyes", METADATA)
        self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 2)
        for tag in ("1girl", "1boy", "blue eyes"):
            self.assertIn(tag, tags(result["base"]))

    def test_gender_sum_plus_two_identities(self):
        result = auto_split(
            "1girl, 1boy, citlali (genshin impact), furina (genshin impact)", METADATA)
        self.assertEqual(len(result["characters"]), 2)
        self.assertEqual(result["assistant_context"]["participant_count"], 2)
        self.assertEqual(tags(result["base"]), ["1girl", "1boy"])

    def test_three_subjects_no_identity_ambiguous(self):
        result = auto_split("2girls, 1boy, blue eyes, red eyes", METADATA)
        self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 3)
        for tag in ("2girls", "1boy", "blue eyes", "red eyes"):
            self.assertIn(tag, tags(result["base"]))

    def test_global_scene_between_characters_stays_base(self):
        result = auto_split(
            "citlali (genshin impact), blue eyes, cafe, furina (genshin impact), black dress", METADATA)
        self.assertEqual(tags(result["base"]), ["cafe"])
        self.assertEqual(tags(result["characters"][0]["prompt"]),
                         ["citlali (genshin impact)", "blue eyes"])
        self.assertEqual(tags(result["characters"][1]["prompt"]),
                         ["furina (genshin impact)", "black dress"])

    def test_mutual_relation_goes_to_current_character(self):
        result = auto_split(
            "citlali (genshin impact), furina (genshin impact), mutual#holding hands", METADATA)
        char1 = result["characters"][1]["prompt"]
        self.assertEqual(tags(char1), ["furina (genshin impact)", "holding hands"])
        self.assertEqual(char1[-1]["relation"], "mutual")

    def test_weighted_comma_block_preserves_strength_and_owner(self):
        result = auto_split(
            "1.5::citlali (genshin impact)::, long hair, 0.8::furina (genshin impact)::", METADATA)
        char0 = result["characters"][0]["prompt"]
        char1 = result["characters"][1]["prompt"]
        self.assertEqual(tags(char0), ["citlali (genshin impact)", "long hair"])
        self.assertEqual([e["strength"] for e in char0], [1.5, None])
        self.assertEqual(tags(char1), ["furina (genshin impact)"])
        self.assertEqual(char1[0]["strength"], 0.8)

    def test_unknown_tags_with_one_girl_ambiguous(self):
        result = auto_split("zzz_unknown_tag, 1girl, another weird tag", METADATA)
        self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 1)
        for tag in ("zzz_unknown_tag", "1girl", "another weird tag"):
            self.assertIn(tag, tags(result["base"]))

    def test_aggregate_three_people_ambiguous(self):
        result = auto_split("3people", METADATA)
        self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 3)

    def test_identity_count_outranks_low_gender_count(self):
        result = auto_split(
            "1girl, citlali (genshin impact), furina (genshin impact), jean (genshin impact)", METADATA)
        self.assertEqual(len(result["characters"]), 3)
        self.assertEqual(result["assistant_context"]["participant_count"], 3)
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 3)

    def test_five_girls_caps_participant_count_at_four(self):
        result = auto_split("5girls", METADATA)
        self.assertEqual(result["summary"], AMBIGUOUS_SUMMARY)
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["assistant_context"]["participant_count"], 4)
        self.assertEqual(result["assistant_context"]["actual_participant_count"], 5)


if __name__ == "__main__":
    unittest.main()
