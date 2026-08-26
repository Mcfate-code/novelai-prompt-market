import unittest

from prompt.recommendation import RecommendationService, reciprocal_rank_fusion


class RecommendationV2Test(unittest.TestCase):
    def service(self, sources, **kwargs):
        return RecommendationService(sources=sources, **kwargs)

    def test_rrf_uses_rank_not_raw_count(self):
        scores = reciprocal_rank_fusion({"a": ["x", "y"], "b": ["y", "x"]}, k=0)
        self.assertAlmostEqual(scores["x"], 1.5)
        self.assertAlmostEqual(scores["y"], 1.5)

    def test_sources_are_independently_ranked_before_fusion(self):
        service = self.service({
            "global_related": ["global_first", "shared"],
            "local_cooccurrence": ["shared", "local_second"],
            "personal_recent": ["local_second", "shared"],
        })
        result = service.recommend(tags=["seed"], limit=3)["recommendations"]
        self.assertEqual(result[0]["tag"], "shared")
        self.assertEqual(set(result[0]["sources"]), {"global_related", "local_cooccurrence", "personal_recent"})

    def test_hard_filters_and_empty_input(self):
        service = self.service({"global_related": [
            {"tag": "chosen"}, {"tag": "hidden"}, {"tag": "minor", "minor_like": True},
            {"tag": "base_only", "sections": ["scene"]}, {"tag": "char_only", "sections": ["action"]},
        ]}, hidden_tags={"hidden"}, adolescent_mode=True)
        self.assertEqual(service.recommend(tags=[]), {"groups": [], "recommendations": []})
        tags = [item["tag"] for item in service.recommend(tags=["chosen"], target="base", mode="adult")["recommendations"]]
        self.assertEqual(tags, ["base only"])

    def test_node_context_and_personal_vs_global(self):
        service = self.service({
            "global_related": [{"tag": "popular", "rank": 1}],
            "personal_recent": [{"tag": "personal", "rank": 1}],
            "semantic_context": [{"tag": "node_seed", "rank": 1}],
        })
        result = service.recommend(tags=["seed"], node_id="bedroom", semantic_node={"seed_tags": ["node_seed"]})
        tags = [item["tag"] for item in result["recommendations"]]
        self.assertEqual(set(tags), {"personal", "node seed", "popular"})

    def test_adult_stage_participant_target_and_groups(self):
        service = self.service({"adult_context": [
            {"tag": "prep", "stage": "PREPARATION", "min_participants": 1, "max_participants": 2, "group": "当前阶段"},
            {"tag": "next", "stage": "FOREPLAY", "min_participants": 2, "group": "下一阶段"},
            {"tag": "wrong_count", "stage": "PREPARATION", "min_participants": 3},
            {"tag": "wrong_target", "target": "character", "sections": ["action"]},
        ]})
        result = service.recommend(tags=["seed"], mode="adult", participant_count=2,
                                   stage="PREPARATION", target="base")
        tags = [item["tag"] for item in result["recommendations"]]
        self.assertEqual(tags, ["prep", "next"])
        self.assertEqual({item["group"] for item in result["recommendations"]}, {"当前阶段", "下一阶段"})

    def test_remote_failure_falls_back_to_local(self):
        def broken(_):
            raise TimeoutError("remote unavailable")
        service = self.service({"global_related": broken, "local_cooccurrence": ["local"]})
        self.assertEqual(service.recommend(tags=["seed"])["recommendations"][0]["tag"], "local")

    def test_uc_is_not_a_positive_learning_input(self):
        service = self.service({"local_cooccurrence": ["candidate"]})
        self.assertEqual(service.recommend(tags=["seed"], target="global_uc")["recommendations"], [])


if __name__ == "__main__":
    unittest.main()
