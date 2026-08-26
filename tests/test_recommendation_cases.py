"""Deterministic Recommendation V2 contract/evaluation cases (no ML benchmark)."""
import json
import unittest
from pathlib import Path

from prompt.recommendation import RecommendationService


FIXTURE = Path(__file__).parent / "fixtures" / "recommendation_cases.json"


class RecommendationCasesTest(unittest.TestCase):
    def test_fixture_shape_and_deterministic_gates(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 20)
        for case in cases:
            with self.subTest(case=case["name"]):
                expected = case.get("expected_top5", [])
                forbidden = set(case.get("forbidden", []))
                if not case["tags"]:
                    result = RecommendationService().recommend(tags=[], target=case.get("target", ""))
                    self.assertEqual(result["recommendations"], [])
                    continue
                source = case.get("candidates") or [{"tag": tag} for tag in expected]
                result = RecommendationService(sources={"global_related": source}).recommend(
                    tags=case["tags"], target=case.get("target", ""), mode=case.get("mode", "general"),
                    participant_count=case.get("participant_count"), primary_scene_type=case.get("primary_scene_type", ""),
                    stage=case.get("stage", ""), position=case.get("position", ""), body_focus=case.get("body_focus", ""),
                    active_target=case.get("active_target", ""), limit=case.get("limit", 20),
                )
                actual = [item["tag"] for item in result["recommendations"]]
                self.assertEqual(len(actual), len(set(actual)), "top-N must not contain duplicates")
                self.assertTrue(set(actual).isdisjoint(forbidden), "wrong-target/conflict/noise tag leaked")
                normalize = lambda value: str(value).replace("_", " ").lower()
                self.assertTrue({normalize(x) for x in expected}.issubset({normalize(x) for x in actual[:10]}))


if __name__ == "__main__":
    unittest.main()
