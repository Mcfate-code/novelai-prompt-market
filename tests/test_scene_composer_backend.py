"""Scene Composer 后端回归：/api/nsfw-builder/options 产品化 + RecommendRequest 新字段。

覆盖：
  - scenes 为高层小集合（≤6，key/label/tag），不再整面铺受限分类；
  - 每个返回的 option tag 都命中本地 sqlite（未命中即 drop，绝不发明）；
  - 青少年模式返回全空候选；
  - RecommendRequest 接受 additional_activities / clothing_state（pydantic 校验通过）。
"""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db


class SceneComposerBackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "sc.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": False},
        )
        self.settings_patch.start()

    def tearDown(self):
        self.settings_patch.stop()
        self.conn_patch.stop()
        self.tmp.cleanup()

    def conn(self):
        return db.get_conn(self.db_path)

    def insert_tags(self, tags):
        rows = [{"danbooru_name": t.replace(" ", "_"), "prompt_tag": t, "category": 0, "post_count": 100} for t in tags]
        conn = self.conn()
        db.upsert_tags(conn, rows)
        conn.close()

    def config_tags(self):
        cfg = app._scene_composer_config()
        tags = []
        for group in ("scenarios", "environments", "clothing_states", "activities", "body_focus"):
            for item in cfg.get(group, []):
                if isinstance(item, dict) and item.get("tag"):
                    tags.append(item["tag"])
        return tags

    def all_options(self):
        return app.nsfw_builder_options()

    def test_scenes_are_small_high_level_set(self):
        self.insert_tags(self.config_tags())
        options = self.all_options()
        scenarios = options["scenarios"]
        self.assertLessEqual(len(scenarios), 6, "环境/情境为高层小集合")
        for scenario in scenarios:
            self.assertIn("key", scenario)
            self.assertIn("label", scenario)
        # 语义 key（非 raw tag），且不是旧的受限分类 section label。
        config_keys = {s["key"] for s in app._scene_composer_config()["scenarios"]}
        self.assertEqual({s["key"] for s in scenarios}, config_keys)
        old_section_labels = {"基础性交", "多人成人场景", "女女性行为", "男男性行为", "性交体位", "裸露与脱衣状态"}
        scenario_keys = {s["key"] for s in scenarios}
        scenario_labels = {s["label"] for s in scenarios}
        self.assertTrue(scenario_keys.isdisjoint(old_section_labels), "scenario key 不应是旧受限分类 section label")
        self.assertTrue(scenario_labels.isdisjoint(old_section_labels), "scenario label 不应是旧受限分类 section label")

    def test_every_returned_tag_exists_in_sqlite(self):
        self.insert_tags(self.config_tags())
        # 只插入 nsfw_positions 的一个子集（含一个 3+ 场景无关的常规体位）。
        inserted_positions = ["missionary", "doggystyle", "cowgirl position"]
        self.insert_tags(inserted_positions)
        options = self.all_options()

        conn = self.conn()
        try:
            for group in ("scenarios", "environments", "positions", "clothingStates", "activities", "bodyFocus"):
                for item in options[group]:
                    tag = item.get("tag")
                    if tag:
                        self.assertTrue(
                            app._scene_tag_in_sqlite(conn, tag),
                            f"{group} 返回未校验 tag: {tag!r}",
                        )
        finally:
            conn.close()

        # positions 只包含已插入 sqlite 的体位；未命中即 drop。
        returned_positions = {p["key"] for p in options["positions"]}
        self.assertTrue(set(inserted_positions).issubset(returned_positions), "已插入 sqlite 的体位应保留")
        self.assertNotIn("full nelson", returned_positions, "未命中 sqlite 的体位应 drop")
        self.assertNotIn("mating press", returned_positions, "未命中 sqlite 的体位应 drop")

    def test_missing_configured_tag_is_dropped(self):
        # 只插入 config tags 的一个子集：省略 voyeurism（scenario）与 lingerie（clothing）。
        missing = {"voyeurism", "lingerie"}
        self.insert_tags([t for t in self.config_tags() if t not in missing])
        options = self.all_options()

        voyeurism_scenario = next(s for s in options["scenarios"] if s["key"] == "voyeurism")
        self.assertEqual(voyeurism_scenario["tag"], "", "未命中 sqlite 的 scenario tag 应 drop 为空")
        lingerie = next(c for c in options["clothingStates"] if c["key"] == "lingerie")
        self.assertEqual(lingerie["tag"], "", "未命中 sqlite 的 clothing tag 应 drop 为空")

        conn = self.conn()
        try:
            for group in ("scenarios", "environments", "positions", "clothingStates", "activities", "bodyFocus"):
                for item in options[group]:
                    if item.get("tag"):
                        self.assertTrue(app._scene_tag_in_sqlite(conn, item["tag"]))
        finally:
            conn.close()

    def test_adolescent_returns_all_empty(self):
        self.settings_patch.stop()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True},
        )
        self.settings_patch.start()
        options = self.all_options()
        for group in ("participants", "scenarios", "environments", "stages", "positions", "clothingStates", "activities", "bodyFocus"):
            self.assertEqual(options[group], [], f"{group} 青少年模式下应为空")

    def test_recommend_request_accepts_new_fields(self):
        req = app.RecommendRequest(
            tags=["1girl"],
            additional_activities=["kissing", "groping"],
            clothing_state={"0": "nude", "1": "clothed"},
        )
        self.assertEqual(req.additional_activities, ["kissing", "groping"])
        self.assertEqual(req.clothing_state, {"0": "nude", "1": "clothed"})
        # 缺省向后兼容
        legacy = app.RecommendRequest(tags=["1girl"])
        self.assertEqual(legacy.additional_activities, [])
        self.assertEqual(legacy.clothing_state, {})


if __name__ == "__main__":
    unittest.main()
