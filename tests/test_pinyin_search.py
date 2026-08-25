"""拼音模糊搜索 —— 中文名/中文别名拼音命中英文 canonical。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import search
from importer import backfill_pinyin, pinyin_util


class PinyinSearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "pinyin.sqlite"
        db.init_db(self.db_path)
        conn = db.get_conn(self.db_path)
        # blue_eyes 有中文名「蓝眼」；orange_hat 纯英文无中文名；long_hair 有中文名「长发」
        db.upsert_tags(conn, [
            {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 500, "zh_name": "蓝眼"},
            {"danbooru_name": "orange_hat", "prompt_tag": "orange hat", "category": 0, "post_count": 1000},
            {"danbooru_name": "long_hair", "prompt_tag": "long hair", "category": 0, "post_count": 800, "zh_name": "长发"},
        ])
        # 中文别名（模拟真实数据：blue_eyes 有中文别名「蓝眼睛」，「蓝眼」前缀命中）
        conn.execute("INSERT INTO tag_aliases VALUES ('蓝眼睛', 'blue_eyes', 'zh', 'test')")
        conn.commit()
        conn.close()

    def conn(self):
        return db.get_conn(self.db_path)

    def test_compute_pinyin(self):
        full, initials = pinyin_util.compute_pinyin("蓝眼")
        self.assertEqual(full, "lan yan")
        self.assertEqual(initials, "ly")

    def test_schema_has_pinyin_columns(self):
        conn = self.conn()
        try:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(tags)")}
            self.assertTrue({"pinyin", "pinyin_initials"} <= cols)
        finally:
            conn.close()

    def test_backfill_fills_pinyin_and_skips_english(self):
        conn = self.conn()
        try:
            stats = backfill_pinyin.backfill(conn)
            self.assertEqual(stats["total"], 3)
            self.assertEqual(stats["generated"], 2)
            self.assertEqual(stats["skipped"], 1)
            row = conn.execute(
                "SELECT pinyin, pinyin_initials FROM tags WHERE danbooru_name='blue_eyes'"
            ).fetchone()
            self.assertEqual(row["pinyin"], "lan yan")
            self.assertEqual(row["pinyin_initials"], "ly")
            row = conn.execute(
                "SELECT pinyin, pinyin_initials FROM tags WHERE danbooru_name='orange_hat'"
            ).fetchone()
            self.assertIsNone(row["pinyin"])
            self.assertIsNone(row["pinyin_initials"])
        finally:
            conn.close()

    def test_backfill_uses_zh_alias_when_no_zh_name(self):
        conn = self.conn()
        try:
            conn.execute("INSERT INTO tag_aliases VALUES ('金发', 'blonde_hair', 'zh', 'test')")
            db.upsert_tags(conn, [{
                "danbooru_name": "blonde_hair", "prompt_tag": "blonde hair",
                "category": 0, "post_count": 50,
            }])
            backfill_pinyin.backfill(conn)
            row = conn.execute(
                "SELECT pinyin, pinyin_initials FROM tags WHERE danbooru_name='blonde_hair'"
            ).fetchone()
            self.assertEqual(row["pinyin"], "jin fa")
            self.assertEqual(row["pinyin_initials"], "jf")
        finally:
            conn.close()

    def test_pinyin_search_recalls_blue_eyes(self):
        conn = self.conn()
        backfill_pinyin.backfill(conn)
        try:
            for q in ("lanyan", "lan yan", "ly"):
                with self.subTest(q=q):
                    results = search.search(conn, q, limit=20)
                    self.assertIn("blue eyes", [r["tag"] for r in results])
        finally:
            conn.close()

    def test_english_and_zh_search_unaffected(self):
        conn = self.conn()
        backfill_pinyin.backfill(conn)
        try:
            results = search.search(conn, "blue", limit=20)
            self.assertIn("blue eyes", [r["tag"] for r in results])
            # 中文别名前缀解析仍然可用
            r = search.resolve_tag(conn, "蓝眼")
            self.assertIsNotNone(r)
            self.assertEqual(r["tag"], "blue eyes")
            self.assertEqual(r["canonical"], "blue_eyes")
        finally:
            conn.close()

    def test_english_tag_not_recalled_by_pinyin(self):
        conn = self.conn()
        backfill_pinyin.backfill(conn)
        try:
            results = search.search(conn, "ly", limit=50)
            # orange hat 无中文名，其英文名也不含 "ly"，不应被拼音召回
            self.assertNotIn("orange hat", [r["tag"] for r in results])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
