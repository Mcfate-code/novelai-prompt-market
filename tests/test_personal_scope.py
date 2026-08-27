"""Phase 6：个人最近使用历史作用域隔离测试（spec 6.1–6.7）。

覆盖：
  1. 角色偏好（character scope）不污染 Base 推荐
  2. Base 环境历史不污染角色推荐（对称隔离）
  3. recent_tags_scoped 与 recent_tags 并存写入（写两边）
  4. personal_recent 源按 target 过滤作用域 + 作用域缺失时回退全局
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db
from prompt.recommendation import RecommendationContext, RecommendationService


class PersonalScopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "rec.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()

    def tearDown(self):
        self.conn_patch.stop()
        self.tmp.cleanup()

    def conn(self):
        return db.get_conn(self.db_path)

    def insert_tags(self, rows):
        conn = self.conn()
        db.upsert_tags(conn, rows)
        conn.close()

    def record(self, state):
        conn = self.conn()
        scoped = app._collect_scoped_positive_tags(state, conn)
        app._record_scoped_cooccurrence(conn, scoped, event_weight=1.0)
        conn.commit()
        conn.close()

    def personal_recent(self, target):
        conn = self.conn()
        try:
            service = RecommendationService(conn)
            ctx = RecommendationContext(tags=(), target=target)
            return {r["tag"] for r in service._source("personal_recent", ctx)}
        finally:
            conn.close()

    def test_character_pref_does_not_pollute_base(self):
        """记录 C1 white hair（角色）后，Base 推荐不得因角色偏好浮出 white hair。"""
        self.insert_tags([
            {"danbooru_name": "citlali", "prompt_tag": "citlali", "category": 4, "post_count": 1000},
            {"danbooru_name": "white_hair", "prompt_tag": "white hair", "category": 0, "post_count": 800},
            {"danbooru_name": "bedroom", "prompt_tag": "bedroom", "category": 0, "post_count": 600},
        ])
        self.record({
            "sections": {"scene": [{"tag": "bedroom"}]},
            "characters": [{"name": "C1", "prompt_sections": {
                "character": [{"tag": "citlali"}],
                "appearance": [{"tag": "white hair"}]}}],
        })
        base = self.personal_recent("base")
        self.assertIn("bedroom", base)
        self.assertNotIn("white hair", base)
        self.assertNotIn("citlali", base)

    def test_base_pref_does_not_pollute_character(self):
        """对称：base 环境历史不得污染角色推荐。"""
        self.insert_tags([
            {"danbooru_name": "citlali", "prompt_tag": "citlali", "category": 4, "post_count": 1000},
            {"danbooru_name": "white_hair", "prompt_tag": "white hair", "category": 0, "post_count": 800},
            {"danbooru_name": "bedroom", "prompt_tag": "bedroom", "category": 0, "post_count": 600},
        ])
        self.record({
            "sections": {"scene": [{"tag": "bedroom"}]},
            "characters": [{"name": "C1", "prompt_sections": {
                "character": [{"tag": "citlali"}],
                "appearance": [{"tag": "white hair"}]}}],
        })
        char = self.personal_recent("character")
        self.assertIn("white hair", char)
        self.assertIn("citlali", char)
        self.assertNotIn("bedroom", char)

    def test_scoped_and_legacy_tables_coexist(self):
        """学习写两边：recent_tags_scoped 与 recent_tags 都更新，旧表不删除。"""
        self.insert_tags([
            {"danbooru_name": "white_hair", "prompt_tag": "white hair", "category": 0, "post_count": 800},
            {"danbooru_name": "bedroom", "prompt_tag": "bedroom", "category": 0, "post_count": 600},
            {"danbooru_name": "anime", "prompt_tag": "anime", "category": 0, "post_count": 500},
        ])
        self.record({
            "sections": {"scene": [{"tag": "bedroom"}], "style": [{"tag": "anime"}]},
            "characters": [{"name": "C1", "prompt_sections": {
                "appearance": [{"tag": "white hair"}]}}],
        })
        conn = self.conn()
        try:
            legacy = {row["tag_name"] for row in conn.execute("SELECT tag_name FROM recent_tags")}
            scoped = {row["tag_name"] for row in conn.execute("SELECT tag_name FROM recent_tags_scoped")}
            scopes = {row["scope"] for row in conn.execute("SELECT DISTINCT scope FROM recent_tags_scoped")}
        finally:
            conn.close()
        self.assertEqual(legacy, {"bedroom", "white hair", "anime"})
        self.assertEqual(scoped, {"bedroom", "white hair", "anime"})
        self.assertTrue(scopes >= {"base", "scene", "character"})

    def test_personal_recent_falls_back_to_global(self):
        """作用域表为空时回退到全局 recent_tags（向后兼容，不崩溃）。"""
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO recent_tags (tag_name, last_used_at, use_count) VALUES ('legacy tag','2026-01-01T00:00:00Z',2)"
            )
            conn.commit()
        finally:
            conn.close()
        items = self.personal_recent("base")
        self.assertIn("legacy tag", items)


if __name__ == "__main__":
    unittest.main()
