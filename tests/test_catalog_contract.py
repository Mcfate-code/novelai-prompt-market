"""Stage 1 契约测试：公开 Tag DTO 必须统一为 tag / canonical / zh / category / post_count / favorite，
不得再泄漏内部字段 prompt_tag / tag_name / zh_name / danbooru_name。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import search
from importer import import_aliases, import_taxonomy


class CatalogTagContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "t.sqlite"
        db.init_db(self.db_path)
        conn = db.get_conn(self.db_path)
        import_taxonomy.import_taxonomy(conn)
        import_aliases.import_zh(conn)
        conn.close()

    def conn(self):
        return db.get_conn(self.db_path)

    def test_serialize_tag_dto_shape(self):
        conn = self.conn()
        try:
            row = conn.execute(
                "SELECT danbooru_name, prompt_tag, zh_name, category, post_count "
                "FROM tags LIMIT 1"
            ).fetchone()
            item = db.serialize_tag(row, favorite=True)
            self.assertTrue(item["tag"])
            self.assertTrue(item["canonical"])
            self.assertIn("zh", item)
            self.assertIn("category", item)
            self.assertIn("post_count", item)
            self.assertTrue(item["favorite"])
            # 内部字段不得泄漏
            self.assertNotIn("prompt_tag", item)
            self.assertNotIn("tag_name", item)
            self.assertNotIn("zh_name", item)
            self.assertNotIn("danbooru_name", item)
        finally:
            conn.close()

    def test_search_result_dto_has_favorite(self):
        conn = self.conn()
        try:
            results = search.search(conn, "蓝眼睛", limit=5)
            self.assertTrue(results)
            for item in results:
                self.assertIn("tag", item)
                self.assertIn("canonical", item)
                self.assertIn("favorite", item)
                self.assertNotIn("prompt_tag", item)
        finally:
            conn.close()

    def test_resolve_tag_dto_has_favorite(self):
        conn = self.conn()
        try:
            r = search.resolve_tag(conn, "蓝眼睛")
            self.assertIsNotNone(r)
            self.assertIn("favorite", r)
            self.assertIn("tag", r)
            self.assertIn("canonical", r)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
