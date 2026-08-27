"""Tag Recommendation（V2 RRF 融合）+ 语义导航 + 共现记录审计 后端测试。

覆盖：空 Prompt、单/多 tag 共现、个人偏好、排除已选、node 上下文、
Base/Character 目标过滤、adolescent/adult gating、推荐上下文（mode/participant/stage）、
snapshot/generation 共现记录审计。
"""
import asyncio
import base64
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
            {"id": "base_style", "label": "Style", "zh": "风格", "target": "base", "section": "style",
             "nsfw": False, "seed_tags": ["masterpiece"], "children": []},
            {"id": "base_env", "label": "Environment", "zh": "环境", "target": "base", "section": "scene",
             "nsfw": False, "seed_tags": ["bedroom"], "children": [
                {"id": "env_bedroom", "label": "Indoor", "zh": "室内", "target": "base", "section": "scene",
                 "nsfw": False, "seed_tags": ["bed", "pillow", "lamp"], "children": []},
                {"id": "env_nsfw", "label": "Restricted", "zh": "受限", "target": "base", "section": "other",
                 "nsfw": True, "seed_tags": [], "children": []},
            ]},
        ],
    },
    "character": {
        "id": "character", "label": "Character", "zh": "角色", "target": "character", "section": "character",
        "nsfw": False, "seed_tags": [], "children": [
            {"id": "char_appearance", "label": "Appearance", "zh": "外观", "target": "character", "section": "appearance",
             "nsfw": False, "seed_tags": ["long hair", "blue eyes"], "children": [
                {"id": "char_face", "label": "Face", "zh": "面部", "target": "character", "section": "appearance",
                 "nsfw": False, "seed_tags": ["scar", "glasses", "freckles", "eyebrows"], "children": []},
            ]},
            {"id": "char_pose", "label": "Pose", "zh": "姿势", "target": "character", "section": "action",
             "nsfw": False, "seed_tags": ["standing"], "children": []},
        ],
    },
}


class RecommendationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "rec.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True},
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

    def recommend(self, tags, limit=20, target="", node_id="", **ctx):
        return app.recommendations(app.RecommendRequest(tags=tags, limit=limit, target=target, node_id=node_id, **ctx))

    def seed_tags(self):
        return {
            "bed": {"danbooru_name": "bed", "prompt_tag": "bed", "category": 0, "post_count": 1000, "zh_name": "床"},
            "pillow": {"danbooru_name": "pillow", "prompt_tag": "pillow", "category": 0, "post_count": 100, "zh_name": "枕头"},
            "lamp": {"danbooru_name": "lamp", "prompt_tag": "lamp", "category": 0, "post_count": 10, "zh_name": "灯"},
            "night": {"danbooru_name": "night", "prompt_tag": "night", "category": 0, "post_count": 999, "zh_name": "夜晚"},
            "standing": {"danbooru_name": "standing", "prompt_tag": "standing", "category": 0, "post_count": 500, "zh_name": "站立"},
            "long hair": {"danbooru_name": "long_hair", "prompt_tag": "long hair", "category": 0, "post_count": 900, "zh_name": "长发"},
            "blue eyes": {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 800, "zh_name": "蓝眼睛"},
            "smile": {"danbooru_name": "smile", "prompt_tag": "smile", "category": 0, "post_count": 700, "zh_name": "微笑"},
            "scar": {"danbooru_name": "scar", "prompt_tag": "scar", "category": 0, "post_count": 600, "zh_name": "伤疤"},
        }

    def test_empty_prompt_returns_empty(self):
        self.assertEqual(self.recommend([]), {"groups": [], "recommendations": []})
        self.assertEqual(self.recommend([], target="base", node_id="env_bedroom"), {"groups": [], "recommendations": []})

    def test_single_tag_cooccurrence_v2_shape(self):
        self.insert_tags([self.seed_tags()[name] for name in ("blue eyes", "long hair")])
        app.cooccurrence_record(app.TagsRequest(tags=["blue eyes", "long hair"]))
        result = self.recommend(["blue eyes"])
        self.assertEqual(set(result), {"groups", "recommendations"})
        self.assertTrue(result["recommendations"])
        item = result["recommendations"][0]
        self.assertEqual(item["tag"], "long hair")
        self.assertEqual(item["canonical"], "long_hair")
        self.assertEqual(item["zh"], "长发")
        self.assertIn(item["section"], {"appearance", "other"})
        self.assertEqual(item["post_count"], 900)
        self.assertIn("local_cooccurrence", item["sources"])
        self.assertIn("local_cooccurrence", item["source"])
        self.assertTrue(item["reason"])

    def test_excludes_selected_tags(self):
        self.insert_tags([self.seed_tags()[name] for name in ("blue eyes", "long hair", "smile")])
        app.cooccurrence_record(app.TagsRequest(tags=["blue eyes", "long hair", "smile"]))
        tags = [r["tag"] for r in self.recommend(["blue eyes", "long hair"])["recommendations"]]
        self.assertNotIn("blue eyes", tags)
        self.assertNotIn("long hair", tags)

    def test_node_context_bedroom_prefers_seed_objects(self):
        self.insert_tags([self.seed_tags()[name] for name in ("bed", "pillow", "lamp", "night")])
        app.cooccurrence_record(app.TagsRequest(tags=["bedroom", "night"]))
        result = self.recommend(["bedroom"], node_id="env_bedroom", limit=10)
        tags = [r["tag"] for r in result["recommendations"]]
        for seed in ("bed", "pillow", "lamp"):
            self.assertIn(seed, tags)
            item = next(r for r in result["recommendations"] if r["tag"] == seed)
            self.assertIn("semantic_context", item["sources"])

    def test_node_context_inherits_ancestor_seeds(self):
        self.insert_tags([self.seed_tags()[name] for name in ("blue eyes", "long hair", "scar", "standing")])
        result = self.recommend(["blue eyes"], node_id="char_face", limit=10)
        tags = {r["tag"]: r for r in result["recommendations"]}
        self.assertIn("long hair", tags)
        self.assertEqual(tags["long hair"]["sources"], ["semantic_context"])
        self.assertIn("scar", tags)

    def test_base_character_target_filter(self):
        self.insert_tags([self.seed_tags()[name] for name in ("blue eyes", "night", "standing", "smile")])
        app.cooccurrence_record(app.TagsRequest(tags=["blue eyes", "night", "standing"]))
        char_tags = [r["tag"] for r in self.recommend(["blue eyes"], target="character")["recommendations"]]
        self.assertIn("standing", char_tags)
        self.assertNotIn("night", char_tags)
        base_tags = [r["tag"] for r in self.recommend(["blue eyes"], target="base")["recommendations"]]
        self.assertIn("night", base_tags)
        self.assertNotIn("standing", base_tags)

    def test_adolescent_mode_hides_nsfw_node_and_hidden_tags(self):
        self.insert_tags([self.seed_tags()[name] for name in ("bed", "pillow", "lamp")])
        conn = self.conn()
        conn.execute(
            "INSERT INTO restricted_taxonomy_map (section_id, section_label, seed, status, canonical_name, sort_order) "
            "VALUES ('sec_test', 'Test', 'lamp', 'verified', NULL, 0)"
        )
        conn.commit()
        conn.close()
        tree = app.catalog_semantic_tree()["tree"]
        self.assertIn("base", tree)
        self.assertNotIn("env_nsfw", json.dumps(tree, ensure_ascii=False))
        with self.assertRaises(app.HTTPException) as ctx:
            app.catalog_semantic_tree(node_id="env_nsfw")
        self.assertEqual(ctx.exception.status_code, 404)
        result = self.recommend(["bedroom"], node_id="env_bedroom")
        tags = [r["tag"] for r in result["recommendations"]]
        self.assertIn("bed", tags)
        self.assertIn("pillow", tags)
        self.assertNotIn("lamp", tags)
        with self.assertRaises(app.HTTPException) as ctx:
            self.recommend(["bedroom"], node_id="env_nsfw")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_recommend_context_and_adult_gating(self):
        """mode/participant_count/stage 上下文：人数过滤 + 成人幼态过滤 + 阶段分组。"""
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
        result = self.recommend(["seed"], mode="nsfw", participant_count=2, stage="PREPARATION", target="base", limit=20)
        tags = [r["tag"] for r in result["recommendations"]]
        self.assertIn("prep", tags)
        self.assertIn("next", tags)
        self.assertNotIn("wrong_count", tags)
        self.assertNotIn("minor_tag", tags)
        groups = {g["group"] for g in result["groups"]}
        self.assertIn("当前阶段", groups)
        self.assertIn("下一阶段", groups)

    def test_tree_api_contract(self):
        full = app.catalog_semantic_tree()
        self.assertEqual(set(full["tree"]), {"base", "character"})
        self.assertEqual(full["tree"]["base"]["id"], "base")
        self.assertIn("env_bedroom", json.dumps(full["tree"], ensure_ascii=False))
        node = app.catalog_semantic_tree(node_id="env_bedroom")["node"]
        self.assertEqual(node["id"], "env_bedroom")
        self.assertEqual(node["seed_tags"], ["bed", "pillow", "lamp"])
        self.assertEqual(node["target"], "base")
        self.assertEqual(node["section"], "scene")
        via_catalog = app.catalog_tree(semantic=True)
        self.assertEqual(via_catalog["tree"]["base"]["id"], "base")
        legacy = app.catalog_tree()
        self.assertIn("groups", legacy)
        with self.assertRaises(app.HTTPException) as ctx:
            app.catalog_semantic_tree(node_id="not_a_node")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_snapshot_does_not_trigger_learning(self):
        """Phase A：snapshot（含手动保存）不再触发任何学习。"""
        app.snapshot_create(app.SnapshotBody(structured_state={
            "sections": {"style": [{"tag": "anime"}]},
            "characters": [{
                "name": "A",
                "prompt_sections": {"appearance": [{"tag": "blue eyes"}]},
                "uc_sections": {"appearance": [{"tag": "bad hands"}]},
            }],
            "global_uc_sections": {"quality": [{"tag": "lowres"}]},
            "free_text": "typing keyboard",
            "assistant_context": {"participant_count": 2, "stage": "MAIN_ACT"},
        }))
        conn = self.conn()
        usage = conn.execute("SELECT COUNT(*) FROM recent_tags").fetchone()[0]
        scoped = conn.execute("SELECT COUNT(*) FROM tag_cooccurrence_scoped").fetchone()[0]
        legacy = conn.execute("SELECT COUNT(*) FROM tag_cooccurrence").fetchone()[0]
        conn.close()
        self.assertEqual(usage, 0)
        self.assertEqual(scoped, 0)
        self.assertEqual(legacy, 0)

    def test_snapshot_repeat_does_not_trigger_learning(self):
        body = app.SnapshotBody(structured_state={
            "sections": {"style": [{"tag": "anime"}, {"tag": "bedroom"}]},
            "characters": [{"name": "A", "prompt_sections": {"appearance": [{"tag": "anime"}]}}],
        })
        app.snapshot_create(body)
        app.snapshot_create(body)
        conn = self.conn()
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM tag_cooccurrence_scoped").fetchone()[0], 0
        )
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM recent_tags").fetchone()[0], 0)
        conn.close()

    def test_gallery_generation_writes_scoped_cooccurrence_once(self):
        snapshot = app.snapshot_create(app.SnapshotBody(structured_state={
            "sections": {"style": [{"tag": "anime"}, {"tag": "bedroom"}]},
        }))
        gallery_dir = Path(self.tmp.name) / "gallery"
        gallery_dir.mkdir()
        tiny_png = base64.b64encode(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
            b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
        ).decode()
        body = app.GalleryItemBody(
            image_base64=tiny_png, prompt="anime", snapshot_id=snapshot["id"],
        )
        with (
            patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()),
            patch.object(app, "GALLERY_DIR", gallery_dir),
            patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"),
        ):
            created = asyncio.run(app.gallery_item(body))
        self.assertTrue(created["ok"])
        conn = self.conn()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0], 1)
        rows = conn.execute(
            "SELECT scope, tag_a, tag_b, positive_weight, negative_weight FROM tag_cooccurrence_scoped"
        ).fetchall()
        events = conn.execute(
            "SELECT event_type FROM gallery_events WHERE event_type='successful_generate'"
        ).fetchall()
        conn.close()
        # 单次成功生成 → 恰好一个 base 作用域配对，正权重 1.0，不重复记录。
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["scope"], "base")
        self.assertEqual({rows[0]["tag_a"], rows[0]["tag_b"]}, {"anime", "bedroom"})
        self.assertEqual(rows[0]["positive_weight"], 1.0)
        self.assertEqual(rows[0]["negative_weight"], 0.0)
        self.assertEqual(len(events), 1)


if __name__ == "__main__":
    unittest.main()
