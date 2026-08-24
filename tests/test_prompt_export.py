"""Prompt export —— 权重闭合、逗号不损坏、Base/Character 顺序正确。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from prompt import novelai_export


class PromptExportTest(unittest.TestCase):
    def test_numeric_weight_syntax(self):
        state = {"model": "v5", "base_prompt": [{"tag": "red eyes", "strength": 1.4, "brackets": 0, "relation": None}]}
        out = novelai_export.export(state)
        self.assertIn("1.4::red eyes::", out["base"])

    def test_negative_weight_syntax(self):
        state = {"model": "v5", "base_prompt": [{"tag": "hat", "strength": -1, "brackets": 0, "relation": None}]}
        out = novelai_export.export(state)
        self.assertIn("-1::hat::", out["base"])

    def test_bracket_emphasis(self):
        # brackets = 层级数：1 -> {}，2 -> {{}}
        state = {"model": "v5", "base_prompt": [{"tag": "blue eyes", "strength": None, "brackets": 1, "relation": None}]}
        out = novelai_export.export(state)
        self.assertIn("{blue eyes}", out["base"])
        state2 = {"model": "v5", "base_prompt": [{"tag": "blue eyes", "strength": None, "brackets": 2, "relation": None}]}
        self.assertIn("{{blue eyes}}", novelai_export.export(state2)["base"])

    def test_weaken_brackets(self):
        state = {"model": "v5", "base_prompt": [{"tag": "simple background", "strength": None, "brackets": -1, "relation": None}]}
        out = novelai_export.export(state)
        self.assertIn("[simple background]", out["base"])
        state2 = {"model": "v5", "base_prompt": [{"tag": "simple background", "strength": None, "brackets": -2, "relation": None}]}
        self.assertIn("[[simple background]]", novelai_export.export(state2)["base"])

    def test_base_character_order(self):
        state = {
            "model": "v5",
            "base_prompt": ["2girls", "cafe"],
            "characters": [
                {"name": "Character 1", "prompt": ["girl", "blonde hair"], "uc": [], "position": None},
                {"name": "Character 2", "prompt": ["girl", "purple hair"], "uc": [], "position": None},
            ],
        }
        out = novelai_export.export(state)
        self.assertTrue(out["structured"].startswith("Base: 2girls, cafe"))
        self.assertIn("Character 1: girl, blonde hair", out["structured"])
        self.assertIn("Character 2: girl, purple hair", out["structured"])

    def test_relation_prefix(self):
        state = {"model": "v5", "characters": [{"name": "A", "prompt": [{"tag": "hug", "strength": None, "brackets": 0, "relation": "source"}], "uc": [], "position": None}]}
        out = novelai_export.export(state)
        self.assertIn("source#hug", out["structured"])

    def test_no_webui_syntax(self):
        state = {"model": "v5", "base_prompt": [{"tag": "red eyes", "strength": 1.2, "brackets": 0, "relation": None}]}
        out = novelai_export.export(state)
        self.assertNotIn("(red eyes:1.2)", out["base"])
        self.assertNotIn(":1.2)", out["base"])


if __name__ == "__main__":
    unittest.main()
