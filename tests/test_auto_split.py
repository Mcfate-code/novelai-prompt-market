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
    "blue eyes": {"section": "appearance"},
    "red eyes": {"section": "appearance"},
    "long hair": {"section": "appearance"},
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

    def test_relations_are_preserved_without_guessing_interaction_owner(self):
        result = auto_split(
            "citlali (genshin impact), source#hug, target#pointing, mutual#holding hands", METADATA)
        self.assertEqual(tags(result["base"]), ["hug", "pointing", "holding hands"])
        self.assertEqual([e["relation"] for e in result["base"]], ["source", "target", "mutual"])

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


if __name__ == "__main__":
    unittest.main()
