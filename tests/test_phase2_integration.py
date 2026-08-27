"""Phase 2 集成回归（后端）：Auto-Split API、Recommendation V2 上下文、Scene Builder 候选、snapshot 上下文。

覆盖（integration cases）：auto split、weighted、recommend context、adult context、
snapshot context、continue generate no display literals（assistant_context 不泄漏）。
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db

NAV = {
    "schema_version": 1,
    "base": {
        "id": "base", "label": "Base", "zh": "基础画面", "target": "base", "section": "scene",
        "nsfw": False, "seed_tags": [], "children": [
            {"id": "base_env", "label": "Environment", "zh": "环境", "target": "base", "section": "scene",
             "nsfw": False, "seed_tags": ["bedroom"], "children": [
                {"id": "env_bedroom", "label": "Indoor", "zh": "室内", "target": "base", "section": "scene",
                 "nsfw": False, "seed_tags": ["bed", "pillow", "lamp"], "children": []},
            ]},
        ],
    },
    "character": {
        "id": "character", "label": "Character", "zh": "角色", "target": "character", "section": "character",
        "nsfw": False, "seed_tags": [], "children": [],
    },
}


class Phase2IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "p2.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": False},
        )
        self.settings_patch.start()
        nav_path = Path(self.tmp.name) / "prompt_navigation.json"
        nav_path.write_text(json.dumps(NAV, ensure_ascii=False), encoding="utf-8")
        self.nav_patch = patch.object(app, "PROMPT_NAVIGATION_PATH", nav_path)
        self.nav_patch.start()
        self.related_patch = patch.object(app, "_related_source", return_value=None)
        self.related_patch.start()

    def tearDown(self):
        self.related_patch.stop()
        self.nav_patch.stop()
        self.settings_patch.stop()
        self.conn_patch.stop()
        self.tmp.cleanup()

    def conn(self):
        return db.get_conn(self.db_path)

    def insert_tags(self, rows):
        conn = self.conn()
        db.upsert_tags(conn, rows)
        conn.close()

    # ---- Auto-Split API（auto split + weighted） ----

    def test_auto_split_endpoint_flat_prompt(self):
        self.insert_tags([
            {"danbooru_name": "citlali_(genshin_impact)", "prompt_tag": "citlali (genshin impact)", "category": 4, "post_count": 1000},
            {"danbooru_name": "long_hair", "prompt_tag": "long hair", "category": 0, "post_count": 900},
            {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 800},
        ])
        r = app.prompt_auto_split(app.AutoSplitRequest(text="2girls, citlali (genshin impact), long hair, blue eyes"))
        proposal = r["proposal"]
        self.assertTrue(r["resplit"])
        self.assertEqual([e["tag"] for e in proposal["base"]], ["2girls"])
        self.assertEqual([e["tag"] for e in proposal["characters"][0]["prompt"]],
                         ["citlali (genshin impact)", "long hair", "blue eyes"])
        self.assertEqual(proposal["assistant_context"]["participant_count"], 2)

    def test_auto_split_endpoint_weighted_preserves_strength(self):
        self.insert_tags([
            {"danbooru_name": "citlali_(genshin_impact)", "prompt_tag": "citlali (genshin impact)", "category": 4, "post_count": 1000},
            {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 800},
        ])
        r = app.prompt_auto_split(app.AutoSplitRequest(text="1.35::citlali (genshin impact)::, blue eyes"))
        prompt = r["proposal"]["characters"][0]["prompt"]
        self.assertEqual(prompt[0]["tag"], "citlali (genshin impact)")
        self.assertEqual(prompt[0]["strength"], 1.35)

    def test_auto_split_endpoint_structured_not_resplit(self):
        document = {
            "schema_version": 2,
            "sections": {"scene": [{"tag": "cafe", "weight": 1}]},
            "characters": [{"name": "Hero", "prompt_sections": {"appearance": [{"tag": "blue eyes"}]},
                            "uc_sections": {}, "position": None}],
            "global_uc_sections": {},
        }
        r = app.prompt_auto_split(app.AutoSplitRequest(prompt=document))
        self.assertFalse(r["resplit"])
        self.assertTrue(r["structured"])

    # ---- Recommendation V2 上下文（recommend context + adult context） ----

    def test_recommend_context_grouped_and_adult_gating(self):
        def fake_related(ctx):
            return [
                {"tag": "prep", "stage": "PREPARATION", "min_participants": 1, "max_participants": 2, "group": "当前阶段"},
                {"tag": "next", "stage": "FOREPLAY", "min_participants": 2, "group": "下一阶段"},
                {"tag": "wrong_count", "stage": "PREPARATION", "min_participants": 3},
                {"tag": "minor_tag", "minor_like": True},
            ]
        self.related_patch.stop()
        self.related_patch = patch.object(app, "_related_source", return_value=fake_related)
        self.related_patch.start()
        result = app.recommendations(app.RecommendRequest(
            tags=["seed"], mode="nsfw", participant_count=2, stage="PREPARATION",
            primary_scene_type="indoor", position="missionary", body_focus="face",
            target="base", limit=20,
        ))
        self.assertEqual(set(result), {"groups", "recommendations"})
        tags = [r["tag"] for r in result["recommendations"]]
        self.assertIn("prep", tags)
        self.assertIn("next", tags)
        self.assertNotIn("wrong_count", tags)
        self.assertNotIn("minor_tag", tags)
        groups = {g["group"] for g in result["groups"]}
        self.assertIn("当前阶段", groups)

    def test_adolescent_returns_empty_scene_builder_options(self):
        self.settings_patch.stop()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True},
        )
        self.settings_patch.start()
        options = app.nsfw_builder_options()
        for group in ("scenarios", "positions", "clothingStates", "activities", "bodyFocus"):
            self.assertEqual(options[group], [])

    # ---- snapshot 上下文（snapshot context + continue generate no display literals） ----

    def test_snapshot_assistant_context_roundtrip(self):
        state = {
            "sections": {"style": [{"tag": "anime"}]},
            "characters": [{"name": "A", "prompt_sections": {"appearance": [{"tag": "blue eyes"}]}, "uc_sections": {}}],
            "global_uc_sections": {},
            "assistant_context": {"participant_count": 2, "stage": "MAIN_ACT", "clothing_state": {"0": "nude"}},
        }
        created = app.snapshot_create(app.SnapshotBody(structured_state=state))
        restored = app.snapshot_get(created["id"])["structured_state"]
        self.assertEqual(restored["assistant_context"], state["assistant_context"])
        # 分区分片 restore 也不丢 assistant_context（metadata 随文档整体保留）。
        restored_sections = app.snapshot_restore(created["id"], "style")["structured_state"]
        self.assertEqual(restored_sections["assistant_context"], state["assistant_context"])

    def test_assistant_context_does_not_leak_into_learning(self):
        app.snapshot_create(app.SnapshotBody(structured_state={
            "sections": {},
            "characters": [{"name": "A", "prompt_sections": {}, "uc_sections": {}}],
            "global_uc_sections": {},
            "assistant_context": {"participant_count": 2, "stage": "MAIN_ACT", "primary_scene_type": "bedroom"},
        }))
        conn = self.conn()
        count = conn.execute("SELECT COUNT(*) FROM recent_tags").fetchone()[0]
        conn.close()
        self.assertEqual(count, 0, "assistant_context 是 metadata，绝不作为正面共现样本写入学习表")


if __name__ == "__main__":
    unittest.main()
