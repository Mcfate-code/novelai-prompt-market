"""Model overlay —— V4 不得用 V4.5-only 负数权重；V5 不得硬编码 6 角色上限。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from prompt import composer, novelai_export


class ModelOverlayTest(unittest.TestCase):
    def test_v5_has_no_character_cap(self):
        ov = composer.load_overlay("v5")
        self.assertIsNone(ov["supports"].get("max_characters"))

    def test_v5_many_characters_no_cap_warning(self):
        state = {"model": "v5", "characters": [{"name": f"C{i}", "prompt": ["girl"], "uc": [], "position": None} for i in range(10)]}
        out = novelai_export.export(state)
        self.assertFalse(any("角色" in w for w in out["warnings"]))

    def test_v4_5_keeps_six_cap_hint(self):
        ov = composer.load_overlay("v4.5")
        self.assertEqual(ov["supports"].get("max_characters"), 6)

    def test_v4_rejects_negative_weight(self):
        ov = composer.load_overlay("v4")
        self.assertFalse(ov["supports"].get("negative_weight"))
        state = {"model": "v4", "base_prompt": [{"tag": "hat", "strength": -1, "brackets": 0, "relation": None}]}
        out = novelai_export.export(state)
        self.assertTrue(any("负数权重" in w for w in out["warnings"]))

    def test_v5_allows_negative_weight(self):
        state = {"model": "v5", "base_prompt": [{"tag": "hat", "strength": -1, "brackets": 0, "relation": None}]}
        out = novelai_export.export(state)
        self.assertFalse(any("负数权重" in w for w in out["warnings"]))
        self.assertIn("-1::hat::", out["base"])

    def test_overlay_contains_v5_special_tags(self):
        tags = composer.overlay_tags()
        for t in ["depthness", "has alpha", "transparent background", "attractive male", "visual novel sprite"]:
            self.assertIn(t, tags)


if __name__ == "__main__":
    unittest.main()
