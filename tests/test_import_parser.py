"""Prompt 导入解析器 —— 语法感知拆分与往返一致性。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from prompt import import_parser, novelai_export


class ImportParserTest(unittest.TestCase):
    def test_plain_tags_split(self):
        p = import_parser.parse("1girl, long hair, blue eyes, high complexity")
        self.assertEqual([e["tag"] for e in p["base"]], ["1girl", "long hair", "blue eyes", "high complexity"])

    def test_numeric_weight(self):
        p = import_parser.parse("1girl, 1.4::red eyes::")
        self.assertEqual(p["base"][1]["tag"], "red eyes")
        self.assertEqual(p["base"][1]["strength"], 1.4)

    def test_negative_weight(self):
        p = import_parser.parse("-1::hat::, 1girl")
        self.assertEqual(p["base"][0]["strength"], -1)
        self.assertEqual(p["base"][0]["tag"], "hat")

    def test_weight_wrapping_comma_not_split(self):
        # :: 包裹内的逗号不能被拆成两个 tag
        p = import_parser.parse("1.5::rain, night::, 1girl")
        self.assertEqual(p["base"][0]["tag"], "rain, night")
        self.assertEqual(p["base"][0]["strength"], 1.5)
        self.assertEqual(p["base"][1]["tag"], "1girl")

    def test_brackets(self):
        p = import_parser.parse("{{blue eyes}}, [[simple background]], 1girl")
        self.assertEqual(p["base"][0]["brackets"], 2)
        self.assertEqual(p["base"][0]["tag"], "blue eyes")
        self.assertEqual(p["base"][1]["brackets"], -2)
        self.assertEqual(p["base"][1]["tag"], "simple background")

    def test_relation_prefix(self):
        p = import_parser.parse("source#hug, target#pointing, 2girls")
        self.assertEqual(p["base"][0]["relation"], "source")
        self.assertEqual(p["base"][0]["tag"], "hug")
        self.assertEqual(p["base"][1]["relation"], "target")
        self.assertEqual(p["base"][1]["tag"], "pointing")

    def test_multi_character_segments(self):
        text = (
            "Base: 2girls, cafe, afternoon\n"
            "Character 1: girl, blonde hair, blue eyes, source#pointing at another\n"
            "Character 2: girl, purple hair, 1.4::red eyes::\n"
            "Character 2 UC: lowres\n"
            "Global UC: worst quality, bad quality"
        )
        p = import_parser.parse(text)
        self.assertEqual([e["tag"] for e in p["base"]], ["2girls", "cafe", "afternoon"])
        self.assertEqual(len(p["characters"]), 2)
        self.assertEqual([e["tag"] for e in p["characters"][0]["prompt"]], ["girl", "blonde hair", "blue eyes", "pointing at another"])
        self.assertEqual(p["characters"][0]["prompt"][3]["relation"], "source")
        self.assertEqual(p["characters"][1]["uc"], [{"tag": "lowres", "strength": None, "brackets": 0, "relation": None}])
        self.assertEqual([e["tag"] for e in p["global_uc"]], ["worst quality", "bad quality"])

    def test_free_text_detection(self):
        p = import_parser.parse("1girl, long hair\nShe is standing under a transparent umbrella.")
        self.assertEqual(p["free_text"], "She is standing under a transparent umbrella.")

    def test_roundtrip(self):
        """解析后重新导出，标签与权重应无损。"""
        text = "1girl, {{long hair}}, 1.4::red eyes::, source#hug, high complexity"
        p = import_parser.parse(text)
        state = {"model": "v5", "base_prompt": p["base"], "characters": [], "global_uc": [], "free_text": p["free_text"]}
        out = novelai_export.export(state)
        self.assertIn("1.4::red eyes::", out["base"])
        self.assertIn("{{long hair}}", out["base"])
        self.assertIn("source#hug", out["base"])

    def test_combined_weight_and_relation(self):
        p = import_parser.parse("source#1.5::hug::")
        self.assertEqual(p["base"][0]["relation"], "source")
        self.assertEqual(p["base"][0]["strength"], 1.5)
        self.assertEqual(p["base"][0]["tag"], "hug")


if __name__ == "__main__":
    unittest.main()
